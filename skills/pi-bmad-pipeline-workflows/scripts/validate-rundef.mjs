#!/usr/bin/env node

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: validate-rundef.mjs <pipeline.yaml> [...]");
  process.exitCode = 2;
} else {
  try {
    const [{ compileValidatedRunDef, loadRunDefFile }, { registerBmadPayloadGates }] =
      await Promise.all([
        import(new URL("../../../dist/src/rundef/index.js", import.meta.url)),
        import(new URL("../../../dist/src/gates/index.js", import.meta.url)),
      ]);

    registerBmadPayloadGates();
    for (const file of files) {
      const discovered = await loadRunDefFile(file);
      compileValidatedRunDef(discovered.runDef);
      console.log(`${discovered.id}\t${discovered.path}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
