#!/usr/bin/env bash
# Proof that the desktop ui project really grants a 45s test timeout, and that a
# 32-worker run of it no longer aborts healthy tests.
#
# Part 1 is the part that proves the number: a 21s sleep fails under the old 15s
# budget ("Test timed out in 15000ms") and can only pass under a larger one.
# Part 2 is the part that proves the point: the whole project at MAX_WORKERS
# with no starvation timeouts in the log.
#
# Needs a runtime with more than 256MB of address space — the bubblewrap
# terminal backend caps every command at RLIMIT_AS = memory_mb (default 256),
# and Node cannot initialise V8 inside that. Raise
# plugins.entries.bubblewrap.settings.memory_mb (and cpu_seconds, default 30,
# which kills a long run with exit 137) before running this.
set -euo pipefail

MAX_WORKERS="${MAX_WORKERS:-32}"
MIN_AS_KB="${MIN_AS_KB:-$((2 * 1024 * 1024))}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root/apps/desktop"

as_kb="$(ulimit -v)"
if [ "$as_kb" != "unlimited" ] && [ "$as_kb" -lt "$MIN_AS_KB" ]; then
  echo "REFUSING: RLIMIT_AS is ${as_kb} KB; Node cannot start inside it." >&2
  echo "Raise plugins.entries.bubblewrap.settings.memory_mb (and cpu_seconds) first." >&2
  exit 2
fi

proof_file="src/__timeout_proof.test.ts"
trap 'rm -f "$proof_file"' EXIT

cat > "$proof_file" <<'EOF'
import { expect, test } from 'vitest'

// 21s sits between the old 15s budget and the new 45s one, so this passes only
// if the ui project's testTimeout really was raised.
test('ui project grants a 45s test timeout', async () => {
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 21_000))
  expect(Date.now() - started).toBeGreaterThanOrEqual(20_500)
})
EOF

echo "== part 1: does the ui project grant 45s? =="
if ! pnpm exec vitest run --project ui "$proof_file"; then
  echo "FAIL: the ui testTimeout is not above 21s" >&2
  exit 1
fi

echo "== part 2: full ui project at ${MAX_WORKERS} workers =="
log="$(mktemp -t ui-32w.XXXXXX.log)"
set -o pipefail
if ! pnpm exec vitest run --project ui --maxWorkers="$MAX_WORKERS" 2>&1 | tee "$log"; then
  echo "FAIL: suite exited non-zero (log: $log)" >&2
  exit 1
fi

if grep -qE "Test timed out in (5000|15000)ms" "$log"; then
  echo "FAIL: tests are still being aborted on a timeout this change lifts (log: $log)" >&2
  exit 1
fi

grep -q "Test Files .* passed" "$log" || { echo "FAIL: suite not green (log: $log)" >&2; exit 1; }
echo "PASS: 45s ui timeout in force; ${MAX_WORKERS}-worker suite green"
