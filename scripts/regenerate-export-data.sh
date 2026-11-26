#!/bin/bash
# regenerate-export-data.sh — refresh the web UI's icon/prototype export.
#
# Run this after ANY Factorio/client/mod-pack version change: the seed-time
# auto-export runs once per first boot only, so a version bump otherwise ships
# stale prototypes and icons until someone remembers this sequence
# (docs/asset-export.md).
#
# Usage (inside the controller container):
#   docker exec clusterio-controller /scripts/regenerate-export-data.sh <instance-name> [--allow-headless]
#
# The instance should live on a host with the full game client (see EXPORT_HOST).
# A headless host exports successfully too, but exports no icons (only the host's
# log says so) — and an export REPLACES the mod pack's export manifest, so it would
# silently wipe the icons of an earlier client export. The script therefore refuses
# a headless host unless --allow-headless is given.
#
# Exit codes: 0 exported, 1 export failed, 2 usage, 3 refused: host is headless,
# 4 refused: could not determine the host's Factorio directory. 3 and 4 change nothing.
set -eo pipefail

usage() {
  echo "usage: regenerate-export-data.sh <instance-name> [--allow-headless]" >&2
  exit 2
}

INSTANCE=""
ALLOW_HEADLESS=false
for arg in "$@"; do
  case "$arg" in
    --allow-headless) ALLOW_HEADLESS=true ;;
    -*) echo "ERROR: unknown option '$arg'" >&2; usage ;;
    *) [ -z "$INSTANCE" ] || usage; INSTANCE="$arg" ;;
  esac
done
[ -n "$INSTANCE" ] || usage

CONTROL_CONFIG="${CONTROL_CONFIG:-/clusterio/tokens/config-control.json}"

# HEADLESS_FACTORIO_DIR and host_factorio_dir: what counts as a headless host, shared
# with seed-instances.sh. A host NOT built from these images that has the full game
# at that path is refused too, and needs --allow-headless.
# shellcheck source=scripts/export-host-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/export-host-lib.sh"

# Every call is time-bounded: clusterioctl has no client-side timeout and waits forever
# on a controller that does not answer. Seconds; see seed-instances.sh for the three limits.
CTL_LOOKUP_TIMEOUT="${CTL_LOOKUP_TIMEOUT:-25}"
CTL_ACTION_TIMEOUT="${CTL_ACTION_TIMEOUT:-120}"
CTL_TRANSFER_TIMEOUT="${CTL_TRANSFER_TIMEOUT:-1800}"

# ctl <seconds> <clusterioctl arguments...>
ctl() {
  local limit="$1"; shift
  timeout -k 5 "$limit" gosu clusterio npx clusterioctl --log-level error "$@" --config "$CONTROL_CONFIG"
}

lookup() {
  ctl "$CTL_LOOKUP_TIMEOUT" "$@" 2>/dev/null
}

restart_and_fail() {
  echo "Restarting '$INSTANCE' anyway..."
  ctl "$CTL_ACTION_TIMEOUT" instance start "$INSTANCE" >/dev/null 2>&1 || true
  exit 1
}

# Prints host.factorio_directory of the host the instance is assigned to.
# Fails when the instance is unknown or unassigned, or its host does not answer.
#
# The instance list is captured whole before it is parsed, for the reason given at
# host_factorio_dir in export-host-lib.sh.
export_host_factorio_dir() {
  local instances host_id
  instances=$(lookup instance list --output json) || return 1
  host_id=$(node "$SCRIPT_LIB_DIR/ctl-json.cjs" instance "$INSTANCE" assignedHost <<<"$instances" 2>/dev/null) \
    || return 1
  [[ "$host_id" =~ ^[0-9]+$ ]] || return 1
  host_factorio_dir "$host_id" "$CONTROL_CONFIG"
}

# Checked BEFORE the instance is stopped, so a refusal leaves everything as it was.
if [ "$ALLOW_HEADLESS" = "true" ]; then
  echo "NOTE: --allow-headless given — host check skipped. If the host of '$INSTANCE' has no game client, this export will contain no icons (the host's log says so)."
else
  if ! factorio_dir=$(export_host_factorio_dir); then
    echo "ERROR: could not determine whether the host of '$INSTANCE' has the game client (is the instance assigned, and its host connected?)." >&2
    echo "       Not exporting: a headless export would replace the mod pack's export manifest with one that has no icons." >&2
    echo "       Pass --allow-headless to export regardless (docs/asset-export.md)." >&2
    exit 4
  fi
  if [ "$factorio_dir" = "$HEADLESS_FACTORIO_DIR" ]; then
    echo "ERROR: the host of '$INSTANCE' looks headless: host.factorio_directory is $factorio_dir, the directory" >&2
    echo "       these images use when no game client is installed." >&2
    echo "       Not exporting: a headless export succeeds but exports no icons (only the host's log says so), and" >&2
    echo "       it would replace the mod pack's export manifest — wiping the icons of any earlier client export." >&2
    echo "       Use an instance on a host with the game client (EXPORT_HOST), or pass --allow-headless to refresh" >&2
    echo "       prototypes, locale and settings without icons. Also pass it if this host is not built from" >&2
    echo "       these images and really has the full game installed at that path (docs/asset-export.md)." >&2
    exit 3
  fi
fi

echo "Stopping '$INSTANCE' for export-data..."
ctl "$CTL_ACTION_TIMEOUT" instance stop "$INSTANCE" >/dev/null 2>&1 || true
sleep 5

echo "Running export-data on '$INSTANCE'..."
tries=0
while :; do
  export_rc=0
  ctl "$CTL_TRANSFER_TIMEOUT" instance export-data "$INSTANCE" >/dev/null || export_rc=$?
  if [ "$export_rc" -eq 0 ]; then
    break
  fi
  # timeout's own statuses: stopped at the limit (124), or killed after ignoring that (137).
  # An export that ran into the limit is not "not ready yet": trying again would only wait
  # that long again.
  if [ "$export_rc" -eq 124 ] || [ "$export_rc" -eq 137 ]; then
    echo "ERROR: export-data did not finish within ${CTL_TRANSFER_TIMEOUT}s and was stopped — check the log of the instance's host (docs/asset-export.md)" >&2
    restart_and_fail
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 6 ]; then
    echo "ERROR: export-data failed after $tries attempts — check the log of the instance's host (docs/asset-export.md)" >&2
    restart_and_fail
  fi
  echo "  not ready yet, retrying in 10s... ($tries/6)"
  sleep 10
done
echo "Export complete."

echo "Restarting '$INSTANCE'..."
ctl "$CTL_ACTION_TIMEOUT" instance start "$INSTANCE" >/dev/null 2>&1 || true
echo "Done — the web UI serves the refreshed assets."
