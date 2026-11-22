#!/bin/bash
# host-entrypoint.sh
set -eo pipefail

DATA_DIR="/clusterio/data"
CONFIG_PATH="$DATA_DIR/config-host.json"
TOKENS_DIR="/clusterio/tokens"
EXTERNAL_PLUGINS_DIR="/clusterio/external_plugins"
SEED_MODS_DIR="/clusterio/seed-mods"
HOST_MODS_DIR="/clusterio/mods"

# Use HOST_NAME env var, fallback to hostname
HOST_NAME="${HOST_NAME:-$(hostname)}"
# The number the host is named with (clusterio-host-1 -> 1). It names the token file, the
# default port range and the EXPORT_HOST match. The host id itself is assigned by the
# controller (Clusterio 2.1) and read back from the configuration before the host starts.
HOST_ID=$(echo "$HOST_NAME" | grep -oE '[0-9]+$' || echo "1")
TOKEN_FILE="$TOKENS_DIR/${HOST_NAME}.token"
MAX_WAIT_SECONDS=300
WAIT_INTERVAL=5

# Create data directory and fix permissions
mkdir -p "$DATA_DIR"
chown -R clusterio:clusterio "$DATA_DIR"

# Clean up stale lock files from an unclean shutdown (docker kill, OOM, a stop that
# outlasted its grace period). clusteriohost runs as PID 1, so its lock names PID 1,
# which in the restarted container is the new host itself: Clusterio's own staleness
# check then refuses to start ("a valid lock file exists") on every attempt. Assumes
# a single host per data volume (the supported topology), like the controller.
if compgen -G "$DATA_DIR/*.lock" > /dev/null 2>&1; then
  echo "Removing stale host lock file(s) from a previous run"
  rm -f "$DATA_DIR"/*.lock
fi

# Honest readiness: the healthcheck's connected-marker is per-boot state —
# clear any stale copy before the guard can re-establish it.
rm -f /run/clusterio-connected

# Mirror Clusterio's on-disk host log to stdout (CLUSTERIO_LOG_TO_STDOUT).
source /scripts/stream-logs.sh
start_log_streamer /clusterio/logs/host host

# Handle external plugins if mounted
source /scripts/install-plugins.sh
install_external_plugins "$EXTERNAL_PLUGINS_DIR"

# Pre-cache seed mods so the host doesn't need to download them from the controller.
# Runs on every startup (not just first run) since the mods dir may be ephemeral.
if [ -d "$SEED_MODS_DIR" ]; then
  shopt -s nullglob
  MOD_FILES=("$SEED_MODS_DIR"/*.zip)
  shopt -u nullglob
  if [ ${#MOD_FILES[@]} -gt 0 ]; then
    mkdir -p "$HOST_MODS_DIR"
    echo "Pre-caching ${#MOD_FILES[@]} mod(s) from seed data..."
    for mod_file in "${MOD_FILES[@]}"; do
      mod_name=$(basename "$mod_file")
      if [ ! -f "$HOST_MODS_DIR/$mod_name" ]; then
        cp "$mod_file" "$HOST_MODS_DIR/$mod_name"
        echo "  Cached: $mod_name"
      fi
    done
    chown -R clusterio:clusterio "$HOST_MODS_DIR"
  fi
fi

# Runtime Factorio client download.
# If FACTORIO_USERNAME + FACTORIO_TOKEN are set and the client is not already installed,
# download it now. The client is stored in a persistent volume so it survives `down -v`.
FACTORIO_CLIENT_HOME="${FACTORIO_CLIENT_HOME:-/opt/factorio-client}"
FACTORIO_CLIENT_VOLUME_DIR="${FACTORIO_CLIENT_VOLUME_DIR:-/opt/factorio-client}"

# Check for actual binary presence (directory may exist as an empty mount point)
client_in_image() { [ -x "$FACTORIO_CLIENT_HOME/bin/x64/factorio" ]; }
client_in_volume() { [ -x "$FACTORIO_CLIENT_VOLUME_DIR/bin/x64/factorio" ]; }

if ! client_in_image && ! client_in_volume \
   && [ -n "$FACTORIO_USERNAME" ] && [ -n "$FACTORIO_TOKEN" ] \
   && [ "${SKIP_CLIENT:-false}" != "true" ]; then
  FACTORIO_CLIENT_BUILD="${FACTORIO_CLIENT_BUILD:-expansion}"
  FACTORIO_CLIENT_TAG="${FACTORIO_CLIENT_TAG:-stable}"
  echo "Downloading Factorio game client (build=${FACTORIO_CLIENT_BUILD}, tag=${FACTORIO_CLIENT_TAG})..."
  archive="/tmp/factorio-client.tar.xz"
  # Pass the credentialed URL via curl's config on stdin (-K -) so the Factorio
  # token does not appear in the process list / proc args during the download.
  # Explicit resume loop instead of curl --retry: --retry restarts a broken
  # transfer from byte 0, which can never finish a multi-GB download over a
  # link that keeps dropping mid-transfer; -C - resumes from the partial file.
  # curl exit 33 = server refused the range request: discard the partial so the
  # next attempt starts clean instead of failing 33 forever.
  attempt=0
  while :; do
    rc=0
    curl -fL -C - -o "$archive" -K - <<EOF || rc=$?
url = "https://factorio.com/get-download/${FACTORIO_CLIENT_TAG}/${FACTORIO_CLIENT_BUILD}/linux64?username=${FACTORIO_USERNAME}&token=${FACTORIO_TOKEN}"
EOF
    if [ "$rc" -eq 0 ]; then break; fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      echo "ERROR: game client download failed after ${attempt} resume attempts (last curl exit ${rc})" >&2
      exit 1
    fi
    if [ "$rc" -eq 33 ]; then rm -f "$archive"; fi
    echo "Game client download interrupted (curl exit ${rc}, attempt ${attempt}/30) — resuming..."
    sleep 5
  done
  mkdir -p "$FACTORIO_CLIENT_VOLUME_DIR"
  tar -xJf "$archive" -C "$FACTORIO_CLIENT_VOLUME_DIR" --strip-components=1
  rm "$archive"
  chown -R clusterio:clusterio "$FACTORIO_CLIENT_VOLUME_DIR"
  echo "Factorio game client installed to $FACTORIO_CLIENT_VOLUME_DIR"
fi

# Use volume-installed client if present (preferred), then image-baked client, then headless.
if client_in_volume && [ "${SKIP_CLIENT:-false}" != "true" ]; then
    FACTORIO_DIR="$FACTORIO_CLIENT_VOLUME_DIR"
    echo "Factorio game client (volume) detected — using $FACTORIO_DIR"
elif client_in_image && [ "${SKIP_CLIENT:-false}" != "true" ]; then
    FACTORIO_DIR="$FACTORIO_CLIENT_HOME"
    echo "Factorio game client (image) detected — using $FACTORIO_DIR"
else
    # Headless host: FACTORIO_HOME is a multi-version parent dir (baked install lives in
    # a subdir). Pointing factorio_directory here — rather than at a direct install — lets
    # Clusterio auto-download/update the target headless version at runtime on Linux.
    FACTORIO_DIR="$FACTORIO_HOME"
    echo "No game client present — using headless directory $FACTORIO_DIR (auto-update enabled)"
fi

# Export-host guard: EXPORT_HOST designates a host to run export-data. On a host
# without the game client the export still SUCCEEDS, but exports no icons — the
# web UI shows none and nothing fails. Warn at the source
# instead (docs/asset-export.md). Only fires when EXPORT_HOST reaches this
# container's environment (e.g. set in .env); the controller's seeding logs the
# same condition either way.
if [ "${EXPORT_HOST:-0}" = "$HOST_ID" ] && [ "$FACTORIO_DIR" = "$FACTORIO_HOME" ]; then
  if [ "${SKIP_CLIENT:-false}" = "true" ]; then
    headless_reason="SKIP_CLIENT=true forces headless"
  else
    headless_reason="it has no game client installed"
  fi
  echo "WARNING: EXPORT_HOST=$EXPORT_HOST designates THIS host ($HOST_NAME) for export-data, but $headless_reason — the export will succeed without any icons, so the web UI will show none (docs/asset-export.md)" >&2
fi

# Diagnostic: report which Factorio version(s) are present in the resolved directory. Clusterio
# resolves the Factorio binary by version, so a mismatch between what is installed here and an
# instance's pinned `factorio.version` is a common — and otherwise hard to diagnose — cause of
# an instance failing to start: the host throws "Unable to find Factorio version X" (or
# downloads X) before the server launches, and that lands in this host log, not the instance's
# factorio-current.log. Logging the installed version here makes the mismatch visible up front.
report_factorio_versions() {
    local dir="$1" changelog version found=""
    for changelog in "$dir/data/changelog.txt" "$dir"/*/data/changelog.txt; do
        [ -f "$changelog" ] || continue
        # Best-effort: a changelog with no `Version:` line (or a partially-written file) makes
        # grep -m1 exit 1, which pipefail propagates and `set -e` would turn into an entrypoint
        # abort. This is diagnostic-only, so never let it fail startup — fall back to empty and let
        # the `[ -n ]` check below skip it.
        version=$(grep -m1 -iE '^Version:' "$changelog" 2>/dev/null | sed -E 's/^[Vv]ersion:[[:space:]]*//') || true
        [ -n "$version" ] && found="${found:+$found, }$version"
    done
    echo "Factorio install(s) under $dir: ${found:-none (will be downloaded at runtime)}"
}
report_factorio_versions "$FACTORIO_DIR"

# ----------------------------------------------------------------------------
# Boot-race guard.
# An instance that auto-starts before this host completes its controller
# handshake silently skips instance plugins — no error, IPC just goes nowhere
# (README: "Operational note: the instance/plugin boot race"). This guard
# mechanizes the manual stop/start protocol: once the controller reports this
# host connected, it restarts any of this host's instances whose startedAtMs
# PREDATES the handshake. Instances started after (e.g. by first-run seeding)
# are untouched, so healthy boots are a no-op — the bounce is surgical.
# Requires the shared tokens volume (config-control.json); standalone hosts
# without it skip quietly and the manual protocol still applies.
# The true fix (loud failure in Clusterio core) is tracked upstream.
# ----------------------------------------------------------------------------
CONTROL_CONFIG="${CONTROL_CONFIG:-$TOKENS_DIR/config-control.json}"
# The shared control config is CONTROLLER-LOCAL: create-ctl-config bakes
# controller_url=http://localhost:8080/, which from a host container points at
# the host itself — and clusterioctl HANGS on it rather than refusing (#24's
# second root cause). The guard derives a host-reachable copy using the same
# CONTROLLER_URL this entrypoint configures clusteriohost with.
GUARD_CTL_CONFIG="$DATA_DIR/.guard-control.json"
# Read GUARD_CONTROLLER_URL from native configuration after hooks.
GUARD_LOG="$DATA_DIR/boot-race-guard.log"

ctl_ro() {
    # Hard-bounded: clusterioctl has no client-side timeout and HANGS indefinitely
    # against an unreachable or mid-boot controller (#24 — the guard's first
    # host-list call froze forever, so neither progress nor the deadline message
    # ever appeared). timeout's exit 124 just makes the poll loops iterate.
    timeout -k 5 25 gosu clusterio npx clusterioctl --log-level error "$@" --config "$GUARD_CTL_CONFIG" 2>/dev/null
}

# Guard messages go to BOTH stdout and a file: if stdout capture ever fails,
# the file still proves whether (and how far) the guard ran (#24 discriminator).
guard_log() {
    echo "boot-race guard: $*"
    echo "$(date -u +%FT%TZ) $*" >> "$GUARD_LOG" 2>/dev/null || true
}

boot_race_guard() {
    # Wrapper so the derived admin-token copy is removed on EVERY exit path — the
    # impl below returns early in four places. Without this the file persisted on
    # the host's data volume indefinitely, long outliving the boot it was minted
    # for (found on a live host dated weeks after creation).
    local rc=0
    _boot_race_guard_impl || rc=$?
    rm -f "$GUARD_CTL_CONFIG" "$GUARD_CTL_CONFIG.tmp"
    # Logged AFTER the rm so this line is a real barrier: the impl's own
    # "complete" fires before cleanup, so anything waiting on that would race
    # the removal. Wait on this instead.
    guard_log "derived control config removed"
    return "$rc"
}

_boot_race_guard_impl() {
    # Wall-clock deadline (SECONDS is bash's elapsed timer): each ctl_ro poll can
    # itself burn up to ~25s in timeout, so counting sleeps alone would stretch
    # the nominal deadline to many minutes of real time.
    local deadline=$((SECONDS + 240)) T inst w
    guard_log "started (pid $$, host $HOST_NAME/$HOST_ID)"
    while [ ! -f "$CONTROL_CONFIG" ]; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            guard_log "no control config appeared (standalone host?) — skipping"
            return 0
        fi
        sleep 5
    done
    # Derive a copy with Clusterio 2.0 key names (ctl.*; control.* from an alpha image
    # is renamed until the controller migrates the shared file) and a host-reachable URL.
    if ! node /scripts/ctl-config.cjs derive "$CONTROL_CONFIG" "$GUARD_CTL_CONFIG" "$GUARD_CONTROLLER_URL" 2>/dev/null; then
        guard_log "could not derive a host-reachable control config — skipping"
        return 0
    fi
    # This derived copy carries the controller's ADMIN token. Own it by clusterio
    # (ctl_ro runs gosu clusterio) and keep it 0600 for the few minutes it exists.
    chown clusterio:clusterio "$GUARD_CTL_CONFIG" 2>/dev/null || true
    chmod 600 "$GUARD_CTL_CONFIG" 2>/dev/null || true
    guard_log "control config present (rewritten controller_url -> $GUARD_CONTROLLER_URL) — waiting for controller to report this host connected"
    until ctl_ro host list --output json | node /scripts/ctl-json.cjs host-connected "$HOST_ID" 2>/dev/null; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            guard_log "host never reported connected within the deadline — skipping"
            return 0
        fi
        sleep 5
    done
    T=$(node -e 'console.log(Date.now())')
    # Honest readiness: the image healthcheck requires this marker (when the
    # shared tokens volume is present) — "container up" now means "connected".
    touch /run/clusterio-connected 2>/dev/null || true
    guard_log "handshake confirmed at $T — checking for instances started before it"
    ctl_ro instance list --output json | node /scripts/ctl-json.cjs instances-before "$HOST_ID" "$T" 2>/dev/null \
    | while IFS= read -r inst; do
        guard_log "'$inst' started before the handshake — restarting it so plugins register"
        ctl_ro instance stop "$inst" >/dev/null || true
        w=$((SECONDS + 90))
        until [ "$(ctl_ro instance list --output json | node /scripts/ctl-json.cjs instance "$inst" status 2>/dev/null)" = "stopped" ]; do
            if [ "$SECONDS" -ge "$w" ]; then
                guard_log "'$inst' did not stop within the wait budget — leaving it as-is"
                break
            fi
            sleep 3
        done
        ctl_ro instance start "$inst" >/dev/null || true
        guard_log "'$inst' restarted after handshake"
    done
    guard_log "complete"
}

get_token() {
    # Priority 1: Environment variable (for standalone container usage)
    if [ -n "$CLUSTERIO_HOST_TOKEN" ]; then
        echo "$CLUSTERIO_HOST_TOKEN"
        return 0
    fi
    
    # Priority 2: Token file from shared volume (docker-compose usage)
    if [ -f "$TOKEN_FILE" ]; then
        cat "$TOKEN_FILE"
        return 0
    fi
    
    return 1
}

# Bash as PID 1 ignores SIGTERM unless it has a handler, and the waits below can last
# minutes: without this, `docker stop` would sit out its whole grace period.
trap 'echo "Stopped before the host started"; exit 143' TERM INT

# Wait only for first-boot credentials. Existing configuration is reconciled,
# never deleted when credentials rotate or a native command fails.
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Waiting for host token..."
    WAITED=0
    while ! get_token >/dev/null; do
        if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then
            echo "ERROR: Timed out waiting for host token after ${MAX_WAIT_SECONDS}s" >&2
            exit 1
        fi
        sleep "$WAIT_INTERVAL"
        WAITED=$((WAITED + WAIT_INTERVAL))
    done
fi
token_file_state() {
    if [ -f "$TOKEN_FILE" ]; then sha256sum < "$TOKEN_FILE"; else echo absent; fi
}
configure_host() {
    TOKEN_FILE_SEEN=$(token_file_state)
    gosu clusterio node /scripts/configure-host.cjs reconcile "$CONFIG_PATH" "$FACTORIO_DIR" "$HOST_NAME" "$TOKEN_FILE"
    /scripts/run-pre-start.sh host "$CONFIG_PATH"
    # Hooks may change identity or endpoint. Observe what the host will actually use; an
    # id or controller URL that cannot work stops the start here.
    EFFECTIVE_CONFIG=$(gosu clusterio node /scripts/configure-host.cjs effective "$CONFIG_PATH")
}
configure_host

# Token check (Clusterio 2.1). A host started with a token the controller rejects does not
# exit: it asks to join the cluster again and waits for someone to approve it, and it never
# rereads its token file. So ask the controller first. A rejected token usually means the
# controller is about to re-issue this host's token file (its data volume was wiped, or
# the host never connected before an upgrade from 2.0): wait for the file to change and
# configure again. Hosts start as soon as the controller answers HTTP, which is before it
# has issued tokens. Pre-start hooks run again after each new token.
WAITED=0
UNREACHABLE=0
NOTED=""
while :; do
    check_rc=0
    gosu clusterio node /scripts/configure-host.cjs check "$CONFIG_PATH" >/dev/null || check_rc=$?
    case "$check_rc" in
    0)  break ;;
    3)  if [ -n "$CLUSTERIO_HOST_TOKEN" ]; then
            echo "ERROR: the controller rejects the token in CLUSTERIO_HOST_TOKEN (revoked, issued by another controller, or its host was never registered). Supply a current token." >&2
            exit 1
        fi
        if [ "$(token_file_state)" != "$TOKEN_FILE_SEEN" ]; then
            echo "Token file $TOKEN_FILE changed — configuring the host again"
            configure_host
            continue
        fi
        if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then
            echo "ERROR: the controller rejects this host's token and no new token file appeared at $TOKEN_FILE within ${MAX_WAIT_SECONDS}s. The controller issues one for each host up to HOST_COUNT when it starts (docs/consumer-integration.md)." >&2
            exit 1
        fi
        if [ "$NOTED" != rejected ]; then
            echo "The controller rejects this host's token — waiting for it to issue a new token file at $TOKEN_FILE"
            NOTED=rejected
        fi
        WAITED=$((WAITED + WAIT_INTERVAL)) ;;
    4)  # Not bounded: without its controller the host has nothing to do, and starting it
        # now would only move this wait into clusteriohost.
        if [ $((UNREACHABLE % 60)) -eq 0 ]; then
            echo "Waiting for the controller to answer before starting the host..."
        fi
        UNREACHABLE=$((UNREACHABLE + WAIT_INTERVAL)) ;;
    5)  # A controller older than 2.1 has no check endpoint, and it does not need one.
        echo "The controller did not say whether it accepts this host's token (older than Clusterio 2.1?) — starting the host anyway"
        break ;;
    *)  echo "ERROR: could not check this host's token with the controller (exit $check_rc)" >&2
        exit 1 ;;
    esac
    sleep "$WAIT_INTERVAL"
done
trap - TERM INT

HOST_ID=${EFFECTIVE_CONFIG%%$'\n'*}
GUARD_CONTROLLER_URL=${EFFECTIVE_CONFIG#*$'\n'}
boot_race_guard &
# Run the bin directly, not via npx: npm exec does not forward SIGTERM, so the host
# (and its Factorio servers) would be killed without stopping and saving instances.
exec gosu clusterio /clusterio/node_modules/.bin/clusteriohost run --config "$CONFIG_PATH"
