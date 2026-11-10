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
# A headless host exports successfully too, but with a blank spritesheet — and an
# export REPLACES the mod pack's export manifest, so it would silently wipe the
# icons of an earlier client export. The script therefore refuses a headless host
# unless --allow-headless is given.
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

ctl() {
  gosu clusterio npx clusterioctl --log-level error "$@" --config "$CONTROL_CONFIG"
}

# Lookups are time-bounded: clusterioctl has no client-side timeout and hangs on
# an unreachable controller.
lookup() {
  timeout 25 gosu clusterio npx clusterioctl --log-level error "$@" --config "$CONTROL_CONFIG" 2>/dev/null
}

# Prints host.factorio_directory of the host the instance is assigned to.
# Fails when the instance is unknown or unassigned, or its host does not answer.
#
# The instance list is captured whole before it is parsed, for the reason given at
# host_factorio_dir in export-host-lib.sh.
export_host_factorio_dir() {
  local instances host_id
  instances=$(lookup instance list) || return 1
  host_id=$(awk -F'|' -v i="$INSTANCE" \
    'function t(s){gsub(/^ +| +$/,"",s);return s} NR>2 && t($1)==i && !found {print t($3); found=1}' <<<"$instances")
  [[ "$host_id" =~ ^[0-9]+$ ]] || return 1
  host_factorio_dir "$host_id" "$CONTROL_CONFIG"
}

# Checked BEFORE the instance is stopped, so a refusal leaves everything as it was.
if [ "$ALLOW_HEADLESS" = "true" ]; then
  echo "NOTE: --allow-headless given — host check skipped. If the host of '$INSTANCE' has no game client, every web-UI icon in this export will be blank."
else
  if ! factorio_dir=$(export_host_factorio_dir); then
    echo "ERROR: could not determine whether the host of '$INSTANCE' has the game client (is the instance assigned, and its host connected?)." >&2
    echo "       Not exporting: a headless export would replace the mod pack's export manifest with blank icons." >&2
    echo "       Pass --allow-headless to export regardless (docs/asset-export.md)." >&2
    exit 4
  fi
  if [ "$factorio_dir" = "$HEADLESS_FACTORIO_DIR" ]; then
    echo "ERROR: the host of '$INSTANCE' looks headless: host.factorio_directory is $factorio_dir, the directory" >&2
    echo "       these images use when no game client is installed." >&2
    echo "       Not exporting: a headless export succeeds but writes a blank spritesheet, and it would replace" >&2
    echo "       the mod pack's export manifest — wiping the icons of any earlier client export." >&2
    echo "       Use an instance on a host with the game client (EXPORT_HOST), or pass --allow-headless to refresh" >&2
    echo "       prototypes, locale and settings with blank icons. Also pass it if this host is not built from" >&2
    echo "       these images and really has the full game installed at that path (docs/asset-export.md)." >&2
    exit 3
  fi
fi

echo "Stopping '$INSTANCE' for export-data..."
ctl instance stop "$INSTANCE" 2>/dev/null || true
sleep 5

echo "Running export-data on '$INSTANCE'..."
tries=0
until ctl instance export-data "$INSTANCE"; do
  tries=$((tries + 1))
  if [ "$tries" -ge 6 ]; then
    echo "ERROR: export-data failed after $tries attempts — check the log of the instance's host (docs/asset-export.md)" >&2
    echo "Restarting '$INSTANCE' anyway..."
    ctl instance start "$INSTANCE" 2>/dev/null || true
    exit 1
  fi
  echo "  not ready yet, retrying in 10s... ($tries/6)"
  sleep 10
done
echo "Export complete."

echo "Restarting '$INSTANCE'..."
ctl instance start "$INSTANCE" 2>/dev/null || true
echo "Done — the web UI serves the refreshed assets."
