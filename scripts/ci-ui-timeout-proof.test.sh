#!/usr/bin/env bash
# Exercises scripts/ci-ui-timeout-proof.sh with a stub pnpm, so its branches can
# be proven on a machine where Node cannot start at all (RLIMIT_AS 256MB kills
# V8 during engine init, long before vitest runs).
#
# Run: bash scripts/ci-ui-timeout-proof.test.sh   (exit 0 = all checks passed)
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo/scripts/ci-ui-timeout-proof.sh"
stub=$(mktemp -d)

cat > "$stub/pnpm" <<'EOF'
#!/usr/bin/env bash
n=$(( $(cat "$STUB_COUNTER" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_COUNTER"
case "${STUB_MODE:-pass}" in
  pass)    printf ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n'; exit 0 ;;
  timeout) printf ' Test Files  1 failed (1)\n     Test timed out in 15000ms\n'; exit 0 ;;
  red)     printf 'boom\n'; exit 1 ;;
  red2)    [ "$n" -eq 1 ] && { printf ' Test Files  1 passed (1)\n'; exit 0; }; printf 'boom\n'; exit 1 ;;
esac
EOF
chmod +x "$stub/pnpm"

fail=0
check() { # name expected_exit expected_pattern mode
  local name=$1 want_rc=$2 want=$3 mode=$4 out rc
  rm -f "$stub/count"
  out=$(cd "$repo" && PATH="$stub:$PATH" STUB_MODE="$mode" STUB_COUNTER="$stub/count" \
        MIN_AS_KB=0 "$target" 2>&1)
  rc=$?
  if [ "$rc" -ne "$want_rc" ]; then
    printf 'FAIL %s: exit %s (wanted %s)\n%s\n' "$name" "$rc" "$want_rc" "$out"; fail=1; return
  fi
  if ! printf '%s' "$out" | grep -q "$want"; then
    printf 'FAIL %s: no match for %q\n%s\n' "$name" "$want" "$out"; fail=1; return
  fi
  printf 'ok   %s (exit %s)\n' "$name" "$rc"
}

check "green suite passes"        0 "PASS: 45s ui timeout in force"     pass
check "starvation timeout fails"  1 "still being aborted on a timeout"  timeout
check "part 1 red stops early"    1 "testTimeout is not above 21s"      red
check "part 2 red stops"          1 "suite exited non-zero"             red2

# The real guard, with the real limit in force, must refuse before touching Node.
out=$(cd "$repo" && "$target" 2>&1); rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "REFUSING: RLIMIT_AS"; then
  printf 'ok   refuses inside the 256MB cap (exit 2)\n'
else
  printf 'FAIL guard: exit %s\n%s\n' "$rc" "$out"; fail=1
fi

# The temp test must never survive a run, pass or fail.
if [ -e "$repo/apps/desktop/src/__timeout_proof.test.ts" ]; then
  printf 'FAIL leftover proof test file\n'; fail=1
else
  printf 'ok   no leftover test file\n'
fi

rm -rf "$stub"
[ "$fail" -eq 0 ] && echo "ALL HARNESS CHECKS PASSED"
exit "$fail"
