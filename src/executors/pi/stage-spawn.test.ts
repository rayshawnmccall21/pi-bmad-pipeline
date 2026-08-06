import { describe, expect, it } from "vitest";

import { BMAD_STAGE_STDIO, nodeStageSpawn } from "./stage-spawn.js";

const collect = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    stream.on("end", () => {
      resolve(text);
    });
  });

const waitForClose = (child: {
  on: (event: "close", handler: () => void) => unknown;
}): Promise<void> =>
  new Promise((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

describe("stage spawn seam", () => {
  it("freezes the stdio contract with stdin ignored", () => {
    expect(BMAD_STAGE_STDIO).toEqual(["ignore", "pipe", "pipe"]);
    expect(Object.isFrozen(BMAD_STAGE_STDIO)).toBe(true);
  });

  it("spawns real children with no stdin stream and piped stdout/stderr", async () => {
    const child = nodeStageSpawn(
      process.execPath,
      ["-e", "console.log('out'); console.error('err')"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: BMAD_STAGE_STDIO,
      },
    );

    const [stdout, stderr] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      waitForClose(child),
    ]);

    expect(child.stdin).toBeNull();
    expect(stdout.trim()).toBe("out");
    expect(stderr.trim()).toBe("err");
  });

  it("gives print-mode children immediate EOF on stdin", async () => {
    const child = nodeStageSpawn(
      process.execPath,
      ["-e", "process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"],
      { cwd: process.cwd(), env: process.env, stdio: BMAD_STAGE_STDIO },
    );

    const [stdout] = await Promise.all([collect(child.stdout), waitForClose(child)]);

    expect(stdout.trim()).toBe("eof");
  });
});
