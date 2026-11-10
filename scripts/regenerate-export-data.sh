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

# host-entrypoint.sh points host.factorio_directory here when the host has no game
# client (FACTORIO_HOME in Dockerfile.host). Only this exact path is treated as
# headless, so a custom Factorio layout is never refused. It is an inference from
# configuration, not a look at the host's files: a host NOT built from these images
# that has the full game at this path is refused too, and needs --allow-headless.
HEADLESS_FACTORIO_DIR="/opt/factorio"

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
# Each clusterioctl answer is captured whole before it is parsed. Parsing it through
# a pipe that stops reading early (awk exit, grep -q) can break the writer's pipe,
# and under pipefail that turns a good answer into a failed lookup.
export_host_factorio_dir() {
  local instances host_id config dir
  instances=$(lookup instance list) || return 1
  host_id=$(awk -F'|' -v i="$INSTANCE" \
    'function t(s){gsub(/^ +| +$/,"",s);return s} NR>2 && t($1)==i && !found {print t($3); found=1}' <<<"$instances")
  [[ "$host_id" =~ ^[0-9]+$ ]] || return 1
  config=$(lookup host config list "$host_id") || return 1
  dir=$(sed -nE 's/^host\.factorio_directory[[:space:]]+"?([^"]*)"?[[:space:]]*$/\1/p' <<<"$config" | head -1)
  [ -n "$dir" ] || return 1
  printf '%s\n' "$dir"
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
