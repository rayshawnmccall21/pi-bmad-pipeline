import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { buildEmissionProvenance } from "pi-bmad";
import { describe, expect, it } from "vitest";

import { extractGatedHeadlessOutput, extractStageUsage } from "./headless-stream-output.js";
import { resolvePiBmadExtensionPath } from "./pi-bmad-extension.js";

import type { HeadlessJsonlRecord } from "./headless-jsonl-parser.js";

const piBmadRootDir = resolve(dirname(resolvePiBmadExtensionPath()), "..");

const loadFixtureEnvelope = (): Record<string, unknown> => {
  const line = readFileSync(
    join(piBmadRootDir, "contracts", "fixtures", "dev-story", "success.jsonl"),
    "utf8",
  ).trim();
  const parsed = JSON.parse(line) as {
    result: { details: { headlessOutput: Record<string, unknown> } };
  };
  return parsed.result.details.headlessOutput;
};

const stampedEnvelope = (
  emissionKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => {
  const envelope = { ...loadFixtureEnvelope(), ...overrides };
  return { ...envelope, emissionProvenance: buildEmissionProvenance(emissionKey, envelope) };
};

const record = (line: number, value: unknown): HeadlessJsonlRecord => ({ line, value });

const toolEndRecord = (line: number, headlessOutput: unknown): HeadlessJsonlRecord =>
  record(line, {
    type: "tool_execution_end",
    toolCallId: `call-${String(line)}`,
    toolName: "bmad_emit_result",
    isError: false,
    result: { details: { headlessOutput } },
  });

const messageEndRecord = (line: number, message: unknown): HeadlessJsonlRecord =>
  record(line, { type: "message_end", message });

const assistantMessage = (totalTokens: unknown, total: unknown): Record<string, unknown> => ({
  role: "assistant",
  usage: { totalTokens, cost: { total } },
});

const gateContext = { emissionKey: "key-1", rootDir: piBmadRootDir };

describe("extract gated headless output", () => {
  it("accepts a stamped envelope from a tool_execution_end record", () => {
    const envelope = stampedEnvelope("key-1");

    const extraction = extractGatedHeadlessOutput([toolEndRecord(1, envelope)], gateContext);

    expect(extraction.output).toEqual(envelope);
    expect(extraction).not.toHaveProperty("failure");
  });

  it("prefers the last verified envelope when several are present", () => {
    const firstStamped = stampedEnvelope("key-1");
    const secondStamped = stampedEnvelope("key-1", { emittedAt: "2026-06-11T00:00:00.000Z" });

    const extraction = extractGatedHeadlessOutput(
      [toolEndRecord(1, firstStamped), toolEndRecord(2, secondStamped)],
      gateContext,
    );

    expect(extraction.output).toEqual(secondStamped);
  });

  it("ignores a trailing forged envelope when an earlier one verifies", () => {
    const verified = stampedEnvelope("key-1");

    const extraction = extractGatedHeadlessOutput(
      [toolEndRecord(1, verified), toolEndRecord(2, loadFixtureEnvelope())],
      gateContext,
    );

    expect(extraction.output).toEqual(verified);
  });

  it("fails closed when no tool_execution_end record carries a headless output", () => {
    const extraction = extractGatedHeadlessOutput(
      [
        record(1, "not-a-record"),
        record(2, { type: "message_end" }),
        record(3, { type: "tool_execution_end", result: "not-a-record" }),
        record(4, { type: "tool_execution_end", result: { details: "not-a-record" } }),
        record(5, { type: "tool_execution_end", result: { details: {} } }),
        record(6, loadFixtureEnvelope()),
      ],
      gateContext,
    );

    expect(extraction.output).toBeNull();
    expect(extraction.failure).toMatch(/No headless terminal output/u);
  });

  it("rejects an unstamped forged envelope at the provenance gate", () => {
    const extraction = extractGatedHeadlessOutput(
      [toolEndRecord(1, loadFixtureEnvelope())],
      gateContext,
    );

    expect(extraction.output).toBeNull();
    expect(extraction.failure).toMatch(/provenance/u);
  });

  it("rejects an envelope stamped with a different emission key", () => {
    const extraction = extractGatedHeadlessOutput(
      [toolEndRecord(1, stampedEnvelope("other-key"))],
      gateContext,
    );

    expect(extraction.output).toBeNull();
    expect(extraction.failure).toMatch(/provenance/u);
  });

  it("rejects a structurally invalid envelope at the structure gate", () => {
    const extraction = extractGatedHeadlessOutput(
      [toolEndRecord(1, { workflow: "dev-story" })],
      gateContext,
    );

    expect(extraction.output).toBeNull();
    expect(extraction.failure).toMatch(/structure/u);
  });
});

describe("extract stage usage", () => {
  it("aggregates assistant usage across message_end records", () => {
    const usage = extractStageUsage([
      messageEndRecord(1, assistantMessage(10, 0.25)),
      messageEndRecord(2, assistantMessage(5, 0.5)),
    ]);

    expect(usage).toEqual({ tokens: 15, dollars: 0.75 });
  });

  it("ignores records that are not assistant message_end usage", () => {
    const usage = extractStageUsage([
      record(1, "not-a-record"),
      record(2, { type: "tool_execution_end" }),
      messageEndRecord(3, "not-a-record"),
      messageEndRecord(4, { role: "user", usage: { totalTokens: 3, cost: { total: 1 } } }),
      messageEndRecord(5, { role: "assistant", usage: "not-a-record" }),
      messageEndRecord(6, { role: "assistant", usage: { totalTokens: 3, cost: "not-a-record" } }),
      messageEndRecord(7, assistantMessage(-1, 0.5)),
      messageEndRecord(8, assistantMessage(3, Number.NaN)),
    ]);

    expect(usage).toBeUndefined();
  });

  it("returns undefined for an empty stream", () => {
    expect(extractStageUsage([])).toBeUndefined();
  });
});
