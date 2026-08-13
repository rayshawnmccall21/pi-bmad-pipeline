# Pipeline runner scripts

Add a runner when a repository needs one stable entry point for people, CI, or another program. Keep a one-off invocation in documentation.

## Choose the smallest tool

1. Use a package-manager script for a fixed pipeline.
2. Use POSIX shell for project-root resolution and transparent argument forwarding.
3. Use Python or JavaScript stdlib only when the wrapper must translate JSONL or supervise a long-lived child.

## Contract

- One script delegates to `bmad-pipeline run`.
- Resolve the project root from the script's checkout or `git rev-parse --show-toplevel`.
- Accept pipeline id and optional CLI policy through argv. Let Pi configuration select the default model unless the caller supplies `--model`.
- Resolve `bmad-pipeline` through `PATH`; accept an override through environment when a checkout build is required.
- Give stdout to the CLI protocol and send wrapper diagnostics to stderr.
- Preserve quoting, interrupts, and the child exit code.
- Keep stage order, gates, budgets, extensions, and observability in the RunDef.
- Add one fake-executable check for exact argv and exit propagation. Real pipeline execution is an integration test, not a wrapper unit test.

## Shell baseline

```sh
#!/bin/sh
set -eu

pipeline=${1:?"usage: run-pipeline <pipeline-id> [bmad-pipeline options]"}
shift
root=$(git rev-parse --show-toplevel)
runner=${BMAD_PIPELINE_BIN:-bmad-pipeline}

cd "$root"
exec "$runner" run "$pipeline" --project-root "$root" "$@"
```

This wrapper supports utility pipelines and story pipelines because it forwards current CLI options rather than recreating their parser. Call it as:

```bash
.pi/bmad/scripts/run-pipeline start-webapp --jsonl
.pi/bmad/scripts/run-pipeline pkg-loop --story-id STY-1 \
  --spec-file .pi/artifacts/implementation/stories/STY-1.md --jsonl
```

## Stdlib escalation

When a human event summary is required, keep raw JSONL on stdout and write derived status lines to stderr. Build argv as an array, use a child-process API without a shell, forward termination with a bounded grace period, and return the child's exact status.

A runner is complete when catalog validation passes, the fake-child check proves argv and status behavior, and an explicitly requested smoke produces one terminal event consistent with durable state.
