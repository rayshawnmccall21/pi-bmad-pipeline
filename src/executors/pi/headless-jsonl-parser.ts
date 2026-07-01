/** One parsed JSONL record. */
export interface HeadlessJsonlRecord {
  /** One-based source line number. */
  readonly line: number;

  /** Parsed JSON value. */
  readonly value: unknown;
}

/** One JSONL parse issue. */
export interface HeadlessJsonlParseIssue {
  /** One-based source line number. */
  readonly line: number;

  /** Parse failure message. */
  readonly message: string;

  /** Original line text. */
  readonly text: string;
}

/** Immutable view of parser records, issues, output, and completion state. */
export interface HeadlessJsonlParserSnapshot {
  /** Parsed JSONL records. */
  readonly records: readonly HeadlessJsonlRecord[];

  /** Non-fatal parse issues. */
  readonly issues: readonly HeadlessJsonlParseIssue[];

  /** Last successfully parsed record value, or null. */
  readonly output: unknown;

  /** True after finish has been called. */
  readonly complete: boolean;
}

/** Incremental UTF-8 JSONL parser for child stdout. */
export class HeadlessJsonlParser {
  private readonly decoder = new TextDecoder("utf-8");

  private readonly records: HeadlessJsonlRecord[] = [];

  private readonly issues: HeadlessJsonlParseIssue[] = [];

  private buffer = "";

  private line = 1;

  private complete = false;

  /**
   * Pushes one text or byte chunk into the parser.
   *
   * @param chunk - String or UTF-8 bytes to append.
   *
   * @returns Frozen parser snapshot after processing complete lines.
   *
   * @throws RangeError When called after finish.
   *
   * @example
   * ```ts
   * parser.push('{"ok":true}\n');
   * ```
   */
  public push(chunk: string | Uint8Array): HeadlessJsonlParserSnapshot {
    if (this.complete) {
      throw new RangeError("Cannot push after parser is finished.");
    }
    this.buffer += decodeChunk(this.decoder, chunk, false);
    this.consumeCompleteLines();
    return this.snapshot();
  }

  /**
   * Finishes parsing, including a final unterminated line.
   *
   * @returns Frozen final parser snapshot.
   *
   * @example
   * ```ts
   * const final = parser.finish();
   * ```
   */
  public finish(): HeadlessJsonlParserSnapshot {
    if (!this.complete) {
      this.buffer += this.decoder.decode();
      this.consumeFinalLine();
      this.complete = true;
    }
    return this.snapshot();
  }

  /**
   * Returns the current parser snapshot.
   *
   * @returns Frozen parser snapshot.
   *
   * @example
   * ```ts
   * const current = parser.snapshot();
   * ```
   */
  public snapshot(): HeadlessJsonlParserSnapshot {
    return freezeSnapshot({
      records: this.records,
      issues: this.issues,
      output: this.records.at(-1)?.value ?? null,
      complete: this.complete,
    });
  }

  private consumeCompleteLines(): void {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      this.consumeLine(this.buffer.slice(0, newlineIndex));
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private consumeFinalLine(): void {
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
  }

  private consumeLine(rawLine: string): void {
    const text = stripCarriageReturn(rawLine);
    const line = this.line;
    this.line += 1;
    if (text.trim().length === 0) {
      return;
    }
    this.parseLine(line, text);
  }

  private parseLine(line: number, text: string): void {
    try {
      const value: unknown = JSON.parse(text);
      this.records.push(Object.freeze({ line, value }));
    } catch (error) {
      this.issues.push(Object.freeze({ line, message: parseMessage(error), text }));
    }
  }
}

/**
 * Parses complete JSONL input in one call.
 *
 * @param input - Complete JSONL string or UTF-8 bytes.
 *
 * @returns Frozen final parser snapshot.
 *
 * @example
 * ```ts
 * const snapshot = parseHeadlessJsonl('{"ok":true}\n');
 * ```
 */
export function parseHeadlessJsonl(input: string | Uint8Array): HeadlessJsonlParserSnapshot {
  const parser = new HeadlessJsonlParser();
  parser.push(input);
  return parser.finish();
}

const decodeChunk = (decoder: TextDecoder, chunk: string | Uint8Array, done: boolean): string =>
  typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: !done });

const stripCarriageReturn = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line;

const parseMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Invalid JSON.";

const freezeSnapshot = (snapshot: HeadlessJsonlParserSnapshot): HeadlessJsonlParserSnapshot =>
  Object.freeze({
    records: Object.freeze([...snapshot.records]),
    issues: Object.freeze([...snapshot.issues]),
    output: snapshot.output,
    complete: snapshot.complete,
  });
