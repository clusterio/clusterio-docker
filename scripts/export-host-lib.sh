#!/bin/bash
# export-host-lib.sh — sourced by seed-instances.sh and regenerate-export-data.sh.
#
# The controller-side definition of "this host looks headless". An export from a host
# without the Factorio game client succeeds but exports no icons (only the host's log
# says why), so both scripts need to tell which kind of host an export ran on, or is
# about to run on.

# The JSON helpers sit beside this file: /scripts in the image, scripts/ in the tests.
SCRIPT_LIB_DIR="$(dirname "${BASH_SOURCE[0]}")"

# The directory host-entrypoint.sh points host.factorio_directory at when the host has
# no game client. KEEP IN SYNC with FACTORIO_HOME in Dockerfile.host — that ENV lives in
# the host image, which this (controller-side) file cannot read.
#
# The check is an inference from configuration, not a look at the host's files: only
# this exact path counts as headless, so a custom Factorio layout never does — but a
# host NOT built from these images that has the full game at this path does.
HEADLESS_FACTORIO_DIR="/opt/factorio"

# host_factorio_dir <host-id> <control-config>
# Prints the host's host.factorio_directory. Fails if the host does not answer or
# reports none.
#
# The clusterioctl call is time-bounded (it has no client-side timeout and hangs on an
# unreachable controller), and its answer is captured whole before it is parsed:
# parsing through a pipe that stops reading early can break the writer's pipe, and
# under pipefail that turns a good answer into a failed lookup.
host_factorio_dir() {
  local config dir
  config=$(timeout 25 gosu clusterio npx clusterioctl --log-level error host config list "$1" \
    --output json --config "$2" 2>/dev/null) || return 1
  dir=$(node "$SCRIPT_LIB_DIR/ctl-json.cjs" field host.factorio_directory <<<"$config" 2>/dev/null) || return 1
  [ -n "$dir" ] || return 1
  printf '%s\n' "$dir"
}
