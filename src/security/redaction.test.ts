import { describe, expect, it } from "vitest";

import { REDACTION_PLACEHOLDER, redactError, redactText, redactValue } from "./index.js";

const bearer = "Bearer abcdefghijklmnopqrstuvwxyz123456";
const openai = "sk-abcdefghijklmnopqrstuvwx";
const anthropic = "sk-ant-abcdefghijklmnopqrstuvwx";
const google = "AIzaABCDEFGHIJKLMNOPQRSTUVWXY";
const githubClassic = "ghp_abcdefghijklmnopqrstuvwxyzABCDE";
const githubFineGrained = "github_pat_abcdefghijklmnopqrstuvwx";
const fakeAwsKeyBody = "ABCDEFGHIJKLMNOP";
const awsAccessKeyId = "AKIA" + fakeAwsKeyBody;
const awsSessionAccessKeyId = "ASIA" + fakeAwsKeyBody;
const awsSecretValue = "abcdefghijklmnopqrstuvwxyz" + "ABCDEFGHIJKLMN";
const awsSecret = `AWS_SECRET_ACCESS_KEY=${awsSecretValue}`;
const awsSecretJson = `"awsSecretAccessKey": "${awsSecretValue}"`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

describe("credential redaction", () => {
  it("leaves text without credentials unchanged", () => {
    expect(redactText("hello world")).toEqual({
      value: "hello world",
      redacted: false,
      matches: [],
    });
  });

  it("redacts bearer tokens", () => {
    expect(redactText(`auth ${bearer}`).value).toBe(`auth ${REDACTION_PLACEHOLDER}`);
  });

  it("redacts OpenAI API keys", () => {
    expect(redactText(openai)).toMatchObject({
      value: REDACTION_PLACEHOLDER,
      matches: [{ name: "openai-api-key", count: 1 }],
    });
  });

  it("redacts Anthropic API keys as anthropic only", () => {
    expect(redactText(anthropic)).toMatchObject({
      value: REDACTION_PLACEHOLDER,
      matches: [{ name: "anthropic-api-key", count: 1 }],
    });
  });

  it("redacts Google API keys", () => {
    expect(redactText(google)).toMatchObject({
      value: REDACTION_PLACEHOLDER,
      matches: [{ name: "google-api-key", count: 1 }],
    });
  });

  it("redacts GitHub classic tokens", () => {
    expect(redactText(githubClassic)).toMatchObject({
      value: REDACTION_PLACEHOLDER,
      matches: [{ name: "github-token", count: 1 }],
    });
  });

  it("redacts GitHub fine-grained tokens", () => {
    expect(redactText(githubFineGrained)).toMatchObject({
      value: REDACTION_PLACEHOLDER,
      matches: [{ name: "github-token", count: 1 }],
    });
  });

  it("redacts AWS access key ids", () => {
    expect(redactText(`${awsAccessKeyId} ${awsSessionAccessKeyId}`)).toMatchObject({
      value: `${REDACTION_PLACEHOLDER} ${REDACTION_PLACEHOLDER}`,
      matches: [{ name: "aws-access-key-id", count: 2 }],
    });
  });

  it("redacts AWS secret access key values while preserving prefixes", () => {
    expect(redactText(`${awsSecret} ${awsSecretJson}`).value).toBe(
      `AWS_SECRET_ACCESS_KEY=${REDACTION_PLACEHOLDER} "awsSecretAccessKey": "${REDACTION_PLACEHOLDER}"`,
    );
  });

  it("redacts multiple credential types in deterministic match order", () => {
    expect(redactText(`${githubClassic} ${bearer} ${openai} ${awsAccessKeyId}`)).toMatchObject({
      value: `${REDACTION_PLACEHOLDER} ${REDACTION_PLACEHOLDER} ${REDACTION_PLACEHOLDER} ${REDACTION_PLACEHOLDER}`,
      matches: [
        { name: "bearer-token", count: 1 },
        { name: "openai-api-key", count: 1 },
        { name: "github-token", count: 1 },
        { name: "aws-access-key-id", count: 1 },
      ],
    });
  });

  it("omits zero-count patterns", () => {
    expect(redactText(openai).matches.map((match) => match.name)).toEqual(["openai-api-key"]);
  });

  it("freezes result, matches array, and match objects", () => {
    const result = redactText(openai);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.matches)).toBe(true);
    expect(Object.isFrozen(result.matches[0])).toBe(true);
  });

  it("redacts Error message and stack", () => {
    const error = new Error(`failed ${openai}`);
    error.stack = `stack ${githubClassic}`;

    expect(redactError(error)).toMatchObject({
      value: `Error: failed ${REDACTION_PLACEHOLDER}\nstack ${REDACTION_PLACEHOLDER}`,
      redacted: true,
    });
  });

  it("redacts nested object string leaves", () => {
    expect(redactValue({ nested: { token: bearer } })).toEqual({
      nested: { token: REDACTION_PLACEHOLDER },
    });
  });

  it("redacts nested arrays", () => {
    expect(redactValue(["safe", [openai]])).toEqual(["safe", [REDACTION_PLACEHOLDER]]);
  });

  it("does not mutate input objects or arrays", () => {
    const input = { tokens: [openai] };
    const before = JSON.stringify(input);

    redactValue(input);

    expect(JSON.stringify(input)).toBe(before);
  });

  it("freezes returned nested arrays and objects", () => {
    const output = redactValue({ tokens: [openai] });

    expect(Object.isFrozen(output)).toBe(true);
    if (isRecord(output)) {
      expect(Object.isFrozen(output["tokens"])).toBe(true);
    }
  });

  it("returns non-string primitives unchanged", () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(1)).toBe(1);
    expect(redactValue(true)).toBe(true);
  });

  it("does not redact short ordinary strings", () => {
    expect(redactText("Bearer token sk-test")).toMatchObject({
      value: "Bearer token sk-test",
      redacted: false,
    });
  });
});
