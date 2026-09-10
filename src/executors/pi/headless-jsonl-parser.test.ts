import { describe, expect, it } from "vitest";

import {
  MAX_HEADLESS_JSONL_ENTRIES,
  MAX_HEADLESS_JSONL_LINE_BYTES,
  MAX_HEADLESS_STDOUT_BYTES,
  createHeadlessJsonlParser,
  parseHeadlessJsonl,
} from "./index.js";

const parse = (input: string | Uint8Array) => parseHeadlessJsonl(input);
const bytes = (input: string): Uint8Array => new TextEncoder().encode(input);

describe("headless JSONL parser", () => {
  it("parses a single JSON object line", () => {
    expect(parse('{"ok":true}\n').records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("parses multiple JSONL lines", () => {
    expect(parse('{"a":1}\n{"b":2}\n').records).toEqual([
      { line: 1, value: { a: 1 } },
      { line: 2, value: { b: 2 } },
    ]);
  });

  it("uses the last parsed record as output", () => {
    expect(parse('{"a":1}\n{"b":2}\n').output).toEqual({ b: 2 });
  });

  it("ignores blank lines", () => {
    expect(parse('\n  \n{"ok":true}\n').records).toEqual([{ line: 3, value: { ok: true } }]);
  });

  it("handles CRLF input", () => {
    expect(parse('{"ok":true}\r\n').records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("handles a line split across chunks", () => {
    const parser = createHeadlessJsonlParser();

    parser.push('{"ok"');
    const snapshot = parser.push(":true}\n");

    expect(snapshot.records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("handles multiple lines in one chunk", () => {
    const parser = createHeadlessJsonlParser();

    const snapshot = parser.push('{"a":1}\n{"b":2}\n');

    expect(snapshot.records).toHaveLength(2);
  });

  it("handles Uint8Array chunks", () => {
    expect(parse(bytes('{"ok":true}\n')).output).toEqual({ ok: true });
  });

  it("preserves UTF-8 multibyte characters split across chunks", () => {
    const parser = createHeadlessJsonlParser();
    const encoded = bytes('{"emoji":"🙂"}\n');

    parser.push(encoded.slice(0, 13));
    const snapshot = parser.push(encoded.slice(13));

    expect(snapshot.output).toEqual({ emoji: "🙂" });
  });

  it("fails terminally and deterministically on invalid UTF-8 without throwing", () => {
    const parser = createHeadlessJsonlParser();

    expect(() => parser.push(Uint8Array.of(0xc3, 0x28))).not.toThrow();
    expect(parser.snapshot().fatalError).toBe("Invalid UTF-8 in child stdout.");
  });

  it("detects truncated UTF-8 when finishing", () => {
    const parser = createHeadlessJsonlParser();

    parser.push(Uint8Array.of(0xf0, 0x9f));

    expect(parser.finish().fatalError).toBe("Invalid UTF-8 in child stdout.");
  });

  it("fails terminally when total stdout exceeds 16 MiB", () => {
    expect(MAX_HEADLESS_STDOUT_BYTES).toBe(16 * 1024 * 1024);

    const snapshot = parse(new Uint8Array(MAX_HEADLESS_STDOUT_BYTES + 1));

    expect(snapshot.fatalError).toBe(
      `Child stdout exceeded ${String(MAX_HEADLESS_STDOUT_BYTES)} bytes.`,
    );
  });

  it("fails terminally when a pending line exceeds 1 MiB", () => {
    const parser = createHeadlessJsonlParser();

    parser.push("x".repeat(MAX_HEADLESS_JSONL_LINE_BYTES));
    const snapshot = parser.push("x");

    expect(snapshot.fatalError).toBe(
      `JSONL line exceeded ${String(MAX_HEADLESS_JSONL_LINE_BYTES)} bytes.`,
    );
  });

  it("fails terminally after 10,000 retained records and issues", () => {
    const input = `${"{}\n".repeat(MAX_HEADLESS_JSONL_ENTRIES)}{bad}\n`;
    const snapshot = parse(input);

    expect(snapshot.records).toHaveLength(MAX_HEADLESS_JSONL_ENTRIES);
    expect(snapshot.issues).toHaveLength(0);
    expect(snapshot.fatalError).toBe(
      `JSONL record and issue count exceeded ${String(MAX_HEADLESS_JSONL_ENTRIES)}.`,
    );
  });

  it("drops update traffic while retaining terminal and other records", () => {
    const retained = [
      { type: "session", id: "session-1" },
      { type: "message_end", message: { role: "assistant" } },
      { type: "tool_execution_end", result: { ok: true } },
      { type: "agent_end" },
      { type: "settled" },
      { type: "retry", attempt: 2 },
      { type: "other" },
    ];
    const input = [
      retained[0],
      { type: "message_update", delta: "progress" },
      retained[1],
      { type: "tool_execution_update", partialResult: "progress" },
      ...retained.slice(2),
    ]
      .map((value) => JSON.stringify(value))
      .join("\n");

    expect(parse(`${input}\n`).records.map((record) => record.value)).toEqual(retained);
  });

  it("keeps repeated update traffic outside the retained entry limit", () => {
    const updates = `${'{"type":"message_update"}\n'.repeat(
      MAX_HEADLESS_JSONL_ENTRIES + 1,
    )}{"type":"session"}\n`;
    const snapshot = parse(updates);

    expect(snapshot.fatalError).toBeUndefined();
    expect(snapshot.records).toEqual([
      { line: MAX_HEADLESS_JSONL_ENTRIES + 2, value: { type: "session" } },
    ]);
    expect(snapshot.issues).toEqual([]);
  });

  it("does not retain or allocate snapshots for later chunks after a terminal failure", () => {
    const parser = createHeadlessJsonlParser();
    const failed = parser.push(Uint8Array.of(0xff));

    expect(parser.snapshot()).toBe(failed);
    expect(parser.push(bytes(`${"{}\n".repeat(100)}${"x".repeat(100_000)}`))).toBe(failed);
    expect(parser.push("ignored again")).toBe(failed);
  });

  it("records invalid JSON as an issue and continues", () => {
    const snapshot = parse('{bad}\n{"ok":true}\n');

    expect(snapshot.records).toEqual([{ line: 2, value: { ok: true } }]);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]?.line).toBe(1);
    expect(snapshot.issues[0]?.text).toBe("{bad}");
  });

  it("parses the final unterminated buffered line on finish", () => {
    expect(parse('{"ok":true}').records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("returns output null when no valid records exist", () => {
    expect(parse("{bad}\n").output).toBeNull();
  });

  it("snapshot reflects current parsed state before finish", () => {
    const parser = createHeadlessJsonlParser();

    parser.push('{"ok":true}\n{"pending"');
    const snapshot = parser.snapshot();

    expect(snapshot.complete).toBe(false);
    expect(snapshot.records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("finish is idempotent", () => {
    const parser = createHeadlessJsonlParser();

    parser.push('{"ok":true}');
    const first = parser.finish();
    const second = parser.finish();

    expect(second).toEqual(first);
  });

  it("throws when pushing after finish", () => {
    const parser = createHeadlessJsonlParser();

    parser.finish();

    expect(() => parser.push("{}\n")).toThrow(RangeError);
  });

  it("freezes snapshots, arrays, records, and issues", () => {
    const snapshot = parse('{bad}\n{"ok":true}\n');

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(Object.isFrozen(snapshot.issues)).toBe(true);
    expect(Object.isFrozen(snapshot.issues[0])).toBe(true);
  });

  it("parseHeadlessJsonl matches incremental parse for complete input", () => {
    const input = '{"a":1}\n{"b":2}\n';
    const parser = createHeadlessJsonlParser();

    parser.push(input.slice(0, 5));
    parser.push(input.slice(5));

    expect(parseHeadlessJsonl(input)).toEqual(parser.finish());
  });
});
