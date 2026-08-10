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
export interface HeadlessJsonlParser {
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
   * createHeadlessJsonlParser().push('{"ok":true}\n');
   * ```
   */
  push(chunk: string | Uint8Array): HeadlessJsonlParserSnapshot;

  /**
   * Finishes parsing, including a final unterminated line.
   *
   * @returns Frozen final parser snapshot.
   *
   * @example
   * ```ts
   * const final = createHeadlessJsonlParser().finish();
   * ```
   */
  finish(): HeadlessJsonlParserSnapshot;

  /**
   * Returns the current parser snapshot.
   *
   * @returns Frozen parser snapshot.
   *
   * @example
   * ```ts
   * createHeadlessJsonlParser().snapshot();
   * ```
   */
  snapshot(): HeadlessJsonlParserSnapshot;
}

/** Mutable per-parser state held by the factory closure. */
interface HeadlessJsonlParserState {
  readonly decoder: TextDecoder;
  readonly records: HeadlessJsonlRecord[];
  readonly issues: HeadlessJsonlParseIssue[];
  buffer: string;
  line: number;
  complete: boolean;
}

const pushChunk = (state: HeadlessJsonlParserState, chunk: string | Uint8Array): void => {
  if (state.complete) {
    throw new RangeError("Cannot push after parser is finished.");
  }
  state.buffer += decodeChunk(state.decoder, chunk, false);
  consumeCompleteLines(state);
};

const finishParsing = (state: HeadlessJsonlParserState): void => {
  if (!state.complete) {
    state.buffer += state.decoder.decode();
    consumeFinalLine(state);
    state.complete = true;
  }
};

const consumeCompleteLines = (state: HeadlessJsonlParserState): void => {
  let newlineIndex = state.buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    consumeLine(state, state.buffer.slice(0, newlineIndex));
    state.buffer = state.buffer.slice(newlineIndex + 1);
    newlineIndex = state.buffer.indexOf("\n");
  }
};

const consumeFinalLine = (state: HeadlessJsonlParserState): void => {
  if (state.buffer.length > 0) {
    consumeLine(state, state.buffer);
    state.buffer = "";
  }
};

const consumeLine = (state: HeadlessJsonlParserState, rawLine: string): void => {
  const text = stripCarriageReturn(rawLine);
  const currentLine = state.line;
  state.line += 1;
  if (text.trim().length === 0) {
    return;
  }
  parseLine(state, currentLine, text);
};

const parseLine = (state: HeadlessJsonlParserState, recordLine: number, text: string): void => {
  try {
    const value: unknown = JSON.parse(text);
    state.records.push(Object.freeze({ line: recordLine, value }));
  } catch (error) {
    state.issues.push(Object.freeze({ line: recordLine, message: parseMessage(error), text }));
  }
};

const snapshotOf = (state: HeadlessJsonlParserState): HeadlessJsonlParserSnapshot =>
  freezeSnapshot({
    records: state.records,
    issues: state.issues,
    output: state.records.at(-1)?.value ?? null,
    complete: state.complete,
  });

/**
 * Creates an incremental UTF-8 JSONL parser for child stdout.
 *
 * Parser state lives in an explicit state object so each stream keeps an
 * independent decoder, record buffer, and line counter. The returned methods
 * are thin closures over the module-level parse helpers.
 *
 * @returns A parser with push/finish/snapshot methods.
 *
 * @example
 * ```ts
 * const parser = createHeadlessJsonlParser();
 * parser.push('{"ok":true}\n');
 * ```
 */
export function createHeadlessJsonlParser(): HeadlessJsonlParser {
  const state: HeadlessJsonlParserState = {
    decoder: new TextDecoder("utf-8"),
    records: [],
    issues: [],
    buffer: "",
    line: 1,
    complete: false,
  };
  return Object.freeze({
    push(chunk: string | Uint8Array): HeadlessJsonlParserSnapshot {
      pushChunk(state, chunk);
      return snapshotOf(state);
    },
    finish(): HeadlessJsonlParserSnapshot {
      finishParsing(state);
      return snapshotOf(state);
    },
    snapshot(): HeadlessJsonlParserSnapshot {
      return snapshotOf(state);
    },
  });
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
  const parser = createHeadlessJsonlParser();
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
