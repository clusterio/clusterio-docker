#!/bin/bash
# seed-instances.sh
# Creates, assigns, configures, uploads saves, and optionally starts seeded instances.
#
# Expected environment / arguments:
#   $1 = CONTROL_CONFIG  (path to config-control.json)
#   $2 = HOST_COUNT      (number of expected hosts)
#
# Reads from: /clusterio/seed-data/hosts/<hostname>/<instance>/
#   - *.zip          → uploaded as saves
#   - instance.json  (optional) → native Clusterio instance config
#
# instance.json is the standard Clusterio InstanceConfig format. Fields that
# are environment-specific (IDs, tokens, assigned host) are automatically
# skipped. All other fields are applied via `clusterioctl instance config set`.

set -eo pipefail

CONTROL_CONFIG="$1"
HOST_COUNT="${2:-0}"

# HEADLESS_FACTORIO_DIR and host_factorio_dir, shared with regenerate-export-data.sh.
# It also sets SCRIPT_LIB_DIR, where ctl-json.cjs and host-token.cjs live.
# shellcheck source=scripts/export-host-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/export-host-lib.sh"
# Overridable so the ordering test (tests/seed-instances-order.test.sh) can point
# the script at a fixture tree. Production always uses the mounted default.
SEED_DATA_DIR="${SEED_DATA_DIR:-/clusterio/seed-data}"
TOKENS_DIR="${TOKENS_DIR:-/clusterio/tokens}"
# How long an auto-started instance gets to reach "running". Overridable for the same test.
START_WAIT_SECONDS="${START_WAIT_SECONDS:-120}"
# How long seeding polls for HOST_COUNT hosts to connect before it carries on. A poll in
# progress at that moment still finishes.
HOST_WAIT_SECONDS="${HOST_WAIT_SECONDS:-75}"
# Time limits, in seconds, for clusterioctl calls. clusterioctl has no client-side timeout
# and waits forever on a controller that does not answer, so every call that contacts the
# controller runs under `timeout` (pinned by tests/ctl-timeout.test.cjs). Read from the
# environment so the tests can shorten them; they are not documented settings.
#   lookup    read-only queries, and the start attempt the start loop repeats
#   action    changes the controller answers once it has applied them, and the one
#             query whose answer decides whether an instance is created
#   transfer  save uploads and export-data
CTL_LOOKUP_TIMEOUT="${CTL_LOOKUP_TIMEOUT:-25}"
CTL_ACTION_TIMEOUT="${CTL_ACTION_TIMEOUT:-60}"
CTL_TRANSFER_TIMEOUT="${CTL_TRANSFER_TIMEOUT:-300}"

# Count of operations that failed. Seeding continues past a failure (one bad
# instance must not strand the others) but the script exits non-zero so the
# caller can decline to write .seed-complete and retry on the next start.
SEED_FAILURES=0

# ---------------------------------------------------------------------------
# Run a clusterioctl seeding command, surfacing its stderr when it fails.
#
# These calls used to be `... 2>/dev/null || true`, which discarded BOTH the exit
# status and the diagnostic. A failed `instance create` then let assign, upload
# and start run against an instance that did not exist — each of those swallowed
# too — so the only symptom was the 120s start-loop timeout, by which point the
# real error was unrecoverable.
# ---------------------------------------------------------------------------
ctl_seed() { ctl_seed_within "$CTL_ACTION_TIMEOUT" "$@"; }

# ctl_seed_within <seconds> <what> <clusterioctl arguments...>
ctl_seed_within() {
  local limit="$1" what="$2"; shift 2
  local err rc=0
  # 2>&1 >/dev/null keeps stderr and drops stdout: the table output is noise
  # here, the error text is the whole point.
  err=$(timeout -k 5 "$limit" gosu clusterio npx clusterioctl --log-level error "$@" \
    --config "$CONTROL_CONFIG" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    # timeout's own statuses: stopped at the limit (124), or killed after ignoring that (137).
    # Only the client was cut off: the controller may have carried the command out.
    echo "      ERROR: $what got no answer within ${limit}s; stopped waiting. The controller may still have applied it." >&2
    SEED_FAILURES=$((SEED_FAILURES + 1))
  elif [ "$rc" -ne 0 ]; then
    echo "      ERROR: $what failed (exit $rc)" >&2
    if [ -n "$err" ]; then
      printf '        %s\n' "$err" >&2
    else
      echo "        (command produced no error output)" >&2
    fi
    SEED_FAILURES=$((SEED_FAILURES + 1))
  fi
  return "$rc"
}

# Fields that must NOT be seeded — they are runtime/environment-specific
SKIP_FIELDS=(
  "instance.id"
  "instance.name"
  "instance.assigned_host"
  "factorio.host_assigned_game_port"
  "factorio.rcon_port"
  "factorio.rcon_password"
  "factorio.mod_pack_id"
)

if [ ! -d "$SEED_DATA_DIR/hosts" ]; then
  echo "No seed-data/hosts directory found, skipping instance seeding."
  exit 0
fi

# ---------------------------------------------------------------------------
# Wait for all hosts to connect
# ---------------------------------------------------------------------------
wait_for_hosts() {
  local expected="$1"
  local connected=0

  if [ "$expected" -le 0 ]; then
    return 0
  fi

  echo "Waiting up to ${HOST_WAIT_SECONDS}s for $expected host(s) to connect..."
  # A wall-clock deadline (SECONDS is bash's elapsed timer), not a count of polls: one
  # poll can itself take up to the lookup limit.
  local deadline=$((SECONDS + HOST_WAIT_SECONDS))
  while :; do
    # ctl-json.cjs reads all of its input, so the pipe cannot break early.
    connected=$(timeout -k 5 "$CTL_LOOKUP_TIMEOUT" gosu clusterio npx clusterioctl --log-level error host list --output json \
      --config "$CONTROL_CONFIG" 2>/dev/null | node "$SCRIPT_LIB_DIR/ctl-json.cjs" connected-hosts 2>/dev/null || true)
    connected=${connected:-0}

    if [ "$connected" -ge "$expected" ]; then
      echo "All hosts connected"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      break
    fi
    sleep 2
  done

  echo "WARNING: Only $connected of $expected host(s) connected after waiting"
}

# ---------------------------------------------------------------------------
# resolve_host_id <host-name> <host-number>
# Prints the id clusterioctl addresses a seed folder's host by. Since Clusterio 2.1
# the controller picks host ids and host names need not be unique, so the folder
# name alone is not an address: the id the host's token file was issued for wins,
# then a host only that one has the name, then id N for clusterio-host-N (clusters
# set up before 2.1). Returns 1 when none of these names a registered host, 2 when
# the controller did not list its hosts.
# ---------------------------------------------------------------------------
resolve_host_id() {
  local name="$1" number="$2" token_id="" hosts
  if [ -f "$TOKENS_DIR/$name.token" ]; then
    token_id=$(node "$SCRIPT_LIB_DIR/host-token.cjs" id "$TOKENS_DIR/$name.token" 2>/dev/null) || token_id=""
  fi
  hosts=$(timeout -k 5 "$CTL_LOOKUP_TIMEOUT" gosu clusterio npx clusterioctl --log-level error host list --output json \
    --config "$CONTROL_CONFIG" 2>/dev/null) || return 2
  node "$SCRIPT_LIB_DIR/ctl-json.cjs" resolve-host "$name" "$token_id" "$number" <<<"$hosts" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Check if a field should be skipped
# ---------------------------------------------------------------------------
should_skip_field() {
  local field="$1"
  for skip in "${SKIP_FIELDS[@]}"; do
    if [ "$field" = "$skip" ]; then
      return 0
    fi
  done
  # Skip internal Clusterio metadata
  if [ "$field" = "_warning" ]; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Apply instance.json configuration
# ---------------------------------------------------------------------------
apply_instance_config() {
  local instance_name="$1"
  local config_file="$2"
  local applied=0

  echo "      Applying instance.json configuration..."

  # Extract all top-level keys and their values from instance.json
  # Uses a simple line-by-line approach for flat keys and JSON for objects
  while IFS= read -r line; do
    # Match "key": value lines (top-level only, not nested inside objects)
    local field value
    field=$(echo "$line" | sed -n 's/^[[:space:]]*"\([^"]*\)"[[:space:]]*:.*/\1/p')

    if [ -z "$field" ]; then
      continue
    fi

    if should_skip_field "$field"; then
      continue
    fi

    # Extract the value — handle objects (factorio.settings) specially.
    # Pass the file path and key as argv (NOT interpolated into the script body)
    # so apostrophes or special chars in a path/field can't break or inject.
    value=$(gosu clusterio node -e '
      const [, file, key] = process.argv;
      const val = JSON.parse(require("fs").readFileSync(file, "utf8"))[key];
      if (val === null || val === undefined) process.stdout.write("");
      else if (typeof val === "object") process.stdout.write(JSON.stringify(val));
      else process.stdout.write(String(val));
    ' "$config_file" "$field" 2>/dev/null) || continue

    if [ -z "$value" ]; then
      continue
    fi

    timeout -k 5 "$CTL_ACTION_TIMEOUT" gosu clusterio npx clusterioctl --log-level error instance config set \
      "$instance_name" "$field" "$value" \
      --config "$CONTROL_CONFIG" >/dev/null 2>/dev/null || {
        echo "        Warning: Failed to set $field"
        continue
      }
    applied=$((applied + 1))
  done < "$config_file"

  echo "      Applied $applied config field(s)"
}

# ---------------------------------------------------------------------------
# Seed a single instance
# ---------------------------------------------------------------------------
# seed_instance <instance-dir> <host-id> <host-number> <host-name>
# host-id addresses the host in clusterioctl; host-number (clusterio-host-N) is what
# EXPORT_HOST names.
seed_instance() {
  local instance_dir="$1"
  local host_id="$2"
  local host_number="$3"
  local host_label="host $4 (id $2)"
  local instance_name
  instance_name=$(basename "$instance_dir")

  # Idempotency check: skip if instance with this name already exists. The controller
  # accepts a second instance of the same name, so without an answer nothing is created:
  # the failure withholds .seed-complete and the next start asks again.
  local instances
  if ! instances=$(timeout -k 5 "$CTL_ACTION_TIMEOUT" gosu clusterio npx clusterioctl --log-level error instance list --output json \
       --config "$CONTROL_CONFIG" 2>/dev/null); then
    echo "    ERROR: could not list the controller's instances, so cannot tell whether '$instance_name' exists. Not creating it." >&2
    SEED_FAILURES=$((SEED_FAILURES + 1))
    return 1
  fi
  if node "$SCRIPT_LIB_DIR/ctl-json.cjs" instance "$instance_name" id <<<"$instances" >/dev/null 2>&1; then
    echo "    Instance '$instance_name' already exists — skipping"
    return 0
  fi

  echo "    Creating instance: $instance_name"

  # Create the instance. Everything below depends on it existing, so bail out of
  # this instance rather than running assign/upload/start against nothing.
  ctl_seed "instance create '$instance_name'" instance create "$instance_name" || {
    echo "      Skipping remaining steps for '$instance_name' — it was not created." >&2
    return 1
  }

  # Applied while the instance is still UNASSIGNED: config pushed to an ASSIGNED
  # instance reaches its host with notify=true and can fault a host that is starting it.
  # Assign then delivers the finished config once, with notify=false.
  # Order pinned by tests/seed-instances-order.test.sh.
  if [ -f "${instance_dir}instance.json" ]; then
    apply_instance_config "$instance_name" "${instance_dir}instance.json"
  fi

  # Assign to host. An unassigned instance cannot start, so the same applies.
  echo "      Assigning to $host_label"
  ctl_seed "instance assign '$instance_name' -> host $host_id" \
    instance assign "$instance_name" "$host_id" || {
    echo "      Skipping remaining steps for '$instance_name' — it is not assigned to a host." >&2
    return 1
  }

  # auto_pause foot-gun visibility: a headless server with Factorio's default
  # auto_pause=true pauses at 0 players, silently freezing on_tick plugin
  # pipelines while RCON keeps answering. Not enforced (game semantics belong
  # to the consumer) — but made visible (docs/seed-data.md).
  if [ ! -f "${instance_dir}instance.json" ] || ! grep -q '"auto_pause"' "${instance_dir}instance.json"; then
    echo "      INFO: '$instance_name' has no explicit auto_pause setting — headless servers pause at 0 players, freezing on_tick plugins (see docs/seed-data.md)"
  fi

  # Upload save files (.zip). A failed upload used to be entirely silent and the
  # instance then auto-started on a FRESH map — a silently wrong world that looks
  # healthy. Fail loudly and leave it stopped for the operator instead.
  local save_upload_failed=false
  for save_file in "${instance_dir}"*.zip; do
    if [ -f "$save_file" ]; then
      local save_name
      save_name=$(basename "$save_file")
      echo "      Uploading save: $save_name (waits up to ${CTL_TRANSFER_TIMEOUT}s for the controller)"
      ctl_seed_within "$CTL_TRANSFER_TIMEOUT" "save upload '$save_name' -> '$instance_name'" \
        instance save upload "$instance_name" "$save_file" || save_upload_failed=true
    fi
  done

  # Determine auto_start from instance.json (default: true)
  local auto_start=true
  if [ -f "${instance_dir}instance.json" ]; then
    local parsed parse_rc=0 parse_err_file
    parse_err_file=$(mktemp)
    parsed=$(gosu clusterio node -e '
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(cfg["instance.auto_start"] ?? true));
    ' "${instance_dir}instance.json" 2>"$parse_err_file") || parse_rc=$?
    if [ "$parse_rc" -ne 0 ]; then
      # Malformed instance.json used to fall through silently to auto_start=true,
      # so a typo'd config started an instance the operator meant to keep stopped.
      echo "      WARNING: could not read instance.auto_start from ${instance_dir}instance.json — defaulting to true" >&2
      sed 's/^/        /' "$parse_err_file" >&2 || true
    elif [ "$parsed" = "false" ]; then
      auto_start=false
    fi
    rm -f "$parse_err_file"
  fi

  # A missing save is not a reason to run a fresh map under the intended name.
  if [ "$save_upload_failed" = "true" ]; then
    echo "      NOT auto-starting '$instance_name': a save upload failed, so starting it now would create a new world. Fix the upload, then start it manually." >&2
    auto_start=false
  fi

  if [ "$auto_start" = "true" ]; then
    # Export game data before starting if this host is the designated export host.
    # EXPORT_HOST env var specifies which host number (clusterio-host-N) has the
    # full game client. Set to 0 or empty to skip export entirely.
    if [ -n "${EXPORT_HOST:-}" ] && [ "${EXPORT_HOST:-0}" != "0" ] \
       && [ "$host_number" = "$EXPORT_HOST" ] \
       && [ "${_EXPORT_DONE:-}" != "true" ]; then
      echo "      Exporting game data ($host_label is the designated export host; waits up to ${CTL_TRANSFER_TIMEOUT}s)..."
      if timeout -k 5 "$CTL_TRANSFER_TIMEOUT" gosu clusterio npx clusterioctl --log-level error instance export-data "$instance_name" \
          --config "$CONTROL_CONFIG" >/dev/null 2>/dev/null; then
        echo "      Export-data complete."
        # A host without the game client exports successfully, but exports no icons,
        # and only the host's log says so. Say so here too. What counts as headless
        # is defined in export-host-lib.sh (docs/asset-export.md).
        local _export_host_dir=""
        _export_host_dir=$(host_factorio_dir "$host_id" "$CONTROL_CONFIG") || true
        if [ "$_export_host_dir" = "$HEADLESS_FACTORIO_DIR" ]; then
          echo "      NOTE: $host_label looks headless (its Factorio directory is $HEADLESS_FACTORIO_DIR, used when no game client is installed) — prototypes, locale and settings were exported, but no icons were (the host's log says why). Install the client on this host, then run /scripts/regenerate-export-data.sh (docs/asset-export.md)."
        fi
      else
        echo "      WARNING: export-data failed — check the log of $host_label (docs/asset-export.md)"
      fi
      _EXPORT_DONE=true
    fi

    echo "      Starting instance: $instance_name"
    # Honest start (#20): the old single-shot `instance start || true` could
    # fire before the host had created the instance dir and swallowed the
    # failure — an instance silently stayed stopped. Retry until running,
    # WARN loud on giving up, with the last error the start command gave.
    # Each attempt and each status query is bounded by the lookup limit.
    local _start_deadline=$((SECONDS + START_WAIT_SECONDS)) _started=false _start_err="" _err _list
    local _mods_missing=false
    while [ "$SECONDS" -lt "$_start_deadline" ]; do
      _err=$(timeout -k 5 "$CTL_LOOKUP_TIMEOUT" gosu clusterio npx clusterioctl --log-level error instance start "$instance_name" \
        --config "$CONTROL_CONFIG" 2>&1 >/dev/null) || true
      if [ -n "$_err" ]; then
        _start_err="$_err"
      fi
      # An instance whose mod pack lacks a mod a loaded plugin requires refuses to
      # start (Clusterio 2.1.1). That does not change by waiting.
      if [[ "$_err" == *"does not have the mods required by the loaded plugins"* ]]; then
        _mods_missing=true
        break
      fi
      sleep 5
      if _list=$(timeout -k 5 "$CTL_LOOKUP_TIMEOUT" gosu clusterio npx clusterioctl --log-level error instance list --output json \
            --config "$CONTROL_CONFIG" 2>/dev/null) \
         && [ "$(node "$SCRIPT_LIB_DIR/ctl-json.cjs" instance "$instance_name" status <<<"$_list" 2>/dev/null)" = "running" ]; then
        _started=true
        break
      fi
    done
    if [ "$_started" = "true" ]; then
      echo "      Instance '$instance_name' is running."
    elif [ "$_mods_missing" = "true" ]; then
      echo "      WARNING: instance '$instance_name' cannot start: its mod pack lacks mods a loaded plugin requires (retrying cannot help)" >&2
      sed 's/^/        /' <<<"$_start_err" >&2
    else
      echo "      WARNING: instance '$instance_name' did not reach running within ${START_WAIT_SECONDS}s — check the host's logs" >&2
      if [ -n "$_start_err" ]; then
        sed 's/^/        /' <<<"$_start_err" >&2
      fi
    fi
  else
    echo "      Skipping auto-start (instance.auto_start=false)"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
wait_for_hosts "$HOST_COUNT"

# Track whether export-data has been run (only once, on the designated EXPORT_HOST)
_EXPORT_DONE=false

echo "Processing seed data..."
for host_dir in "$SEED_DATA_DIR/hosts"/*/; do
  if [ ! -d "$host_dir" ]; then
    continue
  fi

  host_name=$(basename "$host_dir")
  # Extract the host number from the folder name (e.g., clusterio-host-1 -> 1),
  # read as decimal like configure-host.cjs does (clusterio-host-08 -> 8).
  host_number=$(echo "$host_name" | grep -oE '[0-9]+$' || echo "")

  if [ -z "$host_number" ]; then
    echo "  Warning: Could not extract host number from '$host_name', skipping"
    continue
  fi
  host_number=$(sed -E 's/^0+([0-9])/\1/' <<<"$host_number")

  resolve_rc=0
  host_id=$(resolve_host_id "$host_name" "$host_number") || resolve_rc=$?
  if [ "$resolve_rc" -ne 0 ]; then
    if [ "$resolve_rc" -eq 2 ]; then
      echo "  ERROR: could not list the controller's hosts, so seed folder '$host_name' has no host to go to. Skipping its instances." >&2
    else
      echo "  ERROR: no registered host matches seed folder '$host_name' — is HOST_COUNT at least $host_number, and did the host get a token? Skipping its instances." >&2
    fi
    SEED_FAILURES=$((SEED_FAILURES + 1))
    continue
  fi

  echo "  Processing host: $host_name (id $host_id)"

  for instance_dir in "$host_dir"*/; do
    if [ -d "$instance_dir" ]; then
      # Tolerated on purpose, and only because seed_instance has already logged
      # the reason and incremented SEED_FAILURES: one broken instance must not
      # strand the rest of the cluster. The non-zero exit below is what carries
      # the failure to the caller.
      seed_instance "$instance_dir" "$host_id" "$host_number" "$host_name" || true
    fi
  done
done

if [ "$SEED_FAILURES" -gt 0 ]; then
  echo "Instance seeding finished with $SEED_FAILURES failure(s) — see the ERROR lines above." >&2
  exit 1
fi

echo "Instance seeding complete."
