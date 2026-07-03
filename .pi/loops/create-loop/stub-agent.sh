#!/usr/bin/env bash
#
# stub-agent.sh — deterministic flaky agent for the create-loop demo.
#
# "Fails twice then passes": persists a failure counter in .stub-state next to
# this script. The first two invocations exit 1; every subsequent invocation
# exits 0. Deterministic given the counter state — run-loop.sh resets the
# counter at the start of each bounded run so smoke runs are reproducible.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$SCRIPT_DIR/.stub-state"

# Read current failure count (default 0 when file missing or empty).
failureCount=0
if [ -s "$STATE" ]; then
  failureCount="$(cat "$STATE")"
fi

# Fail twice, then pass.
if [ "$failureCount" -lt 2 ]; then
  nextCount=$((failureCount + 1))
  echo "$nextCount" > "$STATE"
  echo "stub-agent: failure #${nextCount} (exiting 1)" >&2
  exit 1
fi

echo "stub-agent: green (exiting 0)" >&2
exit 0
