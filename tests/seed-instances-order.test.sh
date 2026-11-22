#!/bin/bash
# seed-instances-order.test.sh
#
# Asserts seed-instances.sh never pushes instance config after `instance assign`,
# addresses each seed folder's host by the id its token names (falling back to the
# host's name, then id N), and gives up at once on a start the controller refuses for
# missing plugin mods. `npx` and `gosu` are shimmed onto PATH and every clusterioctl
# call is recorded.
#
# requires: bash, node (seed-instances.sh parses instance.json and clusterioctl's JSON
#           with it), coreutils
# produces: exit 0 when the ordering holds, exit 1 with the call log dumped
# does not: run Docker, a cluster, or any real clusterioctl — it checks which calls
#           the script issues and in what order, not what Clusterio does with them.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_SCRIPT="$REPO_ROOT/scripts/seed-instances.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
fail() { echo "FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "PASS: $*"; }

# The order checker. Separate from the run so cases 2 and 3 can drive it directly.
#
# `|| true`: "no such call" is an answer here, not an error — without it a
# non-matching grep aborts the test under `set -e` + pipefail.
first_line() { grep -nF -- "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1 || true; }
last_line()  { grep -nF -- "$2" "$1" 2>/dev/null | tail -1 | cut -d: -f1 || true; }

# check_order <log> <instance-name> <expect-config: yes|no>
# Echoes the reasons it rejected the log; returns 0 only if every rule holds.
check_order() {
  local log="$1" name="$2" expect_config="$3"
  local create assign upload start last_config rc=0

  create=$(first_line "$log" "instance create $name")
  assign=$(first_line "$log" "instance assign $name")
  upload=$(first_line "$log" "instance save upload $name")
  start=$(first_line "$log" "instance start $name")
  last_config=$(last_line "$log" "instance config set $name")

  # Presence first: an empty or mis-shimmed log has nothing to compare, so every
  # ordering rule below would hold vacuously.
  for req in create:"$create" assign:"$assign" upload:"$upload" start:"$start"; do
    if [ -z "${req#*:}" ]; then
      echo "  no '${req%%:*}' call recorded for $name"
      rc=1
    fi
  done
  if [ "$expect_config" = "yes" ] && [ -z "$last_config" ]; then
    echo "  no 'instance config set' recorded for $name (instance.json was not applied)"
    rc=1
  fi
  [ "$rc" -eq 0 ] || return 1

  # The property: every config push precedes the assign.
  if [ -n "$last_config" ] && [ "$last_config" -gt "$assign" ]; then
    echo "  config set for $name at line $last_config is AFTER assign at line $assign"
    rc=1
  fi
  # upload and start both need an assigned host, so they stay after assign.
  [ "$create" -lt "$assign" ] || { echo "  create ($create) is not before assign ($assign)"; rc=1; }
  [ "$upload" -gt "$assign" ] || { echo "  save upload ($upload) is not after assign ($assign)"; rc=1; }
  [ "$start" -gt "$upload" ]  || { echo "  start ($start) is not after save upload ($upload)"; rc=1; }
  return "$rc"
}

# ---------------------------------------------------------------------------
# Case 1 — a real run of scripts/seed-instances.sh against shimmed tooling
# ---------------------------------------------------------------------------
echo "=== Case 1: real seed-instances.sh run, clusterioctl shimmed ==="

CALL_LOG="$WORK/calls.log"
: > "$CALL_LOG"

mkdir -p "$WORK/bin"

# gosu runs a command as another user; here it just drops the user argument.
cat > "$WORK/bin/gosu" <<'SH'
#!/bin/bash
shift
exec "$@"
SH

# clusterioctl stand-in. Records every invocation and answers the lookups in
# clusterioctl 2.1's `--output json` shapes, so the script's own parsing is
# exercised as written. Without `--output json` a list gets a table, which that
# parsing rejects. Commands with no result print what clusterioctl prints for them.
#   STUB_HOSTS       `host list` answer (JSON array)
#   STUB_HOSTS_FAIL  when set, `host list` fails the way clusterioctl does in JSON mode
#   STUB_START_ERR   when set, `instance start` prints it on stderr and exits 1
cat > "$WORK/bin/npx" <<'SH'
#!/bin/bash
if [ "${1:-}" != "clusterioctl" ]; then
  exec command npx "$@"
fi
shift
printf '%s\n' "$*" >> "$CALL_LOG"

json=false
case " $* " in *" --output json "*) json=true ;; esac
args="$*"
case "$args" in
  *"instance list"*|*"host list"*|*"host config list"*)
    if [ "$json" != "true" ]; then
      echo "name         | id    | assignedHost | gamePort | status"
      exit 0
    fi
    ;;
esac
case "$args" in
  *"host list"*)
    if [ -n "${STUB_HOSTS_FAIL:-}" ]; then
      echo '{"error":"CommandError","message":"Session timed out"}'
      exit 1
    fi
    printf '%s\n' "${STUB_HOSTS:-[]}"
    ;;
  *"host config list"*)
    printf '{"host.name":"clusterio-host-1","host.factorio_directory":"/opt/factorio"}\n'
    ;;
  *"instance list"*)
    sep="" out="["
    while IFS= read -r line; do
      case "$line" in
        *"instance create "*)
          n="${line##*instance create }"; n="${n%% *}"
          status=stopped
          [ -z "${STUB_START_ERR:-}" ] && grep -qF "instance start $n" "$CALL_LOG" && status=running
          out+="$sep{\"name\":\"$n\",\"id\":254111007,\"status\":\"$status\",\"factorioVersion\":\"latest\",\"startedAtMs\":0}"
          sep=","
          ;;
      esac
    done < "$CALL_LOG"
    printf '%s]\n' "$out"
    ;;
  *"instance start"*)
    if [ -n "${STUB_START_ERR:-}" ]; then
      printf '%s\n' "$STUB_START_ERR" >&2
      exit 1
    fi
    if [ "$json" = "true" ]; then echo '{"success":true}'; else echo "Command ran successfully"; fi
    ;;
  *)
    if [ "$json" = "true" ]; then echo '{"success":true}'; else echo "Command ran successfully"; fi
    ;;
esac
exit 0
SH

chmod +x "$WORK/bin/gosu" "$WORK/bin/npx"

# A host token as provision-hosts.cjs writes it: only the payload's `host` claim matters here.
fake_token() {
  node -e 'console.log("x." + Buffer.from(JSON.stringify({aud: "host", host: Number(process.argv[1])})).toString("base64url") + ".y")' "$1"
}

# run_seed <dir> <host-count> <env assignments...>
# Runs seed-instances.sh on the fixture tree <dir>/seed-data with tokens from
# <dir>/tokens. Leaves the output in <dir>/run.out, the calls in <dir>/calls.log
# and the exit status in $run_rc.
run_seed() {
  local dir="$1" count="$2"; shift 2
  : > "$dir/calls.log"
  mkdir -p "$dir/tokens"
  set +e
  env PATH="$WORK/bin:$PATH" CALL_LOG="$dir/calls.log" SEED_DATA_DIR="$dir/seed-data" \
    TOKENS_DIR="$dir/tokens" "$@" bash "$SEED_SCRIPT" "$WORK/config-control.json" "$count" > "$dir/run.out" 2>&1
  run_rc=$?
  set -e
}

# AutoInstance's instance.json has parseable fields, so config IS applied and the
# ordering has something to violate. NoConfigInstance is single-line JSON, which the
# script's line-based parser yields no fields from, and it stays stopped.
mkdir -p "$WORK/seed-data/hosts/clusterio-host-1/AutoInstance"
mkdir -p "$WORK/seed-data/hosts/clusterio-host-1/NoConfigInstance"
cat > "$WORK/seed-data/hosts/clusterio-host-1/AutoInstance/instance.json" <<'JSON'
{
	"instance.id": 1234,
	"instance.name": "AutoInstance",
	"instance.assigned_host": 9,
	"instance.auto_start": true,
	"factorio.settings": { "auto_pause": false, "name": "seed order fixture" },
	"factorio.enable_whitelist": false
}
JSON
echo '{"instance.auto_start": false}' > "$WORK/seed-data/hosts/clusterio-host-1/NoConfigInstance/instance.json"
: > "$WORK/seed-data/hosts/clusterio-host-1/AutoInstance/world.zip"
: > "$WORK/seed-data/hosts/clusterio-host-1/NoConfigInstance/world.zip"

echo '{}' > "$WORK/config-control.json"

# A cluster set up before Clusterio 2.1: clusterio-host-1 has id 1. No token file.
UPGRADED_HOSTS='[{"version":"2.1.1","name":"clusterio-host-1","id":1,"connected":true,"tokenValidAfter":0,"isDeleted":false}]'

run_log="$WORK/run.out"
run_seed "$WORK" 0 STUB_HOSTS="$UPGRADED_HOSTS"

if [ "$run_rc" -ne 0 ]; then
  fail "seed-instances.sh exited $run_rc under the stubs"
  sed 's/^/    /' "$run_log" >&2
else
  pass "seed-instances.sh completed under the stubs"
fi

echo "--- recorded clusterioctl calls ---"
sed 's/^/    /' "$CALL_LOG"
echo "-----------------------------------"

if reasons=$(check_order "$CALL_LOG" AutoInstance yes); then
  pass "AutoInstance: every config push precedes assign; upload and start follow it"
else
  fail "AutoInstance ordering violated"
  printf '%s\n' "$reasons" >&2
fi

if grep -qF "instance start NoConfigInstance" "$CALL_LOG"; then
  fail "NoConfigInstance was started despite instance.auto_start=false"
else
  pass "NoConfigInstance was not started (auto_start=false honoured)"
fi

assign_line=$(first_line "$CALL_LOG" "instance assign NoConfigInstance")
late_config=$(last_line "$CALL_LOG" "instance config set NoConfigInstance")
if [ -z "$assign_line" ]; then
  fail "NoConfigInstance was never assigned — harness did not exercise it"
elif [ -n "$late_config" ] && [ "$late_config" -gt "$assign_line" ]; then
  fail "NoConfigInstance config set at line $late_config is after assign at line $assign_line"
else
  pass "NoConfigInstance: no config push after assign"
fi

# Catch-all over every instance in the fixture, including ones added later or a
# refactor that batches all assigns ahead of configuration.
last_assign=$(last_line "$CALL_LOG" "instance assign ")
last_any_config=$(last_line "$CALL_LOG" "instance config set ")
if [ -n "$last_any_config" ] && [ -n "$last_assign" ] && [ "$last_any_config" -gt "$last_assign" ]; then
  fail "some 'instance config set' (line $last_any_config) runs after the last assign (line $last_assign)"
else
  pass "no 'instance config set' anywhere after the last assign"
fi

if grep -qE "instance assign AutoInstance 1( |\$)" "$CALL_LOG"; then
  pass "without a token file, clusterio-host-1 is addressed by the one host of that name (id 1)"
else
  fail "AutoInstance was not assigned to host id 1"
fi

if grep -qF "Command ran successfully" "$run_log"; then
  fail "clusterioctl's 'Command ran successfully' reached the seeding log"
  sed 's/^/    /' "$run_log" >&2
else
  pass "clusterioctl's no-result output is kept out of the seeding log"
fi

# A second run against the same cluster (the stub derives `instance list` from the
# calls already made) must create nothing.
cp "$CALL_LOG" "$WORK/rerun.log"
set +e
env PATH="$WORK/bin:$PATH" CALL_LOG="$WORK/rerun.log" SEED_DATA_DIR="$WORK/seed-data" \
  TOKENS_DIR="$WORK/tokens" STUB_HOSTS="$UPGRADED_HOSTS" \
  bash "$SEED_SCRIPT" "$WORK/config-control.json" 0 > "$WORK/rerun.out" 2>&1
rerun_rc=$?
set -e
if [ "$rerun_rc" -eq 0 ] && [ "$(grep -c "instance create " "$WORK/rerun.log")" -eq 2 ] \
   && [ "$(grep -c "already exists" "$WORK/rerun.out")" -eq 2 ]; then
  pass "a rerun skips both existing instances"
else
  fail "a rerun did not skip the existing instances (exit $rerun_rc)"
  sed 's/^/    /' "$WORK/rerun.out" >&2
fi

# ---------------------------------------------------------------------------
# Case 2 — the checker rejects the pre-fix order (teeth)
# ---------------------------------------------------------------------------
echo "=== Case 2: checker must reject the pre-fix order ==="
cat > "$WORK/old-order.log" <<'LOG'
--log-level error instance list
--log-level error instance create AutoInstance
--log-level error instance assign AutoInstance 1
--log-level error instance config set AutoInstance factorio.settings {}
--log-level error instance save upload AutoInstance /seed/world.zip
--log-level error instance start AutoInstance
LOG
if check_order "$WORK/old-order.log" AutoInstance yes >/dev/null 2>&1; then
  fail "checker accepted a log with config set AFTER assign — it has no teeth"
else
  pass "checker rejects config set after assign"
fi

# ---------------------------------------------------------------------------
# Case 3 — a silent harness break must be loud, not a vacuous pass
# ---------------------------------------------------------------------------
echo "=== Case 3: empty and partial logs must fail, not pass vacuously ==="
: > "$WORK/empty.log"
if check_order "$WORK/empty.log" AutoInstance yes >/dev/null 2>&1; then
  fail "checker accepted an EMPTY call log"
else
  pass "checker rejects an empty call log"
fi

cat > "$WORK/no-config.log" <<'LOG'
--log-level error instance create AutoInstance
--log-level error instance assign AutoInstance 1
--log-level error instance save upload AutoInstance /seed/world.zip
--log-level error instance start AutoInstance
LOG
if check_order "$WORK/no-config.log" AutoInstance yes >/dev/null 2>&1; then
  fail "checker accepted a log where instance.json was never applied at all"
else
  pass "checker rejects a log with no config push (instance.json silently skipped)"
fi

# ---------------------------------------------------------------------------
# Cases 4-7 — host addressing and start errors, one instance each
# ---------------------------------------------------------------------------
# fixture <dir> <instance>: clusterio-host-1/<instance> with a save and no
# instance.json, so it auto-starts.
fixture() {
  mkdir -p "$1/seed-data/hosts/clusterio-host-1/$2" "$1/tokens"
  : > "$1/seed-data/hosts/clusterio-host-1/$2/world.zip"
}
dump_run() { sed 's/^/    /' "$1/run.out" >&2; echo "  calls:" >&2; sed 's/^/    /' "$1/calls.log" >&2; }

echo "=== Case 4: the token file's host claim picks the host ==="
# Two hosts share the name and id 1 exists too: only the token can pick 933475968.
# EXPORT_HOST names the host number, so this host exports; the stubbed host reports
# the headless Factorio directory.
D="$WORK/case-token"
fixture "$D" TokenInstance
fake_token 933475968 > "$D/tokens/clusterio-host-1.token"
run_seed "$D" 1 EXPORT_HOST=1 \
  STUB_HOSTS='[{"name":"clusterio-host-1","id":1,"connected":true},{"name":"clusterio-host-1","id":933475968,"connected":true}]'
if [ "$run_rc" -eq 0 ] && grep -qE "instance assign TokenInstance 933475968( |\$)" "$D/calls.log"; then
  pass "instance assign receives the id the token file was issued for"
else
  fail "TokenInstance was not assigned to the token's host (exit $run_rc)"; dump_run "$D"
fi
if grep -qF "All hosts connected" "$D/run.out" && grep -qF "clusterio-host-1 (id 933475968)" "$D/run.out"; then
  pass "connected hosts are counted from the JSON host list; logs name the host and its id"
else
  fail "host wait or host log line is wrong"; dump_run "$D"
fi
if grep -qF "instance export-data TokenInstance" "$D/calls.log" \
   && grep -qE "host config list 933475968( |\$)" "$D/calls.log" \
   && grep -qF "NOTE: host clusterio-host-1 (id 933475968) looks headless" "$D/run.out"; then
  pass "EXPORT_HOST=1 exports from clusterio-host-1 and checks that host's directory by its id"
else
  fail "the export host was not matched by number or not checked by id"; dump_run "$D"
fi
if grep -qF "Command ran successfully" "$D/run.out"; then
  fail "clusterioctl's 'Command ran successfully' reached the seeding log"; dump_run "$D"
else
  pass "export-data's no-result output is kept out of the seeding log"
fi

echo "=== Case 5: no token file, a host has id N ==="
# The host with id 1 was renamed, so neither the token nor the name can pick it.
D="$WORK/case-number"
fixture "$D" NumberInstance
run_seed "$D" 0 STUB_HOSTS='[{"name":"renamed by operator","id":1,"connected":true},{"name":"clusterio-host-2","id":5,"connected":true}]'
if [ "$run_rc" -eq 0 ] && grep -qE "instance assign NumberInstance 1( |\$)" "$D/calls.log"; then
  pass "clusterio-host-1 falls back to the host with id 1"
else
  fail "NumberInstance was not assigned to host id 1 (exit $run_rc)"; dump_run "$D"
fi

echo "=== Case 6: no registered host matches the folder ==="
D="$WORK/case-unresolved"
fixture "$D" OrphanInstance
run_seed "$D" 0 STUB_HOSTS='[{"name":"clusterio-host-2","id":77,"connected":true}]'
if [ "$run_rc" -ne 0 ] && grep -qF "ERROR: no registered host matches seed folder 'clusterio-host-1'" "$D/run.out" \
   && ! grep -qF "instance create" "$D/calls.log"; then
  pass "unresolvable host: ERROR, non-zero exit, no instance created"
else
  fail "an unresolvable host was not reported as a failure (exit $run_rc)"; dump_run "$D"
fi

echo "=== Case 7: a start refused for missing plugin mods is not retried ==="
D="$WORK/case-mods"
fixture "$D" ModsInstance
MODS_ERR="[error] Error sending request: Mod pack Base Game 2.1 does not have the mods required by the loaded plugins. Plugin subspace_storage requires subspace_storage >= 1.99.0 (missing). Add the mods to the mod pack or set <plugin>.load_plugin to false for this instance."
started_at=$SECONDS
run_seed "$D" 0 STUB_HOSTS="$UPGRADED_HOSTS" STUB_START_ERR="$MODS_ERR"
elapsed=$((SECONDS - started_at))
starts=$(grep -c "instance start ModsInstance" "$D/calls.log" || true)
if [ "$run_rc" -eq 0 ] && [ "$starts" -eq 1 ] && [ "$elapsed" -lt 60 ]; then
  pass "one start attempt, no 120s wait, and still only a WARNING (exit 0)"
else
  fail "start attempts: $starts, elapsed ${elapsed}s, exit $run_rc"; dump_run "$D"
fi
if grep -qF "WARNING: instance 'ModsInstance' cannot start" "$D/run.out" \
   && grep -qF "        $MODS_ERR" "$D/run.out"; then
  pass "the controller's refusal is printed, indented under the WARNING"
else
  fail "the required-mods error was not printed"; dump_run "$D"
fi

echo "=== Case 8: any other start failure is retried, then reported with its error ==="
D="$WORK/case-start"
fixture "$D" SlowInstance
START_ERR="[error] Error sending request: Host is not connected"
run_seed "$D" 0 STUB_HOSTS="$UPGRADED_HOSTS" STUB_START_ERR="$START_ERR" START_WAIT_SECONDS=8
starts=$(grep -c "instance start SlowInstance" "$D/calls.log" || true)
if [ "$run_rc" -eq 0 ] && [ "$starts" -ge 2 ] \
   && grep -qF "WARNING: instance 'SlowInstance' did not reach running within 8s" "$D/run.out" \
   && grep -qF "        $START_ERR" "$D/run.out"; then
  pass "the start is retried until the wait runs out, then the last error is printed (exit 0)"
else
  fail "start attempts: $starts, exit $run_rc, or the last start error is missing"; dump_run "$D"
fi

echo "=== Case 9: the controller does not list its hosts ==="
D="$WORK/case-nolist"
fixture "$D" UnlistedInstance
run_seed "$D" 0 STUB_HOSTS_FAIL=1
if [ "$run_rc" -ne 0 ] && grep -qF "ERROR: could not list the controller's hosts" "$D/run.out" \
   && ! grep -qF "no registered host matches" "$D/run.out" \
   && ! grep -qF "instance create" "$D/calls.log"; then
  pass "a failed host list is reported as such: non-zero exit, no instance created"
else
  fail "a failed host list was not reported correctly (exit $run_rc)"; dump_run "$D"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "seed ordering test: $FAILURES failure(s)" >&2
  exit 1
fi
echo "seed ordering test: all checks passed"
