import { describe, expect, it } from "vitest";

import type { RunDef } from "./index.js";
import {
  RunDefValidationError,
  assertRunDef,
  isRunDef,
  parseRunDef,
  validateRunDef,
} from "./schema.js";

const validRunDef = (): RunDef => ({
  id: "sdlc",
  stages: [
    {
      id: "create-story",
      kind: "agent",
      workflow: "create-story",
      agent: "sm",
      timeout: 1800,
    },
    {
      id: "dev-story",
      kind: "agent",
      workflow: "dev-story",
      agent: "dev",
      timeout: 3600,
      thinking: "medium",
      budget: { maxTokens: 1000, maxDollars: 0 },
    },
    {
      id: "e2e-verify",
      kind: "agent",
      workflow: "e2e-verify",
      agent: "tea",
      gate: "e2e-verify",
      onFail: "dev-story",
      timeout: 7200,
    },
  ],
});

describe("RunDef schema validation - structural", () => {
  it("accepts a valid RunDef", () => {
    const candidate = validRunDef();

    const result = validateRunDef(candidate);

    expect(result).toEqual({ ok: true, value: candidate });
  });

  it("allows the documented built-in SDLC shape", () => {
    const candidate: RunDef = {
      id: "sdlc",
      stages: [
        { id: "create-story", kind: "agent", workflow: "create-story", agent: "sm", timeout: 1800 },
        { id: "e2e-plan", kind: "agent", workflow: "e2e-plan", agent: "tea", timeout: 1800 },
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev", timeout: 3600 },
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          gate: "e2e-verify",
          onFail: "dev-story",
          timeout: 7200,
        },
        {
          id: "code-review",
          kind: "agent",
          workflow: "code-review",
          agent: "dev",
          gate: "code-review",
          onFail: "dev-story",
          thinking: "high",
          timeout: 1800,
        },
        {
          id: "docs",
          kind: "agent",
          workflow: "docs",
          agent: "architect",
          thinking: "high",
          timeout: 1800,
        },
      ],
    };

    expect(validateRunDef(candidate)).toEqual({ ok: true, value: candidate });
  });

  it("rejects non-object root values", () => {
    const result = validateRunDef(null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("");
    }
  });

  it("rejects an empty stage list", () => {
    const result = validateRunDef({ id: "sdlc", stages: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toContain("/stages");
    }
  });
});

describe("RunDef schema validation - identifiers", () => {
  it.each([
    ["root id", { id: "SDLC", stages: validRunDef().stages }],
    [
      "stage id",
      { ...validRunDef(), stages: [{ ...validRunDef().stages[0]!, id: "create_story" }] },
    ],
    [
      "workflow",
      { ...validRunDef(), stages: [{ ...validRunDef().stages[0]!, workflow: "CreateStory" }] },
    ],
    ["agent", { ...validRunDef(), stages: [{ ...validRunDef().stages[0]!, agent: "dev team" }] }],
  ])("rejects malformed identifier for %s", (_label, candidate) => {
    expect(validateRunDef(candidate).ok).toBe(false);
  });
});

describe("RunDef schema validation - properties and kinds", () => {
  it("rejects unknown root properties", () => {
    const candidate = { ...validRunDef(), extra: true };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it("rejects unknown stage properties", () => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, extra: true }] };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it("rejects unknown budget properties", () => {
    const stage = validRunDef().stages[0]!;
    const candidate = {
      id: "sdlc",
      stages: [{ ...stage, budget: { maxTokens: 1000, extra: true } }],
    };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it("rejects stage kinds other than agent", () => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, kind: "shell" }] };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it.each(["none", "LOW", "maximum"])("rejects invalid thinking value %j", (thinking) => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, thinking }] };

    expect(validateRunDef(candidate).ok).toBe(false);
  });
});

describe("RunDef schema validation - numeric constraints", () => {
  it.each([0, -1, 1.5, "1800"])("rejects invalid timeout %j", (timeout) => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, timeout }] };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it.each([0, -1, 1.5, "1000"])("rejects invalid maxTokens %j", (maxTokens) => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, budget: { maxTokens } }] };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it.each([-1, "1"])("rejects invalid maxDollars %j", (maxDollars) => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, budget: { maxDollars } }] };

    expect(validateRunDef(candidate).ok).toBe(false);
  });

  it("allows maxDollars equal to zero", () => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, budget: { maxDollars: 0 } }] };

    expect(validateRunDef(candidate).ok).toBe(true);
  });
});

describe("RunDef cross-field invariants", () => {
  it("rejects duplicate stage ids", () => {
    const candidate = {
      id: "sdlc",
      stages: [
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev" },
        { id: "dev-story", kind: "agent", workflow: "code-review", agent: "dev" },
      ],
    };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/1/id",
        message: 'Duplicate stage id "dev-story".',
      });
    }
  });

  it("rejects a gate without onFail", () => {
    const candidate = {
      id: "sdlc",
      stages: [
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev" },
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          gate: "e2e-verify",
        },
      ],
    };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/1/onFail",
        message: 'Stage "e2e-verify" declares gate "e2e-verify" but no onFail target.',
      });
    }
  });

  it("rejects onFail without a gate", () => {
    const candidate = {
      id: "sdlc",
      stages: [
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev" },
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          onFail: "dev-story",
        },
      ],
    };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/1/gate",
        message: 'Stage "e2e-verify" declares onFail "dev-story" but no gate.',
      });
    }
  });

  it("rejects onFail targets that do not exist", () => {
    const candidate = {
      id: "sdlc",
      stages: [
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev" },
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          gate: "e2e-verify",
          onFail: "missing-stage",
        },
      ],
    };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/1/onFail",
        message: 'Stage "e2e-verify" onFail target "missing-stage" does not exist.',
      });
    }
  });

  it("rejects onFail targets that point to the same stage", () => {
    const candidate = {
      id: "sdlc",
      stages: [
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          gate: "e2e-verify",
          onFail: "e2e-verify",
        },
      ],
    };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/0/onFail",
        message: 'Stage "e2e-verify" onFail target "e2e-verify" must be an earlier stage.',
      });
    }
  });

  it("rejects onFail targets that point forward", () => {
    const candidate = {
      id: "sdlc",
      stages: [
        {
          id: "e2e-verify",
          kind: "agent",
          workflow: "e2e-verify",
          agent: "tea",
          gate: "e2e-verify",
          onFail: "dev-story",
        },
        { id: "dev-story", kind: "agent", workflow: "dev-story", agent: "dev" },
      ],
    };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/0/onFail",
        message: 'Stage "e2e-verify" onFail target "dev-story" must be an earlier stage.',
      });
    }
  });

  it("rejects an empty budget object", () => {
    const stage = validRunDef().stages[0]!;
    const candidate = { id: "sdlc", stages: [{ ...stage, budget: {} }] };

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        path: "/stages/0/budget",
        message: 'Stage "create-story" budget must set maxTokens or maxDollars.',
      });
    }
  });
});

describe("RunDef validation helpers", () => {
  it("parseRunDef returns valid RunDef and throws RunDefValidationError on failure", () => {
    const candidate = validRunDef();

    expect(parseRunDef(candidate)).toBe(candidate);

    expect(() => parseRunDef({ id: "sdlc", stages: [] })).toThrow(RunDefValidationError);

    try {
      parseRunDef({ id: "sdlc", stages: [] });
      throw new Error("parseRunDef should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RunDefValidationError);
      if (error instanceof RunDefValidationError) {
        expect(error.issues.length).toBeGreaterThan(0);
        expect(error.message).toMatch(/Invalid RunDef/u);
      }
    }
  });

  it("assertRunDef narrows valid candidates and throws for invalid candidates", () => {
    const candidate: unknown = validRunDef();

    assertRunDef(candidate);

    expect(candidate.id).toBe("sdlc");
    expect(() => {
      assertRunDef({ id: "sdlc", stages: [] });
    }).toThrow(RunDefValidationError);
  });

  it("isRunDef returns true for valid and false for invalid candidates", () => {
    expect(isRunDef(validRunDef())).toBe(true);
    expect(isRunDef({ id: "sdlc", stages: [] })).toBe(false);
  });

  it("preserves object identity on success", () => {
    const candidate = validRunDef();

    const result = validateRunDef(candidate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(candidate);
    }
  });
});
