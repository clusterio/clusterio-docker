#!/bin/bash
# controller-entrypoint.sh
set -eo pipefail

DATA_DIR="/clusterio/data"
CONFIG_PATH="$DATA_DIR/config-controller.json"
TOKENS_DIR="/clusterio/tokens"
# Cluster-ADMIN ctl config shared with the hosts. The filename is this
# image's token-exchange contract; its keys follow Clusterio 2.0 (ctl.*).
CONTROL_CONFIG="$TOKENS_DIR/config-control.json"
EXTERNAL_PLUGINS_DIR="/clusterio/external_plugins"
SEED_DATA_DIR="/clusterio/seed-data"
# Number of hosts named clusterio-host-1..N that get a token on the shared volume and that
# seeding waits for. 0 for a controller whose hosts are approved by hand.
HOST_COUNT=${HOST_COUNT:-0}

# Create data directory and fix permissions
mkdir -p "$DATA_DIR" "$TOKENS_DIR"
chown -R clusterio:clusterio "$DATA_DIR" "$TOKENS_DIR"

# Clean up stale lock files from an unclean shutdown (e.g. docker restart).
# Assumes a single controller per data volume (the supported topology); only
# removes (and logs) when a lock is actually present. Clusterio's own lock files
# (#815) are what guard against two controllers concurrently sharing a volume.
if compgen -G "$DATA_DIR/*.lock" > /dev/null 2>&1; then
  echo "Removing stale controller lock file(s) from a previous run"
  rm -f "$DATA_DIR"/*.lock
fi

# Honest readiness: the healthcheck requires this marker, written only when the
# entrypoint reaches steady state (post-seeding) — clear any stale copy first.
rm -f "$DATA_DIR/.seed-healthy"

# Mirror Clusterio's on-disk cluster log to stdout (CLUSTERIO_LOG_TO_STDOUT).
source /scripts/stream-logs.sh
start_log_streamer /clusterio/logs/cluster cluster

# Handle external plugins if mounted
source /scripts/install-plugins.sh
install_external_plugins "$EXTERNAL_PLUGINS_DIR"

# Plugins published on npm, named in CLUSTERIO_NPM_PLUGINS. Runs before the first Clusterio
# command so the plugins' config fields exist; fatal if a named plugin cannot be installed.
if [ -n "${CLUSTERIO_NPM_PLUGINS:-}" ]; then
  gosu clusterio node /scripts/install-npm-plugins.cjs "$CLUSTERIO_NPM_PLUGINS"
fi

# Check if first run (no config file yet)
FIRST_RUN=false
if [ ! -f "$CONFIG_PATH" ]; then
  FIRST_RUN=true
  echo "First run detected, configuring controller..."
  
  # Seed database files from seed-data/controller/database/ BEFORE any config
  if [ -d "$SEED_DATA_DIR/controller/database" ]; then
    echo "Seeding database files..."
    mkdir -p "$DATA_DIR/database"
    for db_file in "$SEED_DATA_DIR/controller/database"/*.json; do
      if [ -f "$db_file" ]; then
        filename=$(basename "$db_file")
        # Skip example files
        if [[ "$filename" != *.example.json ]]; then
          echo "  Copying: $filename"
          cp "$db_file" "$DATA_DIR/database/$filename"
        fi
      fi
    done
    chown -R clusterio:clusterio "$DATA_DIR/database"
  fi
  
  # Clusterio 2.0: config files are created explicitly. `config set` against a
  # missing file now fails ("Failed to load") instead of initialising it, and
  # `config create` is a no-op once the file exists.
  gosu clusterio npx clusteriocontroller --log-level error config create --config "$CONFIG_PATH"

  # Configure paths relative to data volume
  gosu clusterio npx clusteriocontroller --log-level error config set controller.database_directory "$DATA_DIR/database" --config "$CONFIG_PATH"
  gosu clusterio npx clusteriocontroller --log-level error config set controller.http_port "${CONTROLLER_HTTP_PORT:-8080}" --config "$CONFIG_PATH"
  if [ -n "$CONTROLLER_PUBLIC_ADDRESS" ]; then
    # The field is controller.public_url; controller.public_address never existed,
    # so this line used to abort the first run (set -e) whenever the variable was set.
    gosu clusterio npx clusteriocontroller --log-level error config set controller.public_url "$CONTROLLER_PUBLIC_ADDRESS" --config "$CONFIG_PATH"
  fi
  if [ -n "$FACTORIO_USERNAME" ]; then
    gosu clusterio npx clusteriocontroller --log-level error config set controller.factorio_username "$FACTORIO_USERNAME" --config "$CONFIG_PATH"
  fi
  if [ -n "$FACTORIO_TOKEN" ]; then
    gosu clusterio npx clusteriocontroller --log-level error config set controller.factorio_token "$FACTORIO_TOKEN" --config "$CONFIG_PATH"
  fi

  # --- Bootstrap (must run BEFORE controller starts) ---
  # These commands modify database files on disk. The controller loads them
  # into memory at startup, so they must be written before `controller run`.

  if [ -z "$INIT_CLUSTERIO_ADMIN" ]; then
    echo "ERROR: INIT_CLUSTERIO_ADMIN is not set. Cannot create admin user."
    echo "       Set it in .env or as an environment variable."
    exit 1
  fi

  # Only create admin if not already present in seeded database
  if [ -f "$DATA_DIR/database/users.json" ] && grep -q "\"name\":.*\"$INIT_CLUSTERIO_ADMIN\"" "$DATA_DIR/database/users.json"; then
    echo "Admin user '$INIT_CLUSTERIO_ADMIN' found in seeded database — skipping bootstrap create-admin"
  else
    echo "Creating admin user: $INIT_CLUSTERIO_ADMIN"
    gosu clusterio npx clusteriocontroller --log-level error bootstrap create-admin "$INIT_CLUSTERIO_ADMIN" --config "$CONFIG_PATH"
  fi

  # Generate control config (token) for API access. The filename stays config-control.json
  # even though Clusterio 2.0's default became config-ctl.json (hosts, CI and tooling read
  # it); only the keys inside follow upstream (ctl.*). Clusterio writes it 0600 as
  # clusterio (gosu) — the ownership matters: hosts read it over the shared volume as the
  # same uid.
  echo "Generating control config for API access..."
  gosu clusterio npx clusteriocontroller --log-level error bootstrap create-ctl-config "$INIT_CLUSTERIO_ADMIN" --output "$CONTROL_CONFIG" --config "$CONFIG_PATH"
  if [ ! -s "$CONTROL_CONFIG" ]; then
    echo "ERROR: create-ctl-config did not produce $CONTROL_CONFIG — cannot provision API token" >&2
    exit 1
  fi
  # create-ctl-config bakes ctl.controller_url from controller.public_url, which this
  # container may not be able to reach (reverse proxy, no hairpin NAT) — and clusterioctl
  # hangs on an unreachable controller instead of failing. Everything in this container
  # dials loopback; the host guard derives its own copy from CONTROLLER_URL.
  gosu clusterio npx clusterioctl --log-level error config set ctl.controller_url "http://localhost:${CONTROLLER_HTTP_PORT:-8080}/" --config "$CONTROL_CONFIG"
  chown clusterio:clusterio "$CONTROL_CONFIG"
  chmod 600 "$CONTROL_CONFIG"
fi

# Log retention (Clusterio 2.1). Log files older than controller.log_retention_days
# (30 unless set) are deleted when the controller starts, and hourly after that — the first
# start after an upgrade from 2.0 included. So this must be written before `run`, and a
# value that cannot be applied stops the start: carrying on would delete the logs.
if [ -n "${CLUSTERIO_LOG_RETENTION_DAYS:-}" ]; then
  if ! [[ "$CLUSTERIO_LOG_RETENTION_DAYS" =~ ^[0-9]{1,5}$ ]]; then
    echo "ERROR: CLUSTERIO_LOG_RETENTION_DAYS must be a whole number of days (0 keeps logs forever), got '$CLUSTERIO_LOG_RETENTION_DAYS'" >&2
    exit 1
  fi
  gosu clusterio npx clusteriocontroller --log-level error config set controller.log_retention_days "$CLUSTERIO_LOG_RETENTION_DAYS" --config "$CONFIG_PATH"
  APPLIED_RETENTION=$(gosu clusterio npx clusteriocontroller --log-level error config show controller.log_retention_days --config "$CONFIG_PATH")
  if [ "$APPLIED_RETENTION" != "$((10#$CLUSTERIO_LOG_RETENTION_DAYS))" ]; then
    echo "ERROR: could not set controller.log_retention_days to $CLUSTERIO_LOG_RETENTION_DAYS (it reads back as '$APPLIED_RETENTION')" >&2
    exit 1
  fi
fi

# Clusterio 2.0 renamed clusterioctl's config fields from control.* to ctl.*. A ctl
# config minted by an alpha image still carries control.* keys, which 2.0's
# clusterioctl ignores ("Missing URL and/or token"). Rename them in place — same
# token, same file, idempotent — so existing token volumes keep working.
if [ -f "$CONTROL_CONFIG" ] && grep -q '"control\.controller_token"' "$CONTROL_CONFIG" \
   && ! grep -q '"ctl\.controller_token"' "$CONTROL_CONFIG"; then
  echo "Migrating $CONTROL_CONFIG keys from control.* to ctl.* (Clusterio 2.0)"
  # Atomic (tmp + rename): hosts may be reading this file over the shared volume.
  # Non-fatal: a corrupt file only breaks ctl-dependent seeding, not the controller.
  if node /scripts/ctl-config.cjs migrate "$CONTROL_CONFIG"; then
    chown clusterio:clusterio "$CONTROL_CONFIG"
    chmod 600 "$CONTROL_CONFIG"
  else
    echo "WARNING: could not migrate $CONTROL_CONFIG (unreadable JSON?) — clusterioctl-dependent seeding will fail until it is regenerated" >&2
  fi
fi

# Static-cache patch (absorbed consumer fix): the controller serves /static with
# immutable 1y headers, pinning stale web-UI chunks on returning browsers after
# upgrades. Flip to revalidation unless the consumer explicitly opts out.
if [ "${CONTROLLER_STATIC_CACHE_MODE:-revalidate}" != "immutable" ]; then
  node /scripts/patches/disable-immutable-cache.js
fi

/scripts/run-pre-start.sh controller "$CONFIG_PATH"

# Start controller in background. Run the bin directly, not via npx: npm exec does not
# forward SIGTERM, so the controller would be killed without saving its data.
gosu clusterio /clusterio/node_modules/.bin/clusteriocontroller run --config "$CONFIG_PATH" &
CONTROLLER_PID=$!

# Forward signals to the controller process for graceful shutdown
trap 'kill $CONTROLLER_PID; wait $CONTROLLER_PID; exit $?' SIGTERM SIGINT

# Wait for controller to be ready. A controller that stops first (a plugin that throws while
# loading, a config it cannot read) will never answer: exit with its status, so the container
# stops and a restart policy applies, instead of waiting here forever.
echo "Waiting for controller to start..."
until curl -sf http://localhost:${CONTROLLER_HTTP_PORT:-8080}/ > /dev/null 2>&1; do
    if ! kill -0 "$CONTROLLER_PID" 2>/dev/null; then
        status=0; wait "$CONTROLLER_PID" || status=$?
        echo "ERROR: the controller stopped before it answered HTTP (exit status $status) — its output is above" >&2
        [ "$status" -ne 0 ] || status=1
        exit "$status"
    fi
    sleep 2
done
echo "Controller is ready"

# Host tokens (Clusterio 2.1). The controller no longer signs a token for a host that does
# not exist yet, so each expected host is created through the running controller's host
# pairing endpoint and its token written to the shared volume. Every start, gaps only:
# raising HOST_COUNT issues the new host's token on the next start, and a token the
# controller still accepts is never replaced. Hosts wait for their file.
# Not fatal: a failure here leaves the affected hosts waiting, not the controller dead.
if [ "$HOST_COUNT" -gt 0 ]; then
  echo "Checking tokens for $HOST_COUNT host(s)..."
  gosu clusterio node /scripts/provision-hosts.cjs "$CONTROL_CONFIG" "$TOKENS_DIR" "$HOST_COUNT" \
    || echo "ERROR: not every host has a token — the hosts named above cannot join until the next controller start succeeds in issuing one" >&2
fi

# On first run, seed data via API (requires running controller)
# Also re-attempt if a previous first run was interrupted (marker not written)
SEED_MARKER="$DATA_DIR/.seed-complete"

# Resolve default mod pack ID (used by both first-run seeding and ongoing mod uploads)
DEFAULT_MOD_PACK="${DEFAULT_MOD_PACK:-Base Game 2.1}"
DEFAULT_FACTORIO_VERSION="${DEFAULT_FACTORIO_VERSION:-2.1}"
MOD_PACK_ID=$(gosu clusterio npx clusterioctl --log-level error mod-pack list --output json \
  --config "$CONTROL_CONFIG" 2>/dev/null \
  | node /scripts/ctl-json.cjs mod-pack-id "$DEFAULT_MOD_PACK" 2>/dev/null || true)

# If the requested mod pack doesn't exist, create it — but only during the
# seeding window (first run, or seeding not yet complete). This prevents a
# transient `mod-pack list` failure on a later boot (which leaves MOD_PACK_ID
# empty) from creating a duplicate pack.
if [ -z "$MOD_PACK_ID" ] && { [ "$FIRST_RUN" = true ] || [ ! -f "$SEED_MARKER" ]; }; then
  echo "Mod pack '$DEFAULT_MOD_PACK' not found — creating it (Factorio $DEFAULT_FACTORIO_VERSION)..."
  # Answers {"id":…,"name":…}. A failure must not stop the controller (set -e): the
  # warning below and the one at "Setting default mod pack" report it.
  MOD_PACK_ID=$(gosu clusterio npx clusterioctl --log-level error mod-pack create \
    "$DEFAULT_MOD_PACK" "$DEFAULT_FACTORIO_VERSION" --output json \
    --config "$CONTROL_CONFIG" 2>/dev/null \
    | node /scripts/ctl-json.cjs field id 2>/dev/null || true)
  if [ -n "$MOD_PACK_ID" ]; then
    echo "  Created mod pack '$DEFAULT_MOD_PACK' (ID: $MOD_PACK_ID)"
  else
    echo "  WARNING: Failed to create mod pack '$DEFAULT_MOD_PACK'"
  fi

  # Enable DLC mods if the pack name contains "Space Age" (Clusterio creates
  # builtin DLC mods as disabled by default — this enables them explicitly).
  # recycler is included because space-age + quality hard-depend on it in
  # Factorio 2.1.x; without it the save fails to load and every consumer ends
  # up patching this list downstream.
  if [ -n "$MOD_PACK_ID" ] && echo "$DEFAULT_MOD_PACK" | grep -qi "space.age"; then
    echo "  Enabling DLC mods (space-age, elevated-rails, quality, recycler)..."
    # Non-fatal but loud: under `set -e` a failing enable (e.g. an older core
    # without the `recycler` builtin) would otherwise crash-loop the whole
    # controller. A pack missing a DLC mod is recoverable; a dead controller
    # is not. (Found the hard way: an alpha.25-era custom build did exactly
    # this and the container restart-looped until compose gave up.)
    gosu clusterio npx clusterioctl --log-level error mod-pack edit "$MOD_PACK_ID" \
      --enable-mods space-age elevated-rails quality recycler \
      --config "$CONTROL_CONFIG" >/dev/null 2>&1 \
      || echo "  WARNING: enabling DLC mods failed (core too old for one of them?) — pack '$DEFAULT_MOD_PACK' may need manual mod-pack edit" >&2
  fi
fi

if [ "$FIRST_RUN" = true ] || [ ! -f "$SEED_MARKER" ]; then
  # Set default mod pack (required for instances to start)
  echo "Setting default mod pack: $DEFAULT_MOD_PACK"
  if [ -n "$MOD_PACK_ID" ]; then
    gosu clusterio npx clusterioctl --log-level error controller config set \
      controller.default_mod_pack_id "$MOD_PACK_ID" \
      --config "$CONTROL_CONFIG" >/dev/null 2>&1
    echo "  Default mod pack set (ID: $MOD_PACK_ID)"
  else
    echo "  WARNING: Mod pack '$DEFAULT_MOD_PACK' not found — set manually in Web UI"
  fi

  # Seed mods before instances (instances may need them to start)
  /scripts/seed-mods.sh "$CONTROL_CONFIG" "$MOD_PACK_ID"

  # Seed instances from seed-data/hosts/. A non-zero exit means at least one
  # instance failed; the script has already logged which and why.
  SEED_RC=0
  /scripts/seed-instances.sh "$CONTROL_CONFIG" "$HOST_COUNT" || SEED_RC=$?

  if [ "$SEED_RC" -eq 0 ]; then
    # Mark seeding as complete so restarts don't re-seed
    touch "$SEED_MARKER"
    chown clusterio:clusterio "$SEED_MARKER"
    echo "Seeding complete."
  else
    # Deliberately NOT fatal, and deliberately still "healthy" below. Aborting
    # here would exit the entrypoint and restart-loop the container on a
    # permanently bad instance.json, and marking the controller unhealthy would
    # block hosts (they gate on controller health) — turning a partial seeding
    # failure into a dead cluster. Instead: stay up, be loud, and withhold the
    # marker so the next start retries. Existing instances are skipped by the
    # idempotency check, so the retry is cheap.
    echo "WARNING: instance seeding reported failures — NOT writing $SEED_MARKER, so the next start will retry. Review the ERROR lines above." >&2
  fi
else
  # Not first run — upload any new mods added since last run (existing mods are skipped)
  /scripts/seed-mods.sh "$CONTROL_CONFIG" "$MOD_PACK_ID"
fi

# Honest readiness: everything above (config, bootstrap, seeding) completed —
# only now does the healthcheck's marker requirement pass.
touch "$DATA_DIR/.seed-healthy"
echo "Entrypoint steady state reached — controller healthcheck can now pass"

# Keep controller running
wait $CONTROLLER_PID