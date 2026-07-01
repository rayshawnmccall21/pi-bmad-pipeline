import { describe, expect, it } from "vitest";

import { HeadlessJsonlParser, parseHeadlessJsonl } from "./index.js";

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
    const parser = new HeadlessJsonlParser();

    parser.push('{"ok"');
    const snapshot = parser.push(":true}\n");

    expect(snapshot.records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("handles multiple lines in one chunk", () => {
    const parser = new HeadlessJsonlParser();

    const snapshot = parser.push('{"a":1}\n{"b":2}\n');

    expect(snapshot.records).toHaveLength(2);
  });

  it("handles Uint8Array chunks", () => {
    expect(parse(bytes('{"ok":true}\n')).output).toEqual({ ok: true });
  });

  it("preserves UTF-8 multibyte characters split across chunks", () => {
    const parser = new HeadlessJsonlParser();
    const encoded = bytes('{"emoji":"🙂"}\n');

    parser.push(encoded.slice(0, 13));
    const snapshot = parser.push(encoded.slice(13));

    expect(snapshot.output).toEqual({ emoji: "🙂" });
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
    const parser = new HeadlessJsonlParser();

    parser.push('{"ok":true}\n{"pending"');
    const snapshot = parser.snapshot();

    expect(snapshot.complete).toBe(false);
    expect(snapshot.records).toEqual([{ line: 1, value: { ok: true } }]);
  });

  it("finish is idempotent", () => {
    const parser = new HeadlessJsonlParser();

    parser.push('{"ok":true}');
    const first = parser.finish();
    const second = parser.finish();

    expect(second).toEqual(first);
  });

  it("throws when pushing after finish", () => {
    const parser = new HeadlessJsonlParser();

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
    const parser = new HeadlessJsonlParser();

    parser.push(input.slice(0, 5));
    parser.push(input.slice(5));

    expect(parseHeadlessJsonl(input)).toEqual(parser.finish());
  });
});
