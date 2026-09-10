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

/** UTF-8 byte code for newline (LF). */
const NEWLINE_BYTE = 0x0a;

/** Mutable per-parser state held by the factory closure. */
interface HeadlessJsonlParserState {
  readonly decoder: TextDecoder;
  readonly records: HeadlessJsonlRecord[];
  readonly issues: HeadlessJsonlParseIssue[];
  pending: Uint8Array[];
  pendingLength: number;
  pendingHighSurrogate: string;
  line: number;
  complete: boolean;
}

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

const trailingHighSurrogate = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  return last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX
    ? text.charAt(text.length - 1)
    : "";
};

/**
 * Encodes a string chunk while holding back a trailing lone high surrogate so a
 * UTF-16 pair split across two pushes survives independent per-chunk encoding.
 *
 * @param state - Parser state carrying any previously held surrogate.
 * @param chunk - String chunk to encode.
 *
 * @returns UTF-8 bytes of the chunk minus a held trailing surrogate.
 */
const encodeTextChunk = (state: HeadlessJsonlParserState, chunk: string): Uint8Array => {
  const text = state.pendingHighSurrogate + chunk;
  state.pendingHighSurrogate = trailingHighSurrogate(text);
  return Buffer.from(state.pendingHighSurrogate === "" ? text : text.slice(0, -1), "utf-8");
};

/**
 * Flushes a held lone surrogate: it can never pair with later bytes, so it
 * degrades to replacement bytes in the pending buffer.
 *
 * @param state - Parser state whose held surrogate is flushed.
 */
const flushHeldSurrogate = (state: HeadlessJsonlParserState): void => {
  if (state.pendingHighSurrogate !== "") {
    const bytes = Buffer.from(state.pendingHighSurrogate, "utf-8");
    state.pendingHighSurrogate = "";
    state.pending.push(bytes);
    state.pendingLength += bytes.length;
  }
};

/**
 * Converts one public chunk to bytes without allowing byte input to complete a
 * held UTF-16 surrogate from an earlier string chunk.
 *
 * @param state - Parser state carrying any held surrogate.
 * @param chunk - Public string or byte chunk.
 *
 * @returns Bytes ready for newline scanning.
 */
const bytesOfChunk = (state: HeadlessJsonlParserState, chunk: string | Uint8Array): Uint8Array => {
  if (typeof chunk === "string") {
    return encodeTextChunk(state, chunk);
  }
  flushHeldSurrogate(state);
  return chunk;
};

const pushChunk = (state: HeadlessJsonlParserState, chunk: string | Uint8Array): void => {
  if (state.complete) {
    throw new RangeError("Cannot push after parser is finished.");
  }
  const bytes = bytesOfChunk(state, chunk);
  let start = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === NEWLINE_BYTE) {
      const lineSlice = bytes.subarray(start, i);
      consumeLineBytes(state, lineSlice);
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    const remaining = bytes.subarray(start);
    state.pending.push(remaining);
    state.pendingLength += remaining.length;
  }
};

const consumeLineBytes = (state: HeadlessJsonlParserState, trailingSlice: Uint8Array): void => {
  let lineBytes: Uint8Array;
  if (state.pending.length === 0) {
    lineBytes = trailingSlice;
  } else {
    state.pending.push(trailingSlice);
    const combined = new Uint8Array(state.pendingLength + trailingSlice.length);
    let offset = 0;
    for (const p of state.pending) {
      combined.set(p, offset);
      offset += p.length;
    }
    lineBytes = combined;
    state.pending = [];
    state.pendingLength = 0;
  }
  const text = state.decoder.decode(lineBytes, { stream: true });
  consumeLine(state, text);
};

const finishParsing = (state: HeadlessJsonlParserState): void => {
  if (!state.complete) {
    flushHeldSurrogate(state);
    if (state.pending.length > 0) {
      const combined = new Uint8Array(state.pendingLength);
      let offset = 0;
      for (const p of state.pending) {
        combined.set(p, offset);
        offset += p.length;
      }
      state.pending = [];
      state.pendingLength = 0;
      const text = state.decoder.decode(combined, { stream: false });
      consumeLine(state, text);
    }
    state.complete = true;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTransientStreamUpdate = (value: unknown): boolean =>
  isRecord(value) && value["type"] === "message_update";

/** Maximum characters of invalid line text retained in a parse issue to bound memory. */
const MAX_PARSE_ISSUE_PREVIEW_CHARS = 1000;

/** Maximum length of an uninteresting stdout line before skipping JSON.parse to prevent V8 OOM. */
const MAX_UNINTERESTING_LINE_CHARS = 500_000;

const isPotentiallyRelevantLine = (text: string): boolean =>
  text.length <= MAX_UNINTERESTING_LINE_CHARS ||
  text.includes('"headlessOutput"') ||
  text.includes('"message_end"');

const parseLine = (state: HeadlessJsonlParserState, recordLine: number, text: string): void => {
  if (!isPotentiallyRelevantLine(text)) {
    return;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isTransientStreamUpdate(value)) {
      state.records.push(Object.freeze({ line: recordLine, value }));
    }
  } catch (error) {
    state.issues.push(
      Object.freeze({
        line: recordLine,
        message: parseMessage(error),
        text: text.slice(0, MAX_PARSE_ISSUE_PREVIEW_CHARS),
      }),
    );
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
    pending: [],
    pendingLength: 0,
    pendingHighSurrogate: "",
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
