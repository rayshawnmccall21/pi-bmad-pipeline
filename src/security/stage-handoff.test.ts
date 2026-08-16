import { describe, expect, it } from "vitest";

import { REDACTION_PLACEHOLDER } from "./redaction.js";
import {
  MAX_STAGE_HANDOFF_BYTES,
  createStageHandoff,
  sanitizeStageHandoff,
} from "./stage-handoff.js";

const fakeBearer = "Bearer abcdefghijklmnopqrstuvwxyz123456";
const fakeOpenAiKey = "sk-abcdefghijklmnopqrstuvwx";

const serializedWithStringBytes = (bytes: number, character = "a"): string => {
  const overhead = Buffer.byteLength('{"value":""}', "utf8");
  return JSON.stringify({
    value: character.repeat((bytes - overhead) / Buffer.byteLength(character)),
  });
};

describe("stage handoff", () => {
  it("deep-redacts object and array string leaves before compact serialization", () => {
    const handoff = createStageHandoff({
      safe: "kept",
      nested: { authorization: fakeBearer },
      values: [fakeOpenAiKey, { token: fakeBearer }],
    });

    expect(handoff).toBe(
      JSON.stringify({
        safe: "kept",
        nested: { authorization: REDACTION_PLACEHOLDER },
        values: [REDACTION_PLACEHOLDER, { token: REDACTION_PLACEHOLDER }],
      }),
    );
    expect(handoff).not.toContain(fakeBearer);
    expect(handoff).not.toContain(fakeOpenAiKey);
  });

  it("does not mutate its input while redacting", () => {
    const input = {
      nested: { token: fakeBearer },
      values: [fakeOpenAiKey, "safe"],
    };
    const before = structuredClone(input);

    createStageHandoff(input);

    expect(input).toEqual(before);
  });

  it("compact-serializes once with deterministic property and array order", () => {
    const input = { z: 1, a: [true, null, { b: "two" }] };

    const first = createStageHandoff(input);
    const second = createStageHandoff(input);

    expect(first).toBe('{"z":1,"a":[true,null,{"b":"two"}]}');
    expect(second).toBe(first);
    expect(first).not.toMatch(/\n|\r|\t/gu);
  });

  it("preserves every own JSON key through redaction and compact serialization in order", () => {
    const input = JSON.parse(
      '{"before":1,"__proto__":{"token":"Bearer fake-token-1234567890","location":"src/example.ts:42"},"after":true}',
    ) as unknown;

    const handoff = createStageHandoff(input);

    expect(handoff).toBe(
      '{"before":1,"__proto__":{"token":"[REDACTED]","location":"src/example.ts:42"},"after":true}',
    );
  });

  it("accepts final compact JSON at exactly 32 KiB UTF-8", () => {
    const serialized = serializedWithStringBytes(MAX_STAGE_HANDOFF_BYTES);

    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_STAGE_HANDOFF_BYTES);
    expect(createStageHandoff(JSON.parse(serialized))).toBe(serialized);
  });

  it("rejects the whole handoff when final compact JSON is one byte over", () => {
    const serialized = serializedWithStringBytes(MAX_STAGE_HANDOFF_BYTES + 1);

    expect(Buffer.byteLength(serialized, "utf8")).toBe(MAX_STAGE_HANDOFF_BYTES + 1);
    expect(createStageHandoff(JSON.parse(serialized))).toBeUndefined();
  });

  it("counts Unicode UTF-8 bytes rather than JavaScript string length", () => {
    const overhead = Buffer.byteLength('{"value":""}', "utf8");
    const exactEmojiCount = (MAX_STAGE_HANDOFF_BYTES - overhead) / 4;
    const exact = { value: "😀".repeat(exactEmojiCount) };
    const over = { value: `${exact.value}😀` };

    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(MAX_STAGE_HANDOFF_BYTES);
    expect(createStageHandoff(exact)).toBe(JSON.stringify(exact));
    expect(Buffer.byteLength(JSON.stringify(over), "utf8")).toBe(MAX_STAGE_HANDOFF_BYTES + 4);
    expect(createStageHandoff(over)).toBeUndefined();
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["symbol", Symbol("unsupported")],
    ["function", () => "unsupported"],
    ["undefined object member", { value: undefined }],
    ["undefined array member", [undefined]],
    ["non-plain object", new Date("2026-01-01T00:00:00.000Z")],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["nested non-finite number", { value: Number.NaN }],
  ])("rejects unsupported JSON input: %s", (_name, input) => {
    expect(createStageHandoff(input)).toBeUndefined();
  });

  it("rejects cyclic input without throwing or mutating it", () => {
    const cyclic: { readonly safe: string; self?: unknown } = { safe: "kept" };
    cyclic.self = cyclic;

    expect(() => createStageHandoff(cyclic)).not.toThrow();
    expect(createStageHandoff(cyclic)).toBeUndefined();
    expect(cyclic.self).toBe(cyclic);
  });

  it("preserves an already normalized safe serialized value exactly", () => {
    const serialized = '{"z":1,"a":["safe",true]}';

    expect(sanitizeStageHandoff(serialized)).toBe(serialized);
  });

  it("defensively parses, redacts, and recompacts a tampered serialized value", () => {
    const tampered = JSON.stringify({ nested: { token: fakeBearer }, safe: "kept" }, null, 2);
    const sanitized = sanitizeStageHandoff(tampered);

    expect(sanitized).toBe('{"nested":{"token":"[REDACTED]"},"safe":"kept"}');
    expect(sanitized).not.toContain(fakeBearer);
  });

  it.each([
    ["malformed JSON", '{"value":'],
    ["unsupported top-level serialized value", "undefined"],
    ["serialized non-finite value", '{"value":1e999}'],
  ])("defensively rejects %s", (_name, serialized) => {
    expect(() => sanitizeStageHandoff(serialized)).not.toThrow();
    expect(sanitizeStageHandoff(serialized)).toBeUndefined();
  });

  it("defensively rejects an oversized tampered serialized value whole", () => {
    const oversized = serializedWithStringBytes(MAX_STAGE_HANDOFF_BYTES + 1);

    expect(sanitizeStageHandoff(oversized)).toBeUndefined();
  });
});
