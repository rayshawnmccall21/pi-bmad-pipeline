import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import qualityGuard from "../.pi/extensions/quality-guard.js";

interface GuardEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

type GuardResult = { readonly block?: boolean; readonly reason?: string } | undefined;
type GuardHandler = (event: GuardEvent) => GuardResult;

const createHandler = (): GuardHandler => {
  let handler: GuardHandler | undefined;
  const pi = {
    on: (eventName: string, candidate: unknown): void => {
      if (eventName === "tool_call") {
        handler = candidate as GuardHandler;
      }
    },
  } as unknown as ExtensionAPI;

  qualityGuard(pi);
  if (handler === undefined) {
    throw new Error("Quality guard did not register a tool_call handler.");
  }
  return handler;
};

describe("quality guard extension", () => {
  it.each(["edit", "write"])("blocks %s calls targeting knip.json", (toolName) => {
    expect(createHandler()({ toolName, input: { path: "/project/knip.json" } })).toMatchObject({
      block: true,
    });
  });

  it("allows edits to unlocked files", () => {
    expect(
      createHandler()({ toolName: "edit", input: { path: "/project/src/index.ts" } }),
    ).toBeUndefined();
  });
});
