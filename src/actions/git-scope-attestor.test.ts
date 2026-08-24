import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCanonicalRepositoryScope } from "../security/index.js";
import { createGitScopeAttestor } from "./git-scope-attestor.js";

import type { ScopeAttestationResult } from "../core/scope-attestation.js";

const digest = (character: string): string => character.repeat(64);
const encoded = (value: string): Uint8Array => new TextEncoder().encode(value);
const baseOid = "c".repeat(40);
const headOid = "d".repeat(40);
const mergeBaseOid = "a".repeat(40);

const authenticatedRunGit = (statusResult: string | Error) =>
  vi.fn(async (_root: string, args: readonly string[]): Promise<string> => {
    const command = args.join(" ");
    if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
    if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
      return "refs/remotes/origin/main\n";
    }
    if (
      command === "rev-parse --verify refs/heads/main" ||
      command === "rev-parse --verify refs/remotes/origin/main" ||
      command === "rev-parse HEAD"
    ) {
      return `${baseOid}\n`;
    }
    if (command === "status --porcelain=v1 -z --untracked-files=all") {
      if (statusResult instanceof Error) throw statusResult;
      return statusResult;
    }
    throw new Error(`Unexpected git command: ${command}`);
  });

const codedReadError = (code: string): Error & { readonly code: string } =>
  Object.assign(new Error(`read failed: ${code}`), { code });

const actionAwareRunGit = ({
  mergeBaseResult = `${mergeBaseOid}\n`,
  statuses = [""],
  heads = [headOid],
}: {
  readonly mergeBaseResult?: string;
  readonly statuses?: readonly string[];
  readonly heads?: readonly string[];
} = {}) => {
  let headRead = 0;
  let statusRead = 0;
  const commands: string[] = [];
  const runGit = vi.fn(async (_root: string, args: readonly string[]): Promise<string> => {
    const command = args.join(" ");
    commands.push(command);
    if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
    if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
      return "refs/remotes/origin/main\n";
    }
    if (
      command === "rev-parse --verify refs/heads/main" ||
      command === "rev-parse --verify refs/remotes/origin/main"
    ) {
      return `${baseOid}\n`;
    }
    if (command === "rev-parse HEAD") {
      const oid = heads[Math.min(headRead, heads.length - 1)] ?? headOid;
      headRead += 1;
      return `${oid}\n`;
    }
    if (command.startsWith(`merge-base --all ${baseOid} `)) return mergeBaseResult;
    if (
      command.startsWith(`diff --name-status -z --no-renames ${mergeBaseOid} `) &&
      command.endsWith(" --")
    ) {
      return "";
    }
    if (command === "status --porcelain=v1 -z --untracked-files=all") {
      const status = statuses[Math.min(statusRead, statuses.length - 1)] ?? "";
      statusRead += 1;
      return status;
    }
    throw new Error(`Unexpected git command: ${command}`);
  });
  return { commands, runGit };
};

const expectRejectedWithoutAuthorization = (result: ScopeAttestationResult): void => {
  expect(result).toMatchObject({ kind: "rejected" });
  expect(result).not.toHaveProperty("checkpoint");
  expect(result).not.toHaveProperty("receipt");
};

let temporaryRoot: string | undefined;

const createPhysicalScope = async (): Promise<{
  projectRoot: string;
  outsideRoot: string;
}> => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "git-scope-attestor-"));
  const projectRoot = join(temporaryRoot, "repo");
  const outsideRoot = join(temporaryRoot, "outside");
  await Promise.all([mkdir(projectRoot), mkdir(outsideRoot)]);
  return { projectRoot, outsideRoot };
};

afterEach(async () => {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  }
});

const identity = {
  projectRoot: "/repo",
  storyId: "STY-144",
  runId: "run-144",
  runDefId: "create-story-dev-story-code-review-docs",
  runDefDigest: digest("a"),
};

const qualityGate = {
  stageId: "code-review",
  attempt: 1,
  status: "passed" as const,
  finishedAt: "2026-08-18T00:00:00.000Z",
};

describe("createGitScopeAttestor", () => {
  it("builds a Git-derived review checkpoint and docs-bound final receipt", async () => {
    const fileBytes = new Map([
      ["README.md", encoded("docs\n")],
      ["src/app.ts", encoded("source\n")],
      ["tests/app.test.ts", encoded("test\n")],
    ]);
    const runGit = vi.fn(async (_root: string, args: readonly string[]) => {
      const command = args.join(" ");
      if (command === "symbolic-ref --quiet --short HEAD") return "sty-139/landing-integrity\n";
      if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
        return "refs/remotes/origin/main\n";
      }
      if (
        command === "rev-parse --verify refs/heads/main" ||
        command === "rev-parse --verify refs/remotes/origin/main" ||
        command === "rev-parse HEAD"
      ) {
        return `${"b".repeat(40)}\n`;
      }
      if (command === "status --porcelain=v1 -z --untracked-files=all") {
        return " M README.md\0 M src/app.ts\0?? tests/app.test.ts\0";
      }
      throw new Error(`Unexpected git command: ${command}`);
    });
    const attest = createGitScopeAttestor({
      runGit,
      readBytes: async (_root, path) => fileBytes.get(path)!,
    });

    const review = await attest({ phase: "review", ...identity, qualityGate });
    expect(review.kind).toBe("review-checkpoint");
    if (review.kind !== "review-checkpoint") expect.unreachable("review should attest");
    expect(review.checkpoint.reviewed.paths).toEqual(["src/app.ts", "tests/app.test.ts"]);
    expect(review.checkpoint.branch).toBe("sty-139/landing-integrity");

    const final = await attest({
      phase: "final",
      ...identity,
      reviewCheckpoint: review.checkpoint,
      qualityGate,
    });
    expect(final.kind).toBe("final-receipt");
    if (final.kind !== "final-receipt") expect.unreachable("final scope should attest");
    expect(final.receipt.docs.paths).toEqual(["README.md"]);
    expect(final.receipt.reviewed).toEqual(review.checkpoint.reviewed);
  });

  it("excludes default-only post-fork additions and includes branch-owned committed paths", async () => {
    const defaultTipOid = "c".repeat(40);
    const storyHeadOid = "d".repeat(40);
    const forkOid = "b".repeat(40);
    const branchOwnedPath = "src/branch-owned.ts";
    const defaultOnlyPath = "src/default-only.ts";
    const runGit = vi.fn(async (_root: string, args: readonly string[]) => {
      const command = args.join(" ");
      if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
      if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
        return "refs/remotes/origin/main\n";
      }
      if (
        command === "rev-parse --verify refs/heads/main" ||
        command === "rev-parse --verify refs/remotes/origin/main"
      ) {
        return `${defaultTipOid}\n`;
      }
      if (command === "rev-parse HEAD") return `${storyHeadOid}\n`;
      if (command === `merge-base --all ${defaultTipOid} ${storyHeadOid}`) {
        return `${forkOid}\n`;
      }
      if (command === `diff --name-status -z --no-renames ${forkOid} ${storyHeadOid} --`) {
        return `A\0${branchOwnedPath}\0`;
      }
      if (command === `diff --name-only -z ${defaultTipOid} ${storyHeadOid} --`) {
        return `${branchOwnedPath}\0${defaultOnlyPath}\0`;
      }
      if (command === "status --porcelain=v1 -z --untracked-files=all") return "";
      throw new Error(`Unexpected git command: ${command}`);
    });
    const readBytes = vi.fn(async (_root: string, path: string) => {
      if (path === branchOwnedPath) return encoded("branch-owned\n");
      const error = new Error(`missing ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const attest = createGitScopeAttestor({ runGit, readBytes });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expect(result).toMatchObject({
      kind: "review-checkpoint",
      checkpoint: {
        baseOid: defaultTipOid,
        reviewed: { paths: [branchOwnedPath] },
      },
    });
    expect(runGit).toHaveBeenCalledWith("/repo", [
      "merge-base",
      "--all",
      defaultTipOid,
      storyHeadOid,
    ]);
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(readBytes).toHaveBeenCalledWith("/repo", branchOwnedPath);
  });

  it("invalidates review when a reviewed byte changes after approval", async () => {
    const fileBytes = new Map([
      ["src/app.ts", encoded("source\n")],
      ["README.md", encoded("docs\n")],
    ]);
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/main\n";
        }
        if (
          command === "rev-parse --verify refs/heads/main" ||
          command === "rev-parse --verify refs/remotes/origin/main" ||
          command === "rev-parse HEAD"
        ) {
          return `${"b".repeat(40)}\n`;
        }
        if (command === "status --porcelain=v1 -z --untracked-files=all") {
          return " M README.md\0 M src/app.ts\0";
        }
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes: async (_root, path) => fileBytes.get(path)!,
    });
    const review = await attest({ phase: "review", ...identity, qualityGate });
    if (review.kind !== "review-checkpoint") expect.unreachable("review should attest");
    fileBytes.set("src/app.ts", encoded("changed\n"));

    await expect(
      attest({ phase: "final", ...identity, reviewCheckpoint: review.checkpoint, qualityGate }),
    ).resolves.toEqual({ kind: "review-invalidated", changedPaths: ["src/app.ts"] });
  });

  it.each([
    "docs/agent-guide.md",
    "docs/command-reference.md",
    "docs/config-guide.md",
    "docs/context-reference.md",
    "docs/instruction-guide.md",
    "docs/prompt-guide.md",
    "docs/skill-reference.md",
    "docs/spec-guide.md",
    "docs/workflow-overview.md",
  ])(
    "keeps instruction-bearing near-miss %s in reviewed scope so deletion invalidates approval",
    async (path) => {
      const { runGit } = actionAwareRunGit({
        statuses: [` M ${path}\0`, ` D ${path}\0`, ` D ${path}\0`],
      });
      let readCount = 0;
      const attest = createGitScopeAttestor({
        runGit,
        readBytes: async () => {
          readCount += 1;
          if (readCount === 1) return encoded("executable instructions\n");
          throw codedReadError("ENOENT");
        },
      });
      const review = await attest({ phase: "review", ...identity, qualityGate });
      if (review.kind !== "review-checkpoint") expect.unreachable("review should attest");

      await expect(
        attest({ phase: "final", ...identity, reviewCheckpoint: review.checkpoint, qualityGate }),
      ).resolves.toEqual({ kind: "review-invalidated", changedPaths: [path] });
    },
  );

  it.each(["main", "master"] as const)(
    "authenticates synchronized %s as the exact receipt base",
    async (defaultBranch) => {
      const oid = "c".repeat(40);
      const commands: string[] = [];
      const attest = createGitScopeAttestor({
        runGit: async (_root, args) => {
          const command = args.join(" ");
          commands.push(command);
          if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
          if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
            return `refs/remotes/origin/${defaultBranch}\n`;
          }
          if (
            command === `rev-parse --verify refs/heads/${defaultBranch}` ||
            command === `rev-parse --verify refs/remotes/origin/${defaultBranch}` ||
            command === "rev-parse HEAD"
          ) {
            return `${oid}\n`;
          }
          if (command === "status --porcelain=v1 -z --untracked-files=all") return "";
          throw new Error(`Unexpected git command: ${command}`);
        },
        readBytes: async () => encoded("unused"),
      });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expect(result).toMatchObject({
        kind: "review-checkpoint",
        checkpoint: { baseOid: oid },
      });
      expect(
        commands.filter((command) => command.includes("refs/remotes/origin/HEAD")),
      ).toHaveLength(2);
    },
  );

  it.each([
    {
      caseName: "symbolic default identity",
      remoteHead: " refs/remotes/origin/main \n",
      localOid: `${"c".repeat(40)}\n`,
      remoteOid: `${"c".repeat(40)}\n`,
    },
    {
      caseName: "local default OID",
      remoteHead: "refs/remotes/origin/main\n",
      localOid: ` ${"c".repeat(40)} \n`,
      remoteOid: `${"c".repeat(40)}\n`,
    },
    {
      caseName: "remote default OID",
      remoteHead: "refs/remotes/origin/main\n",
      localOid: `${"c".repeat(40)}\n`,
      remoteOid: ` ${"c".repeat(40)} \n`,
    },
  ] as const)(
    "rejects whitespace-padded $caseName before observing scope",
    async ({ remoteHead, localOid, remoteOid }) => {
      const commands: string[] = [];
      const readBytes = vi.fn(async () => encoded("forbidden"));
      const attest = createGitScopeAttestor({
        runGit: async (_root, args) => {
          const command = args.join(" ");
          commands.push(command);
          if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
          if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") return remoteHead;
          if (command === "rev-parse --verify refs/heads/main") return localOid;
          if (command === "rev-parse --verify refs/remotes/origin/main") return remoteOid;
          if (command === "rev-parse HEAD") return `${"d".repeat(40)}\n`;
          if (command === "status --porcelain=v1 -z --untracked-files=all") return "";
          if (command === `diff --name-only -z ${"c".repeat(40)} ${"d".repeat(40)} --`) {
            return "";
          }
          throw new Error(`Unexpected git command: ${command}`);
        },
        readBytes,
      });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expect(result).toMatchObject({ kind: "rejected" });
      expect(commands).not.toContain("status --porcelain=v1 -z --untracked-files=all");
      expect(commands.some((command) => command.startsWith("diff "))).toBe(false);
      expect(readBytes).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unsupported default", async (): Promise<string> => "refs/remotes/origin/trunk\n"],
    ["malformed default", async (): Promise<string> => "origin/master\n"],
    [
      "missing symbolic ref",
      async (): Promise<string> => {
        throw new Error("missing origin HEAD");
      },
    ],
  ] as const)("rejects %s before reading repository bytes", async (_case, remoteHead) => {
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") return remoteHead();
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    await expect(attest({ phase: "review", ...identity, qualityGate })).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it.each(["refs/heads/master", "refs/remotes/origin/master"] as const)(
    "rejects a missing default ref %s before scope bytes",
    async (missingRef) => {
      const readBytes = vi.fn(async () => encoded("forbidden"));
      const attest = createGitScopeAttestor({
        runGit: async (_root, args) => {
          const command = args.join(" ");
          if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
          if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
            return "refs/remotes/origin/master\n";
          }
          if (command === `rev-parse --verify ${missingRef}`) {
            throw new Error(`missing ${missingRef}`);
          }
          if (
            command === "rev-parse --verify refs/heads/master" ||
            command === "rev-parse --verify refs/remotes/origin/master"
          ) {
            return `${"c".repeat(40)}\n`;
          }
          throw new Error(`Unexpected git command: ${command}`);
        },
        readBytes,
      });

      await expect(attest({ phase: "review", ...identity, qualityGate })).resolves.toMatchObject({
        kind: "rejected",
      });
      expect(readBytes).not.toHaveBeenCalled();
    },
  );

  it("rejects divergent local and remote default OIDs before scope bytes", async () => {
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/master\n";
        }
        if (command === "rev-parse --verify refs/heads/master") return `${"a".repeat(40)}\n`;
        if (command === "rev-parse --verify refs/remotes/origin/master") {
          return `${"b".repeat(40)}\n`;
        }
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    await expect(attest({ phase: "review", ...identity, qualityGate })).resolves.toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/synchron|moved|identity/iu),
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rejects local default-tip movement during authentication before observing scope", async () => {
    let localTipReads = 0;
    const commands: string[] = [];
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        commands.push(command);
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/master\n";
        }
        if (command === "rev-parse --verify refs/heads/master") {
          localTipReads += 1;
          return `${(localTipReads === 1 ? "c" : "d").repeat(40)}\n`;
        }
        if (command === "rev-parse --verify refs/remotes/origin/master") {
          return `${"c".repeat(40)}\n`;
        }
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    await expect(attest({ phase: "review", ...identity, qualityGate })).resolves.toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/moved|identity/iu),
    });
    expect(commands).not.toContain("status --porcelain=v1 -z --untracked-files=all");
    expect(commands.some((command) => command.startsWith("diff "))).toBe(false);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rejects remote default-tip movement during authentication before observing scope", async () => {
    let remoteTipReads = 0;
    const commands: string[] = [];
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        commands.push(command);
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/master\n";
        }
        if (command === "rev-parse --verify refs/heads/master") {
          return `${"c".repeat(40)}\n`;
        }
        if (command === "rev-parse --verify refs/remotes/origin/master") {
          remoteTipReads += 1;
          return `${(remoteTipReads === 1 ? "c" : "d").repeat(40)}\n`;
        }
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    await expect(attest({ phase: "review", ...identity, qualityGate })).resolves.toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/moved|identity/iu),
    });
    expect(commands).not.toContain("status --porcelain=v1 -z --untracked-files=all");
    expect(commands.some((command) => command.startsWith("diff "))).toBe(false);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rejects default-ref movement during authentication", async () => {
    let remoteHeadReads = 0;
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          remoteHeadReads += 1;
          return remoteHeadReads === 1
            ? "refs/remotes/origin/master\n"
            : "refs/remotes/origin/main\n";
        }
        if (
          command === "rev-parse --verify refs/heads/master" ||
          command === "rev-parse --verify refs/remotes/origin/master"
        ) {
          return `${"c".repeat(40)}\n`;
        }
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    await expect(attest({ phase: "review", ...identity, qualityGate })).resolves.toMatchObject({
      kind: "rejected",
      reason: expect.stringMatching(/moved|identity/iu),
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it.each([
    ["no terminal NUL", " M src/app.ts"],
    ["a lone empty record", "\0"],
    ["more than one terminal NUL", " M src/app.ts\0\0"],
    ["an empty interior record", " M src/app.ts\0\0?? tests/app.test.ts\0"],
  ])("rejects porcelain with %s before reading repository bytes", async (_caseName, porcelain) => {
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit(porcelain),
      readBytes,
    });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expect(result).toMatchObject({ kind: "rejected" });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rejects conflicting duplicate porcelain records before reading or authorizing scope", async () => {
    const path = "src/app.ts";
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit(`D  ${path}\0 M ${path}\0`),
      readBytes,
    });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expectRejectedWithoutAuthorization(result);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rejects conflicting duplicate committed records before status, bytes, or authorization", async () => {
    const path = "src/app.ts";
    const commands: string[] = [];
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        commands.push(command);
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/main\n";
        }
        if (
          command === "rev-parse --verify refs/heads/main" ||
          command === "rev-parse --verify refs/remotes/origin/main"
        ) {
          return `${baseOid}\n`;
        }
        if (command === "rev-parse HEAD") return `${headOid}\n`;
        if (command === `merge-base --all ${baseOid} ${headOid}`) {
          return `${mergeBaseOid}\n`;
        }
        if (command === `diff --name-status -z --no-renames ${mergeBaseOid} ${headOid} --`) {
          return `A\0${path}\0D\0${path}\0`;
        }
        if (command === "status --porcelain=v1 -z --untracked-files=all") return "";
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expectRejectedWithoutAuthorization(result);
    expect(commands).not.toContain("status --porcelain=v1 -z --untracked-files=all");
    expect(readBytes).not.toHaveBeenCalled();
  });

  it.each([
    ["same-action ordinary", " M src/app.ts\0 M src/app.ts\0"],
    ["duplicate excluded", " M .pi/pipeline/state/run.json\0 M .pi/pipeline/state/run.json\0"],
  ] as const)(
    "rejects %s duplicate porcelain paths before authorization",
    async (_caseName, status) => {
      const readBytes = vi.fn(async () => encoded("forbidden"));
      const attest = createGitScopeAttestor({
        runGit: authenticatedRunGit(status),
        readBytes,
      });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expectRejectedWithoutAuthorization(result);
      expect(readBytes).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["same-action ordinary", "A\0src/app.ts\0A\0src/app.ts\0"],
    ["duplicate excluded", "A\0.pi/pipeline/state/run.json\0A\0.pi/pipeline/state/run.json\0"],
  ] as const)(
    "rejects %s duplicate committed paths before dirty evidence or authorization",
    async (_caseName, committedOutput) => {
      const commands: string[] = [];
      const readBytes = vi.fn(async () => encoded("forbidden"));
      const attest = createGitScopeAttestor({
        runGit: async (_root, args) => {
          const command = args.join(" ");
          commands.push(command);
          if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
          if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
            return "refs/remotes/origin/main\n";
          }
          if (
            command === "rev-parse --verify refs/heads/main" ||
            command === "rev-parse --verify refs/remotes/origin/main"
          ) {
            return `${baseOid}\n`;
          }
          if (command === "rev-parse HEAD") return `${headOid}\n`;
          if (command === `merge-base --all ${baseOid} ${headOid}`) {
            return `${mergeBaseOid}\n`;
          }
          if (command === `diff --name-status -z --no-renames ${mergeBaseOid} ${headOid} --`) {
            return committedOutput;
          }
          throw new Error(`Unexpected git command: ${command}`);
        },
        readBytes,
      });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expectRejectedWithoutAuthorization(result);
      expect(commands).not.toContain("status --porcelain=v1 -z --untracked-files=all");
      expect(readBytes).not.toHaveBeenCalled();
    },
  );

  it("lets dirty evidence override one committed observation of the same path", async () => {
    const path = "src/app.ts";
    const readBytes = vi.fn(async () => encoded("dirty file is present\n"));
    const attest = createGitScopeAttestor({
      runGit: async (_root, args) => {
        const command = args.join(" ");
        if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/main\n";
        }
        if (
          command === "rev-parse --verify refs/heads/main" ||
          command === "rev-parse --verify refs/remotes/origin/main"
        ) {
          return `${baseOid}\n`;
        }
        if (command === "rev-parse HEAD") return `${headOid}\n`;
        if (command === `merge-base --all ${baseOid} ${headOid}`) return `${mergeBaseOid}\n`;
        if (command === `diff --name-status -z --no-renames ${mergeBaseOid} ${headOid} --`) {
          return `D\0${path}\0`;
        }
        if (command === "status --porcelain=v1 -z --untracked-files=all") {
          return ` M ${path}\0`;
        }
        throw new Error(`Unexpected git command: ${command}`);
      },
      readBytes,
    });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expect(result).toMatchObject({
      kind: "review-checkpoint",
      checkpoint: { reviewed: { paths: [path] } },
    });
    expect(readBytes).toHaveBeenCalledOnce();
  });

  it.each([
    { caseName: "impossible", status: "ZZ" },
    { caseName: "unmerged", status: "UU" },
  ] as const)(
    "rejects unsupported porcelain-v1 XY status $status ($caseName) before reading repository bytes",
    async ({ status }) => {
      const readBytes = vi.fn(async () => encoded("forbidden"));
      const attest = createGitScopeAttestor({
        runGit: authenticatedRunGit(`${status} src/app.ts\0`),
        readBytes,
      });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expect(result).toMatchObject({ kind: "rejected" });
      expect(readBytes).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      caseName: "committed",
      headOid: "d".repeat(40),
      committedStatus: "D\0src/deleted.ts\0",
      porcelain: "",
    },
    {
      caseName: "staged",
      headOid: baseOid,
      committedStatus: "",
      porcelain: "D  src/deleted.ts\0",
    },
    {
      caseName: "unstaged",
      headOid: baseOid,
      committedStatus: "",
      porcelain: " D src/deleted.ts\0",
    },
  ])(
    "normalizes coded ENOENT for a stable $caseName tracked deletion without aliasing empty content",
    async ({ headOid: deletionHeadOid, committedStatus, porcelain }) => {
      const deletedPath = "src/deleted.ts";
      const readBytes = vi.fn(async (_root: string, path: string): Promise<Uint8Array> => {
        expect(path).toBe(deletedPath);
        throw Object.assign(new Error("tracked deletion is absent"), { code: "ENOENT" });
      });
      const attest = createGitScopeAttestor({
        runGit: async (_root, args) => {
          const command = args.join(" ");
          if (command === "symbolic-ref --quiet --short HEAD") return "feature\n";
          if (command === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
            return "refs/remotes/origin/main\n";
          }
          if (
            command === "rev-parse --verify refs/heads/main" ||
            command === "rev-parse --verify refs/remotes/origin/main"
          ) {
            return `${baseOid}\n`;
          }
          if (command === "rev-parse HEAD") return `${deletionHeadOid}\n`;
          if (command === `merge-base --all ${baseOid} ${deletionHeadOid}`) return `${baseOid}\n`;
          if (command === `diff --name-status -z --no-renames ${baseOid} ${deletionHeadOid} --`) {
            return committedStatus;
          }
          if (command === "status --porcelain=v1 -z --untracked-files=all") return porcelain;
          throw new Error(`Unexpected git command: ${command}`);
        },
        readBytes,
      });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expect(result.kind).toBe("review-checkpoint");
      if (result.kind !== "review-checkpoint") expect.unreachable("deletion should attest");
      expect(result.checkpoint.reviewed.paths).toEqual([deletedPath]);
      expect(result.checkpoint.reviewed.digest).not.toBe(
        createCanonicalRepositoryScope([{ path: deletedPath, bytes: new Uint8Array() }]).digest,
      );
      expect(readBytes).toHaveBeenCalledWith(identity.projectRoot, deletedPath);
    },
  );

  it.each([
    {
      caseName: "present-path coded ENOENT",
      statuses: [" M src/file.ts\0"],
      heads: [headOid],
      readResult: codedReadError("ENOENT"),
    },
    {
      caseName: "absent-path non-ENOENT",
      statuses: [" D src/file.ts\0"],
      heads: [headOid],
      readResult: codedReadError("EACCES"),
    },
    {
      caseName: "deletion reappearance",
      statuses: [" D src/file.ts\0"],
      heads: [headOid],
      readResult: encoded("reappeared\n"),
    },
    {
      caseName: "HEAD movement during absence confirmation",
      statuses: [" D src/file.ts\0"],
      heads: [headOid, "e".repeat(40)],
      readResult: codedReadError("ENOENT"),
    },
    {
      caseName: "status movement during absence confirmation",
      statuses: [" D src/file.ts\0", " M src/file.ts\0"],
      heads: [headOid],
      readResult: codedReadError("ENOENT"),
    },
  ])("rejects $caseName without authorizing scope", async ({ statuses, heads, readResult }) => {
    const { commands, runGit } = actionAwareRunGit({ statuses, heads });
    const readBytes = vi.fn(async (): Promise<Uint8Array> => {
      if (readResult instanceof Error) throw readResult;
      return readResult;
    });
    const attest = createGitScopeAttestor({ runGit, readBytes });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expectRejectedWithoutAuthorization(result);
    expect(commands).toContain(`merge-base --all ${baseOid} ${headOid}`);
    expect(readBytes).toHaveBeenCalledOnce();
    if (heads.length > 1) {
      expect(commands.filter((command) => command === "rev-parse HEAD")).toHaveLength(2);
    }
    if (statuses.length > 1) {
      expect(
        commands.filter((command) => command === "status --porcelain=v1 -z --untracked-files=all"),
      ).toHaveLength(2);
    }
  });

  it.each([
    { caseName: "missing", mergeBaseResult: "" },
    { caseName: "malformed", mergeBaseResult: `not-${mergeBaseOid}\n` },
    {
      caseName: "multiple",
      mergeBaseResult: `${mergeBaseOid}\n${"b".repeat(40)}\n`,
    },
  ])(
    "rejects $caseName merge-base output before scope authorization",
    async ({ mergeBaseResult }) => {
      const { commands, runGit } = actionAwareRunGit({ mergeBaseResult });
      const readBytes = vi.fn(async () => encoded("forbidden"));
      const attest = createGitScopeAttestor({ runGit, readBytes });

      const result = await attest({ phase: "review", ...identity, qualityGate });

      expectRejectedWithoutAuthorization(result);
      expect(commands).toContain(`merge-base --all ${baseOid} ${headOid}`);
      expect(commands.some((command) => command.startsWith("diff "))).toBe(false);
      expect(commands).not.toContain("status --porcelain=v1 -z --untracked-files=all");
      expect(readBytes).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["renamed", "R  src/renamed.ts\0src/original.ts\0"],
    ["copied", "C  src/copied.ts\0src/original.ts\0"],
  ])("rejects %s porcelain before reading repository bytes", async (_caseName, porcelain) => {
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit(porcelain),
      readBytes,
    });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expect(result).toMatchObject({ kind: "rejected" });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rejects a lexical path escape with the default physical reader", async () => {
    const { projectRoot, outsideRoot } = await createPhysicalScope();
    await writeFile(join(outsideRoot, "secret.ts"), "forbidden\n");
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit("?? ../outside/secret.ts\0"),
    });

    const result = await attest({ phase: "review", ...identity, projectRoot, qualityGate });

    expect(result).toMatchObject({ kind: "rejected" });
  });

  it("rejects a final symlink with the default physical reader", async () => {
    const { projectRoot } = await createPhysicalScope();
    await writeFile(join(projectRoot, "target.ts"), "forbidden\n");
    await symlink("target.ts", join(projectRoot, "link.ts"));
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit("?? link.ts\0"),
    });

    const result = await attest({ phase: "review", ...identity, projectRoot, qualityGate });

    expect(result).toMatchObject({ kind: "rejected" });
  });

  it("rejects a symlinked-parent escape with the default physical reader", async () => {
    const { projectRoot, outsideRoot } = await createPhysicalScope();
    await writeFile(join(outsideRoot, "secret.ts"), "forbidden\n");
    await symlink("../outside", join(projectRoot, "linked"), "dir");
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit("?? linked/secret.ts\0"),
    });

    const result = await attest({ phase: "review", ...identity, projectRoot, qualityGate });

    expect(result).toMatchObject({ kind: "rejected" });
  });

  it("redacts and bounds raw Git diagnostics in attestation rejection reasons", async () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const readBytes = vi.fn(async () => encoded("forbidden"));
    const attest = createGitScopeAttestor({
      runGit: authenticatedRunGit(
        new Error(`Git configuration contains ${secret}${"x".repeat(4096)}`),
      ),
      readBytes,
    });

    const result = await attest({ phase: "review", ...identity, qualityGate });

    expect(result).toMatchObject({ kind: "rejected" });
    if (result.kind !== "rejected") expect.unreachable("attestation should reject");
    expect(result.reason).not.toContain(secret);
    expect(result.reason).toContain("[REDACTED]");
    expect(result.reason.length).toBeLessThanOrEqual(1024);
    expect(readBytes).not.toHaveBeenCalled();
  });
});
