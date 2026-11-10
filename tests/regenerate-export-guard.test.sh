#!/bin/bash
# regenerate-export-guard.test.sh
#
# Asserts scripts/regenerate-export-data.sh refuses to export from a headless host
# (which would replace the mod pack's export manifest with blank icons) unless
# --allow-headless is given, that a refusal issues no mutating clusterioctl call, and
# that "host is headless" (exit 3) stays distinguishable from "could not tell" (exit 4).
# `npx`, `gosu` and `sleep` are shimmed onto PATH and every clusterioctl call is recorded.
#
# requires: bash, coreutils (timeout)
# produces: exit 0 when every case holds, exit 1 with the call log dumped
# does not: run Docker, a cluster, or any real clusterioctl — it checks which calls
#           the script issues for a given host answer, not what Clusterio does with
#           them. The integration suite covers the headless path for real; the
#           client-host path is only covered here.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/regenerate-export-data.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $*"; }

mkdir -p "$WORK/bin"

# gosu runs a command as another user; here it just drops the user argument.
cat > "$WORK/bin/gosu" <<'SH'
#!/bin/bash
shift
exec "$@"
SH

# The script pauses between stop and export; nothing here needs the wait.
cat > "$WORK/bin/sleep" <<'SH'
#!/bin/bash
exit 0
SH

# clusterioctl stand-in. Records every invocation and answers the two lookups in
# clusterioctl's real output shapes (`instance list`: name in column 1, assigned
# host in column 3, no leading pipe; `host config list`: `field "json-value"`).
#   STUB_ASSIGNED_HOST   assignedHost cell for TestInstance (may be empty)
#   STUB_FACTORIO_DIR    host.factorio_directory the host reports
#   STUB_HOST_CONFIG_RC  exit status of `host config list` (non-zero = host unreachable)
cat > "$WORK/bin/npx" <<'SH'
#!/bin/bash
if [ "${1:-}" != "clusterioctl" ]; then
  exec command npx "$@"
fi
shift
printf '%s\n' "$*" >> "$CALL_LOG"

case "$*" in
  *"instance list"*)
    echo "name         | id         | assignedHost | gamePort | status  | factorioVersion"
    echo "------------------------------------------------------------------------------"
    printf '%-12s | %-10s | %-12s | %-8s | %-7s | %s\n' TestInstance 1082479306 "${STUB_ASSIGNED_HOST-1}" 34100 running 2.1.8
    printf '%-12s | %-10s | %-12s | %-8s | %-7s | %s\n' OtherInst 643100222 2 34200 running 2.1.8
    ;;
  *"host config list"*)
    [ "${STUB_HOST_CONFIG_RC:-0}" = "0" ] || exit "${STUB_HOST_CONFIG_RC}"
    echo 'host.name "clusterio-host-1"'
    echo "host.factorio_directory \"${STUB_FACTORIO_DIR}\""
    echo 'host.instances_directory "/clusterio/data/instances"'
    ;;
esac
exit 0
SH

chmod +x "$WORK/bin/gosu" "$WORK/bin/sleep" "$WORK/bin/npx"

CALL_LOG="$WORK/calls.log"

# run_case <expected-exit> <env assignments...> -- <script args...>
# Leaves the script output in $WORK/out and the calls in $CALL_LOG.
run_case() {
  local expected="$1"; shift
  local -a envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  : > "$CALL_LOG"
  set +e
  env PATH="$WORK/bin:$PATH" CALL_LOG="$CALL_LOG" CONTROL_CONFIG="$WORK/config-control.json" \
    "${envs[@]}" bash "$SCRIPT" "$@" > "$WORK/out" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -ne "$expected" ]; then
    echo "  exit $rc, expected $expected; output:"; sed 's/^/    /' "$WORK/out"
    return 1
  fi
}

mutated() { grep -qE "instance (stop|export-data|start) " "$CALL_LOG"; }
exported() { grep -qF "instance export-data TestInstance" "$CALL_LOG"; }
dump() { echo "--- recorded clusterioctl calls ---" >&2; sed 's/^/    /' "$CALL_LOG" >&2; }

echo "=== Case 1: host with the game client — exports ==="
if run_case 0 STUB_FACTORIO_DIR=/opt/factorio-client -- TestInstance \
   && exported \
   && grep -qF "instance stop TestInstance" "$CALL_LOG" \
   && grep -qF "instance start TestInstance" "$CALL_LOG"; then
  pass "client host: stop, export-data and start were issued"
else
  fail "client host was not exported"; dump
fi
if grep -qF "host config list 1" "$CALL_LOG"; then
  pass "the assigned host (column 3 of instance list) was the one queried"
else
  fail "host config was not read for the assigned host"; dump
fi

echo "=== Case 2: headless host — refused, nothing changed ==="
if run_case 3 STUB_FACTORIO_DIR=/opt/factorio -- TestInstance && ! mutated; then
  pass "headless host: exit 3 and no stop/export-data/start"
else
  fail "headless host was not refused cleanly"; dump
fi
if grep -qF -- "--allow-headless" "$WORK/out"; then
  pass "the refusal names the override flag"
else
  fail "the refusal does not mention --allow-headless"
fi

echo "=== Case 3: headless host with --allow-headless — exports ==="
if run_case 0 STUB_FACTORIO_DIR=/opt/factorio -- TestInstance --allow-headless && exported; then
  pass "override exports from a headless host"
else
  fail "--allow-headless did not export"; dump
fi
if run_case 0 STUB_FACTORIO_DIR=/opt/factorio -- --allow-headless TestInstance && exported; then
  pass "override is accepted before the instance name too"
else
  fail "--allow-headless before the instance name did not export"; dump
fi

echo "=== Case 4: the lookup cannot answer — refused (fails closed) ==="
if run_case 4 STUB_FACTORIO_DIR=/opt/factorio-client STUB_ASSIGNED_HOST= -- TestInstance && ! mutated; then
  pass "unassigned instance: exit 4 and nothing changed"
else
  fail "unassigned instance was not refused"; dump
fi
if run_case 4 STUB_FACTORIO_DIR=/opt/factorio-client -- NoSuchInstance && ! mutated; then
  pass "unknown instance: exit 4 and nothing changed"
else
  fail "unknown instance was not refused"; dump
fi
if run_case 4 STUB_FACTORIO_DIR=/opt/factorio-client STUB_HOST_CONFIG_RC=1 -- TestInstance && ! mutated; then
  pass "unreachable host: exit 4 and nothing changed"
else
  fail "unreachable host was not refused"; dump
fi

echo "=== Case 5: only the image's headless path is refused ==="
if run_case 0 STUB_FACTORIO_DIR=/srv/factorio -- TestInstance && exported; then
  pass "a custom Factorio directory is not treated as headless"
else
  fail "a custom Factorio directory was refused"; dump
fi
if run_case 0 STUB_FACTORIO_DIR=/opt/factorio-custom -- TestInstance && exported; then
  pass "a path that merely starts with /opt/factorio is not treated as headless"
else
  fail "prefix match: /opt/factorio-custom was refused"; dump
fi

echo "=== Case 6: usage errors ==="
if run_case 2 -- && ! mutated; then pass "no instance name: exit 2"; else fail "missing instance name not rejected"; fi
if run_case 2 -- TestInstance --force && ! mutated; then pass "unknown option: exit 2"; else fail "unknown option not rejected"; fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "regenerate-export guard test: $FAILURES failure(s)" >&2
  exit 1
fi
echo "regenerate-export guard test: all checks passed"
