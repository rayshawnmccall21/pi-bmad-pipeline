#!/usr/bin/env node

const args = process.argv.slice(2);
const projectMode = args[0] === "--project-root";
const invalidArgs =
  args.length === 0 ||
  (projectMode
    ? args.length !== 2 || args[1].trim() === ""
    : args.some((arg) => arg.startsWith("--")));

if (invalidArgs) {
  console.error("Usage: validate-rundef.mjs --project-root <dir> | <pipeline.yaml> [...]");
  process.exitCode = 2;
} else {
  try {
    const [rundef, gates] = await Promise.all([
      import(new URL("../../../dist/src/rundef/index.js", import.meta.url)),
      import(new URL("../../../dist/src/gates/index.js", import.meta.url)),
    ]);

    gates.registerBmadPayloadGates();

    let discovered;
    if (projectMode) {
      discovered = await rundef.discoverRunDefs(args[1]);
    } else {
      discovered = [];
      const ids = new Map();
      for (const file of args) {
        const entry = await rundef.loadRunDefFile(file);
        const duplicatePath = ids.get(entry.id);
        if (duplicatePath !== undefined) {
          throw new Error(
            `Duplicate RunDef id "${entry.id}" in "${duplicatePath}" and "${entry.path}".`,
          );
        }
        ids.set(entry.id, entry.path);
        discovered.push(entry);
      }
    }

    for (const entry of discovered) {
      rundef.compileValidatedRunDef(entry.runDef);
      console.log(`${entry.id}\t${entry.path}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
