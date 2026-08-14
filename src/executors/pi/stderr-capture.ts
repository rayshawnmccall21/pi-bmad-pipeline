/** Bounded streaming UTF-8 stderr capture. */
interface StderrCapture {
  /** Appends one stderr chunk. */
  readonly push: (chunk: Uint8Array | string) => void;
  /** Finalizes and returns the captured text. */
  readonly value: () => string;
}

/**
 * Creates a bounded streaming UTF-8 stderr capture.
 *
 * @param maximumCharacters - Maximum retained character count.
 *
 * @returns Streaming capture for one child stderr stream.
 */
export const createStderrCapture = (maximumCharacters: number): StderrCapture => {
  const decoder = new TextDecoder("utf-8");
  let captured = "";
  let finished = false;
  const append = (text: string): void => {
    captured += text.slice(0, Math.max(0, maximumCharacters - captured.length));
  };
  return {
    push(chunk) {
      if (!finished) {
        append(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
      }
    },
    value() {
      if (!finished) {
        append(decoder.decode());
        finished = true;
      }
      return captured;
    },
  };
};
