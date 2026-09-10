/** Maximum child stdout accepted by the parser (16 MiB). */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- protocol byte limit.
export const MAX_HEADLESS_STDOUT_BYTES = 16 * 1024 * 1024;

/** Maximum pending or complete JSONL line size (1 MiB). */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- protocol byte limit.
export const MAX_HEADLESS_JSONL_LINE_BYTES = 1024 * 1024;

/** Maximum combined retained records and malformed-JSON issues. */
export const MAX_HEADLESS_JSONL_ENTRIES = 10_000;

const lineFeedByte = 0x0a;

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

  /** Deterministic terminal parser failure, when parsing cannot continue safely. */
  readonly fatalError?: string;

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
  readonly encoder: TextEncoder;
  readonly records: HeadlessJsonlRecord[];
  readonly issues: HeadlessJsonlParseIssue[];
  buffer: string;
  line: number;
  totalBytes: number;
  pendingLineBytes: number;
  fatalError: string | undefined;
  snapshot: HeadlessJsonlParserSnapshot | undefined;
  complete: boolean;
}

const pushChunk = (state: HeadlessJsonlParserState, chunk: string | Uint8Array): void => {
  assertPushable(state);
  if (state.fatalError !== undefined) {
    return;
  }
  state.snapshot = undefined;
  const bytes = typeof chunk === "string" ? state.encoder.encode(chunk) : chunk;
  if (!acceptChunk(state, bytes)) {
    return;
  }
  const decoded = decodeBytes(state, bytes);
  if (decoded !== undefined) {
    state.buffer += decoded;
    consumeCompleteLines(state);
  }
};

const assertPushable = (state: HeadlessJsonlParserState): void => {
  if (state.complete) {
    throw new RangeError("Cannot push after parser is finished.");
  }
};

const acceptChunk = (state: HeadlessJsonlParserState, bytes: Uint8Array): boolean => {
  if (state.totalBytes + bytes.byteLength > MAX_HEADLESS_STDOUT_BYTES) {
    fail(state, `Child stdout exceeded ${String(MAX_HEADLESS_STDOUT_BYTES)} bytes.`);
    return false;
  }
  state.totalBytes += bytes.byteLength;
  if (exceedsLineLimit(state, bytes)) {
    fail(state, `JSONL line exceeded ${String(MAX_HEADLESS_JSONL_LINE_BYTES)} bytes.`);
    return false;
  }
  return true;
};

const decodeBytes = (state: HeadlessJsonlParserState, bytes: Uint8Array): string | undefined => {
  try {
    return state.decoder.decode(bytes, { stream: true });
  } catch {
    fail(state, "Invalid UTF-8 in child stdout.");
    return undefined;
  }
};

const finishParsing = (state: HeadlessJsonlParserState): void => {
  if (state.complete) {
    return;
  }
  state.snapshot = undefined;
  if (state.fatalError === undefined) {
    try {
      state.buffer += state.decoder.decode();
      consumeFinalLine(state);
    } catch {
      fail(state, "Invalid UTF-8 in child stdout.");
    }
  }
  state.complete = true;
};

const exceedsLineLimit = (state: HeadlessJsonlParserState, bytes: Uint8Array): boolean => {
  let lineBytes = state.pendingLineBytes;
  for (const byte of bytes) {
    if (byte === lineFeedByte) {
      lineBytes = 0;
    } else {
      lineBytes += 1;
      if (lineBytes > MAX_HEADLESS_JSONL_LINE_BYTES) {
        return true;
      }
    }
  }
  state.pendingLineBytes = lineBytes;
  return false;
};

const consumeCompleteLines = (state: HeadlessJsonlParserState): void => {
  let newlineIndex = state.buffer.indexOf("\n");
  while (newlineIndex >= 0 && state.fatalError === undefined) {
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
    if (isUpdateRecord(value)) {
      return;
    }
    if (entryLimitReached(state)) {
      return;
    }
    state.records.push(Object.freeze({ line: recordLine, value }));
  } catch (error) {
    if (entryLimitReached(state)) {
      return;
    }
    state.issues.push(Object.freeze({ line: recordLine, message: parseMessage(error), text }));
  }
};

const isUpdateRecord = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Reflect.get(value, "type") === "message_update" ||
    Reflect.get(value, "type") === "tool_execution_update");

const entryLimitReached = (state: HeadlessJsonlParserState): boolean => {
  if (state.records.length + state.issues.length < MAX_HEADLESS_JSONL_ENTRIES) {
    return false;
  }
  fail(state, `JSONL record and issue count exceeded ${String(MAX_HEADLESS_JSONL_ENTRIES)}.`);
  return true;
};

const fail = (state: HeadlessJsonlParserState, message: string): void => {
  state.fatalError ??= message;
  state.buffer = "";
  state.pendingLineBytes = 0;
};

const snapshotOf = (state: HeadlessJsonlParserState): HeadlessJsonlParserSnapshot => {
  state.snapshot ??= freezeSnapshot({
    records: state.records,
    issues: state.issues,
    output: state.records.at(-1)?.value ?? null,
    ...(state.fatalError === undefined ? {} : { fatalError: state.fatalError }),
    complete: state.complete,
  });
  return state.snapshot;
};

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
    decoder: new TextDecoder("utf-8", { fatal: true }),
    encoder: new TextEncoder(),
    records: [],
    issues: [],
    buffer: "",
    line: 1,
    totalBytes: 0,
    pendingLineBytes: 0,
    fatalError: undefined,
    snapshot: undefined,
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

const stripCarriageReturn = (line: string): string =>
  line.endsWith("\r") ? line.slice(0, -1) : line;

const parseMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Invalid JSON.";

const freezeSnapshot = (snapshot: HeadlessJsonlParserSnapshot): HeadlessJsonlParserSnapshot =>
  Object.freeze({
    records: Object.freeze([...snapshot.records]),
    issues: Object.freeze([...snapshot.issues]),
    output: snapshot.output,
    ...(snapshot.fatalError === undefined ? {} : { fatalError: snapshot.fatalError }),
    complete: snapshot.complete,
  });
