import { describe, expect, it } from "vitest";

import { hasBlockingGitSecretFindings, scanGitDiffForSecrets } from "./index.js";

const bearerToken = (): string => `Bearer ${"a".repeat(20)}`;
const openAiKey = (): string => `sk-${"a".repeat(24)}`;
const anthropicKey = (): string => `sk-ant-${"a".repeat(24)}`;
const googleKey = (): string => `AIza${"a".repeat(25)}`;
const githubShortToken = (): string => `ghp_${"a".repeat(32)}`;
const githubPatToken = (): string => `github_pat_${"a".repeat(24)}`;
const awsAccessKey = (): string => `AKIA${"A".repeat(16)}`;
const awsSecret = (): string => "A".repeat(40);

const patterns = (diff: string): readonly string[] =>
  scanGitDiffForSecrets(diff).findings.map((finding) => finding.pattern);

describe("git diff secret scan", () => {
  it("passes clean diff", () => {
    expect(scanGitDiffForSecrets("+const ok = true;\n")).toEqual({
      passed: true,
      findings: [],
      reason: "Git diff secret scan passed.",
    });
  });

  it("detects bearer token findings", () => {
    expect(patterns(`+token = "${bearerToken()}"`)).toEqual(["bearer-token"]);
  });

  it("detects OpenAI keys", () => {
    expect(patterns(`+key = "${openAiKey()}"`)).toEqual(["openai-api-key"]);
  });

  it("detects Anthropic keys as Anthropic only", () => {
    expect(patterns(`+key = "${anthropicKey()}"`)).toEqual(["anthropic-api-key"]);
  });

  it("detects Google API keys", () => {
    expect(patterns(`+key = "${googleKey()}"`)).toEqual(["google-api-key"]);
  });

  it("detects short GitHub tokens", () => {
    expect(patterns(`+token = "${githubShortToken()}"`)).toEqual(["github-token"]);
  });

  it("detects GitHub pat tokens", () => {
    expect(patterns(`+token = "${githubPatToken()}"`)).toEqual(["github-token"]);
  });

  it("detects AWS access key ids", () => {
    expect(patterns(`+key = "${awsAccessKey()}"`)).toEqual(["aws-access-key-id"]);
  });

  it("detects AWS secret access key assignments", () => {
    expect(patterns(`+AWS_SECRET_ACCESS_KEY=${awsSecret()}`)).toEqual(["aws-secret-access-key"]);
    expect(patterns(`+aws_secret_access_key = ${awsSecret()}`)).toEqual(["aws-secret-access-key"]);
    expect(patterns(`+awsSecretAccessKey: ${awsSecret()}`)).toEqual(["aws-secret-access-key"]);
  });

  it("includes one-based line numbers", () => {
    expect(scanGitDiffForSecrets(`clean\n+key = ${openAiKey()}`).findings[0]?.line).toBe(2);
  });

  it("preserves deterministic input order", () => {
    const result = scanGitDiffForSecrets(`+key = ${openAiKey()}\n+key = ${googleKey()}`);

    expect(result.findings.map((finding) => finding.pattern)).toEqual([
      "openai-api-key",
      "google-api-key",
    ]);
    expect(result.findings.map((finding) => finding.line)).toEqual([1, 2]);
  });

  it("preserves deterministic pattern order on one line", () => {
    expect(patterns(`+tokens ${googleKey()} ${bearerToken()} ${openAiKey()}`)).toEqual([
      "bearer-token",
      "openai-api-key",
      "google-api-key",
    ]);
  });

  it("redacts previews without raw token text", () => {
    const token = openAiKey();
    const preview = scanGitDiffForSecrets(`+key = ${token}`).findings[0]?.preview;

    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain(token);
  });

  it("emits at most one finding per line and pattern", () => {
    expect(scanGitDiffForSecrets(`+keys ${openAiKey()} ${openAiKey()}`).findings).toHaveLength(1);
  });

  it("handles CRLF previews", () => {
    const result = scanGitDiffForSecrets(`+key = ${openAiKey()}\r\n+clean\r\n`);

    expect(result.findings[0]?.line).toBe(1);
    expect(result.findings[0]?.preview.endsWith("\r")).toBe(false);
  });

  it("uses passed, singular, and plural reasons", () => {
    expect(scanGitDiffForSecrets("clean").reason).toBe("Git diff secret scan passed.");
    expect(scanGitDiffForSecrets(`+key ${openAiKey()}`).reason).toBe(
      "Git diff secret scan blocked 1 secret-shaped finding.",
    );
    expect(scanGitDiffForSecrets(`+key ${openAiKey()}\n+key ${googleKey()}`).reason).toBe(
      "Git diff secret scan blocked 2 secret-shaped findings.",
    );
  });

  it("reports blocking findings", () => {
    expect(hasBlockingGitSecretFindings(scanGitDiffForSecrets("clean"))).toBe(false);
    expect(hasBlockingGitSecretFindings(scanGitDiffForSecrets(`+key ${openAiKey()}`))).toBe(true);
  });

  it("freezes result and nested findings", () => {
    const result = scanGitDiffForSecrets(`+key ${openAiKey()}`);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(Object.isFrozen(result.findings[0])).toBe(true);
  });

  it("does not mutate input string", () => {
    const input = `+key ${openAiKey()}`;
    const before = input.slice();

    scanGitDiffForSecrets(input);

    expect(input).toBe(before);
  });
});
