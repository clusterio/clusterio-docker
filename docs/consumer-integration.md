# Consumer Integration Guide

How to use clusterio-docker images in a downstream project.

## Image Tags

| Tag | Source | Use Case |
|-----|--------|----------|
| `latest` / `main` | npm registry (`@clusterio/*`), pinned to **`2.1.2`** — **moves** as the docker layer rebuilds | Stable, published Clusterio (newest) |
| `2.1.2` | Same as `latest` — the bundled Clusterio version; **moves** on rebuild | Track a Clusterio version |
| `2.1.2.rN` | An **immutable** revision pin (cut from a git tag); `.rN` bumps for docker-layer fixes on the same Clusterio version | **Production — pin this** |
| `<branch>` | Built from fork branch `solarcloud7/clusterio:<branch>` on a **non-main branch push** (falls back to the fork's default branch, `master`). PRs into `main`, `main`, and tags build the `release` target. | Dormant `custom`/fork path (a `factorio-*` line when npm lags a new Factorio version) |

```yaml
# Example: pull the stable images
image: ghcr.io/clusterio/clusterio-docker-controller:latest
image: ghcr.io/clusterio/clusterio-docker-host:latest
```

> **Production: pin `:<version>.rN`, not `:latest` or the bare version.** `:latest`,
> `:main`, and `:<version>` are **moving** tags — a rebuild replaces them in place, so an
> unpinned `docker compose up -d`/`pull` can change the running image (and its lineage)
> under you. Only `:<version>.rN` is immutable. This repo's default `docker-compose.yml`
> uses `:latest` for zero-config first runs; override `CLUSTERIO_IMAGE_TAG=<version>.rN` in
> `.env` for anything you depend on.

> **Moved to the clusterio organisation (2026-11-06):** images publish as
> `ghcr.io/clusterio/clusterio-docker-{controller,host}`. The old
> `ghcr.io/solarcloud7/clusterio-docker-*` images stay pullable, but nothing new is published
> there; `2.0.3.r1` is their last pin. Switch the image name when you move to `:2.0.3.r2` or later.

> **Migrating off old `:1` / `:1.x` / `:1.x.y` tags:** the independent repo-SemVer tag axis
> is **retired** — those tags are frozen at their last build and receive **no** further
> updates. Re-pin to `:<version>.rN` (e.g. `:2.1.2.r1`).

> **Migrating off `:2.0.0-alpha.27-r1` .. `-r4` (hyphen scheme):** these four were published
> before a SemVer-precedence bug in the separator was caught (a hyphen makes `27-r1` sort as
> *newer* than `alpha.28` under SemVer-aware tooling). They're frozen, not deleted — re-pin to
> `:2.0.0-alpha.27.r5` (dot) or later; no further `-rN` (hyphen) tags will be cut.

> **Note:** Image names include `-docker-` (derived from the repo name `clusterio-docker`).

> **Export-data:** The extended per-category export spritesheets (recipes, signals,
> technologies, planets, qualities, entities, static UI icons) are now **mainlined** in
> Clusterio (alpha.23 [#838](https://github.com/clusterio/clusterio/pull/838)), so the
> stable `latest` images already produce them — the old `ExtendedExportData` fork branch
> is superseded. Note the web-UI consumption API changed in alpha.24
> ([#875](https://github.com/clusterio/clusterio/pull/875): `useExportPrototypeMetadata`,
> `FactorioIcon`); downstream UI code that read the old hooks must migrate.

## Compose Setup

```yaml
services:
  clusterio-controller:
    image: ghcr.io/clusterio/clusterio-docker-controller:latest
    hostname: clusterio-controller          # MUST stay as-is (hosts connect to this)
    ports:
      - "8080:8080"
    volumes:
      - controller-data:/clusterio/data
      - controller-mods:/clusterio/mods
      - controller-static:/clusterio/static
      - controller-logs:/clusterio/logs
      - shared-tokens:/clusterio/tokens
      - ./seed-data:/clusterio/seed-data:ro
      # External plugins — MUST be read-write (npm install runs inside):
      - ./plugins:/clusterio/external_plugins
    environment:
      - INIT_CLUSTERIO_ADMIN=your_username  # Required on first run
      - HOST_COUNT=1                        # Hosts clusterio-host-1..N the controller issues tokens for
      - EXPORT_HOST=1                       # N of the clusterio-host-N with the game client (0 = skip)
      - DEFAULT_MOD_PACK=Space Age 2.1

  clusterio-host-1:
    image: ghcr.io/clusterio/clusterio-docker-host:latest
    hostname: clusterio-host-1              # MUST follow clusterio-host-N pattern
    depends_on:
      clusterio-controller:
        condition: service_healthy
    volumes:
      - host-1-data:/clusterio/data
      - shared-tokens:/clusterio/tokens:ro
      - factorio-client:/opt/factorio-client        # Persists downloaded game client
      - ./seed-data/mods:/clusterio/seed-mods:ro    # Pre-cache mods on host
      - ./plugins:/clusterio/external_plugins       # Must be read-write
    environment:
      - HOST_NAME=clusterio-host-1
      - FACTORIO_USERNAME=${FACTORIO_USERNAME}       # Triggers runtime client download
      - FACTORIO_TOKEN=${FACTORIO_TOKEN}
    ports:
      - "34100-34109:34100-34109/udp"

volumes:
  controller-data:
  controller-mods:
  controller-static:
  controller-logs:
  host-1-data:
  shared-tokens:
  factorio-client:
    external: true    # Survives `docker compose down -v`
```

## Automatic Asset Export (export-data)

Export-data generates item icons, recipe data, and spritesheets for the web UI.

**Requirements:**
1. One host must have the full Factorio game client — set `FACTORIO_USERNAME` + `FACTORIO_TOKEN` on the host for runtime download (recommended), or bake it in with `INSTALL_FACTORIO_CLIENT=true` at build time. Baking requires credentials as **BuildKit secrets** (`--secret id=factorio_username,env=… --secret id=factorio_token,env=…`), not build args, and such images must stay private
2. Set `EXPORT_HOST=N` on the **controller** (N = the number in the name `clusterio-host-N` of the host with the game client, not its host id)
3. At least one instance must be seeded on that host via `seed-data/hosts/clusterio-host-N/`

**How it works:**
- During first-run seeding, before starting the first instance on the export host, the controller runs `clusterioctl instance export-data`
- The host launches Factorio with `--export-data` to generate graphical assets
- Runs once per seeding — subsequent instances skip it
- If the export host has no game client the export still succeeds, but exports no icons (an empty spritesheet, no web-UI icons); the host log has a WARN that the base game's icon files were not found, and seeding logs a NOTE. If the export itself fails, seeding logs a warning and continues
- Assets are served at the controller's `/export/` endpoints

**Set `EXPORT_HOST=0` or empty to skip export entirely.**

## External Plugins

Mount your plugin directory into **both** controller and host containers at `/clusterio/external_plugins`. The mount **must be read-write** — the entrypoint runs `npm install` inside each plugin.

```
plugins/
└── my_plugin/
    ├── package.json
    ├── index.js
    └── info.js
```

Plugins must target the Clusterio 2.0 plugin API: ES modules (`"type": "module"`), entrypoint
paths with the `.js` extension in the plugin declaration, and default-function entrypoints
(class exports still load with a deprecation warning). A CommonJS plugin only registers if
its `plugin` export is detectable from the source (`module.exports = { plugin }`). See
upstream's [migration guide](https://github.com/clusterio/clusterio/blob/v2.0.1/docs/devs/plugin-migration-to-2.0.md).

Clusterio 2.1 adds: web modules built with Vite (`clusterioPlugin` from
`@clusterio/web_ui/vite.mjs`; a webpack-built web module is rejected with "Incompatible
dist/web/manifest.json, the plugin must be rebuilt with Vite", while its controller, host and
instance code still load), HTTP-style request error classes in place of `RequestError`,
`lib.atomicOverwriteFile` in place of `lib.safeOutputFile`, host token APIs under
`controller.hosts.*`, and the hosts datastore under `controller.hosts.records` (`set`,
`delete`, `size`, the `update` event). See upstream `docs/devs/plugin-migration-to-2.1.md`.
Mount plugins with a web module prebuilt: the release images do not contain `vite`.

### Singleton Fix (Custom Builds)

When using `CLUSTERIO_TARGET=custom` (monorepo layout), `npm install` for external plugins can install `@clusterio/lib` and `@clusterio/web_ui` locally into the plugin's `node_modules/`. This creates duplicate singletons — the plugin registers permissions/events in its copy while the controller reads from the monorepo copy, causing fatal crashes like:

```
Error: permission surface_export.ui.view does not exist
```

**The latest images fix this automatically** — `install-plugins.sh` removes `node_modules/@clusterio` after install, forcing Node.js to resolve upward to the shared monorepo copies.

That legacy directory-mount cleanup does not prove version compatibility. For packaged derived images, use compatible peer dependencies and the offline verification below; it detects duplicate resolution without deleting packages.

## Seed Data

```
seed-data/
├── controller/database/           # Copied before controller starts
│   ├── users.json                 # Pre-created user accounts
│   └── roles.json                 # Permission roles
├── mods/                          # Uploaded to controller via API after start
│   └── *.zip
├── external_plugins/              # Mounted into containers
│   └── my_plugin/
└── hosts/
    └── clusterio-host-N/          # Folder MUST match container hostname
        └── InstanceName/
            ├── instance.json      # Optional: Clusterio instance config
            └── *.zip              # Save files to upload
```

- **Instance seeding** runs on first startup (or if `.seed-complete` marker is missing)
- **Mod seeding** runs on every startup — new mods are picked up without volume wipe
- Set `"instance.auto_start": false` in `instance.json` to prevent auto-starting

## Key Constraints

| Constraint | Why |
|-----------|-----|
| Controller hostname must be `clusterio-controller` | Hosts default `CONTROLLER_URL` to `http://clusterio-controller:8080/` |
| Host hostnames must follow `clusterio-host-N` | The token file is named after the host (`clusterio-host-N.token`), and the controller issues files for N in 1..`HOST_COUNT` only |
| Host ids are not N | The controller assigns them (at random on new clusters; hosts upgraded from 2.0.3 keep theirs) and the host takes its id from its token. Host names are not unique in Clusterio 2.1: address hosts by id in scripts, by name only when one host has it |
| External plugins mount must be **read-write** | `npm install` runs inside each plugin directory |
| `factorio-client` volume should be `external: true` | Preserves ~450 MB download across `docker compose down -v` |
| Game port ranges auto-derive from the name's number | `clusterio-host-N` → ports `34000 + N × 100` to `+99` (N=1 → `34100-34199`, N=10 → `35000-35099`; `34N00-34N99` below is shorthand for this). Fresh hosts only; a saved range is kept |
| Every container that mounts `shared-tokens` can read `config-control.json` | It is the cluster-admin credential for `INIT_CLUSTERIO_ADMIN`, and the volume also holds every host's token. Host containers are inside the controller's trust domain. A remote host authenticates with `CLUSTERIO_HOST_TOKEN` and never mounts the volume |
| Host token files are checked on every controller start | `config-control.json` is written on the first run only. Each host token file is kept while the controller accepts it; a missing or rejected one is re-issued through the host pairing endpoint unless a host of that name is still registered. A token cannot be rotated in place: `clusterioctl host revoke` deletes the host and unassigns its instances, the next start issues a new token under a new id, and the instances must be assigned again. `CLUSTERIO_HOST_TOKEN` takes precedence over the file |
| Raising `HOST_COUNT` needs a recreated controller | `docker compose up -d` re-reads the environment; `docker compose restart` does not |
| Hosts created in the last 60 s die with a killed controller | The controller saves its database every 60 s and on a graceful stop. Killed within 60 s of creating hosts (first start, or after raising `HOST_COUNT`), it loses them and anything else done in that window (instances, assignments); on the next start it issues new tokens under new ids and the hosts follow |
| The controller recognises a host by its token file, then by name | Only a host without a usable token file is matched by the name `clusterio-host-N`. A host whose `host.name` was changed and whose token file is lost is not recognised: the controller issues a token for a new host of that name, and the old host's instances stay assigned to the old id |
| A wiped host data volume keeps identity, not data | The host gets its id back from the token file and its instances stay assigned, but their saves and files lived on that volume and are gone |

## Selecting bundled plugins in release builds

Both Dockerfiles accept `CLUSTERIO_PLUGINS`: `all` (the unchanged default), `none`,
or a comma-separated selection of `global_chat,player_sync,player_auth,research_sync,statistics_exporter,subspace_storage`
(`inventory_sync`, the pre-2.0 name of `player_sync`, is rejected with a hint).

```sh
docker build -f Dockerfile.controller --build-arg CLUSTERIO_PLUGINS=none -t my-controller .
docker build -f Dockerfile.host --build-arg CLUSTERIO_PLUGINS=none -t my-host .
```

The development Compose overlay forwards the same variable. This applies only to
`CLUSTERIO_TARGET=release`; custom builds use their source tree's plugins. It is a
build input, not a runtime environment switch. Published defaults remain unchanged.

Clusterio discovers installed plugin packages automatically. A smaller plugin-list
does not disable installed bundled plugins. Install your packaged plugins with
normal npm in a derived image (they must be Clusterio 2.1 plugins — see External Plugins above)
and verify the discovered set before starting saves.

## Host configuration precedence

The host reconciles configuration before running pre-start hooks:

| Setting | Fresh volume | Existing volume |
|---|---|---|
| Host name | HOST_NAME | Saved name is preserved, even if the container name changes |
| Controller token | Explicit nonempty CLUSTERIO_HOST_TOKEN, then token file | Explicit token, then token file, then saved token |
| Host ID | The id the effective token was issued for (its `host` claim) | Same, on every boot: it follows the token in use |
| Controller URL | Explicit CONTROLLER_URL, otherwise default endpoint | Explicit CONTROLLER_URL replaces it; omission preserves the saved URL |
| Game port range | Explicit FACTORIO_PORT_RANGE, otherwise derived from the number in HOST_NAME (decimal: `-01` → `34100-34199`) | Explicit range replaces it; omission preserves the saved range |
| Log retention | Explicit CLUSTERIO_LOG_RETENTION_DAYS, otherwise Clusterio's default (`30`) | Explicit value replaces it; omission preserves the saved value |
| Instances directory | data/instances | Saved path is preserved |
| Factorio directory | Detected client/headless installation | Reconciled to the detected installation |

Empty optional token, URL, port and log-retention variables are treated as unset.
Default CONTROLLER_HTTP_PORT
only contributes to a fresh host's fallback URL; use CONTROLLER_URL to change an existing
host's endpoint. Token filenames follow HOST_NAME, so renaming a container to a name that has
its own token file moves the host to that token and its id. Changing an existing host's
identity is a deliberate operation: set its token and the id that token names together in a
hook (`node /scripts/host-token.cjs id FILE` prints the id).

After the hooks, the host asks the controller whether it accepts the token
(`GET /api/host-pairing/check`) before starting:

| Answer | Host |
|---|---|
| Accepted | Starts |
| Rejected, token from CLUSTERIO_HOST_TOKEN | Exits 1 at once |
| Rejected, token from a file or saved | Waits for its token file to change, configures again (hooks run again) and rechecks; exits 1 if no new file appears within 300 s, counted in total across reconfigurations |
| No answer, or a 5xx/429 answer (e.g. a reverse proxy in front of a controller that is down) | Logs `Waiting for the controller to answer before starting the host...` and keeps waiting, without limit |
| Any other answer (a controller older than Clusterio 2.1 answers 404) | Starts |
| The check cannot run | Exits 1 |

An invalid effective `host.controller_url` (not `http(s)://…`) or host id stops the container
with an error instead of waiting. `docker stop` during any of these waits, or the first-boot
wait for a token, ends the container at once (`Stopped before the host started`). A first
configuration that fails (an invalid `CLUSTERIO_LOG_RETENTION_DAYS`, an unusable token)
leaves no `config-host.json` behind, so the next start is a first start again.

A new token updates the token and ID fields without deleting the configuration. Unreadable
configuration stops startup and remains available for diagnosis. Native writes are checked
with one configuration read after all writes, since the pinned CLI can log a rejected value
and return zero. This verification checks accepted values, not connectivity. Writes are
individual native operations, not an atomic transaction.

## Configuring before startup

Mount a directory read-only at `/etc/clusterio/pre-start.d`, or COPY scripts there.
Files ending in `.sh` run through Bash in C-locale filename order as `clusterio`.
They run on every boot after native configuration/bootstrap and before server startup.
Hooks are the final configuration authority. The readiness guard reads the effective ID
and URL afterward. A nonzero hook exit stops startup.

Scripts receive `CLUSTERIO_ROLE` and `CLUSTERIO_CONFIG_PATH`. Make them idempotent.
They have access to the runtime user's configuration and secrets.

Example `10-local-settings.sh`:

```sh
set -eu
/clusterio/node_modules/.bin/clusterio"$CLUSTERIO_ROLE" --log-level error --config "$CLUSTERIO_CONFIG_PATH" config set "$CLUSTERIO_ROLE.allow_remote_updates" false
```

Local `config show FIELD` returns a scalar; strings are raw, not JSON-quoted.
Use remote `clusterioctl host config set ...` on a running host. Local writes are
locked while it runs; some local-only fields require a pre-start hook instead.

## Persistent state and migration

The base Compose file now mounts controller `/clusterio/data`, `/clusterio/mods`,
`/clusterio/static`, `/clusterio/tokens` and `/clusterio/logs`, plus each host's
data and logs. Host mods are a downloadable cache. Preserve the Factorio installation
volume to avoid downloading it again. Include configured plugin storage in backups.

**Existing installations must migrate before recreating containers.** Empty volumes hide
the old container directories; a container's writable layer is not persistent storage.

1. Stop the existing containers without removing them (`docker compose stop`, not `down`).
2. Copy controller mods, static assets and logs, and host logs to a separate backup with
   `docker cp CONTAINER:/clusterio/DIRECTORY ./BACKUP`. Record each directory's file list
   and sizes; keep the original stopped containers until the copy is verified.
3. Populate the corresponding new project-scoped volumes from that backup. Confirm
   ownership allows the image's `clusterio` user to read/write them.
4. Verify the copy before recreating containers with the new Compose file. Check mods,
   served assets and logs after startup; retain backups until acceptance is complete.

The PR does not perform this migration on a running installation.

## Upgrading from 2.1.1

Images from `2.1.2` (first pin `2.1.2.r1`) bundle Clusterio 2.1.2. Change the tag on the
controller and every host and recreate the containers (`docker compose up -d`); there is no
migration step. Details in `CHANGELOG.md` (the Clusterio `2.1.2` entry). Check three things:

- **Slow links.** The controller closes an upload or download that moves less than about
  1.8 MiB in a minute (about 30 KiB/s); on 2.1.1 the limit was 30 KiB in 30 seconds. The
  setting is `controller.transfer_min_speed` (KiB/s, default `64`, `0` for no limit) and
  replaces `controller.transfer_min_progress`. A saved value is converted on load; a script
  or hook that still sets the old key changes nothing and gets no failing exit code.
- **External plugins.** Plugins load concurrently, so one that relied on plugin list order
  must wait for the other plugin (`plugins.waitFor`). See
  [plugin-development.md](plugin-development.md) for the other API changes.
- **Log directories.** The `.*-audit.json` files are no longer used and can be deleted.

Coming from `2.0.3`: follow the next section and pin `2.1.2.r1` directly.

## Upgrading from 2.0.3

Images from `2.1.1` (first pin `2.1.1.r1`) bundle Clusterio 2.1. Details in `CHANGELOG.md`
(the Clusterio `2.1.1` entry). Below, `ctl` stands for
`docker exec clusterio-controller npx clusterioctl --config /clusterio/tokens/config-control.json`,
run on the controller's machine. Steps, in order:

1. **Decide log retention before the first start on 2.1.1.** Clusterio 2.1 deletes log files
   older than 30 days at start and hourly, starting with the first start after the upgrade.
   To keep them, set `CLUSTERIO_LOG_RETENTION_DAYS=0` (or another number of days) on the
   controller and on every host. The entrypoints write it before the server starts.
2. **On 2.0.3, before upgrading: deal with every instance that loads `subspace_storage`.**
   On 2.1.1 such an instance refuses to start when its mod pack lacks the `subspace_storage`
   mod (>= `1.99.0`). The 2.1.1 controller's automatic download of required mods does not
   exist yet on 2.0.3, so do one of these first:
   - stop the plugin loading on each affected instance:
     `ctl instance config set <instance> subspace_storage.load_plugin false`. After the
     upgrade, once the mod is in the pack, set it back to `true`. (`instance.json` applies
     only to instances seeding creates, not to existing ones.)
   - add `subspace_storage` and its dependency `clusterio_lib` to the mod pack by hand
     (upload the zips and add them to the pack).

   Other ways out: a controller-wide `ctl controller config set subspace_storage.load_plugin
   false` (then restart the controller), or a `CLUSTERIO_PLUGINS` build without the plugin.
   After the upgrade, a 2.1.1 controller with Factorio credentials downloads both zips at
   start, for the default mod pack's Factorio version, into its mod store; it adds them to
   no pack. `FACTORIO_USERNAME` / `FACTORIO_TOKEN` reach the controller's config only on its
   first run, so on an existing cluster set them with
   `ctl controller config set controller.factorio_username <name>` and
   `ctl controller config set controller.factorio_token <token>`.
3. **Rebuild external plugins that have a web module with Vite** (see External Plugins above)
   and mount them prebuilt.
4. **Update scripts that drive `clusterioctl`.** Address hosts by id (look it up with
   `ctl host list --output json`), not by the number in the host name, and parse
   `--output json` instead of tables. Replace any use of `host generate-token`,
   `host revoke-token`, `host create-config` or `bootstrap generate-host-token`: they are
   removed.
5. **Upgrade the controller and every host together**: pin both images to `:2.1.2.r1`, then
   recreate the cluster (`docker compose up -d`). Let the controller stop gracefully (it saves
   its database on a graceful stop and every 60 s).
6. **Check the result.** `ctl host list` shows every host connected. Hosts that had
   connected under 2.0.3 keep their id, token and assigned instances. A host whose token file
   existed but that never connected gets a new token and id on the controller's first start.
7. **If the controller warns that `clusterio-host-N is registered` but its token file is
   missing or rejected**, run `ctl host revoke clusterio-host-N` (this unassigns its
   instances), restart the controller, and once the host has reconnected under its new id,
   assign each of its instances again: `ctl instance assign <instance> <host id>`.

What breaks:

- **Host ids on new clusters are assigned by the controller at random**; `clusterio-host-1`
  no longer has id 1. Upgraded clusters keep the ids of hosts that had connected.
- **Host token files are written after the controller starts**, on every start, for
  `clusterio-host-1..HOST_COUNT`. Hosts wait for theirs (300 s on first boot) and check the
  token with the controller before starting. To add a host, raise `HOST_COUNT` and recreate
  the controller (`docker compose up -d`). A remote host takes the file's content as `CLUSTERIO_HOST_TOKEN`.
- **A token cannot be rotated in place.** `clusterioctl host revoke` deletes the host and
  unassigns its instances; the next controller start issues a new token under a new id, and
  the instances must be assigned again. The "Generate Token" button on the web UI's Hosts
  page is removed.
- **`CLUSTERIO_HOST_TOKEN` decides `host.id`**, and a token the controller rejects stops the
  host at once.
- **`clusterioctl` prints results on stdout**, commands without a result print
  `Command ran successfully`, and `instance list` has three new trailing columns
  (`isTemplate`, `templateId`, `modPackId`).
- **A headless export exports no icons** instead of blank ones; the host log says so.
- **Custom builds need Clusterio source at `2.1.1` or newer.**

Unchanged: token file names, `HOST_COUNT`, `CLUSTERIO_HOST_TOKEN` precedence, the
`clusterio-host-N` convention, the port ranges (`34000 + N × 100` to `+99`), `EXPORT_HOST=N`, and Factorio
2.1.x downloaded at runtime.

## Upgrading to Clusterio 2.0 images

Images from `2.0.1` bundle the first stable Clusterio 2.0 line. What changes for a consumer
moving from a `2.0.0-alpha.27` image (details in `CHANGELOG.md`, 2026-10-14):

- **`inventory_sync` is `player_sync`** (`@clusterio/plugin-player_sync`). Rename
  `inventory_sync.*` fields in seed `instance.json` files and `inventory_sync` in
  `CLUSTERIO_PLUGINS` (the old name is rejected with a hint). When `player_sync` is bundled,
  Clusterio migrates an existing cluster's `inventory_sync.*` config fields, permissions and
  data on load (the migration lives in the plugin); images built without it simply retain
  the old fields as unknown.
- **`/clusterio/tokens/config-control.json` carries `ctl.*` keys** (`ctl.controller_url`,
  `ctl.controller_token`); the filename is unchanged. The controller rewrites an existing
  file's `control.*` keys in place on boot (same token). Readers that parse the JSON must use
  the new keys; the host boot-race guard accepts either.
- **`/metrics` needs a token** for a user holding `core.controller.metrics` —
  `scripts/prometheus.yml` has the role/user/token recipe.
- **External and packaged plugins must be 2.0 plugins** (ES modules, `.js` entrypoint names,
  default-function entrypoints); see External Plugins above.
- **Config files are created explicitly.** Tooling that drives the native CLI against a config
  path that does not exist yet must run `config create` first. Pre-start hooks are unaffected:
  they run after the entrypoint has created the file.
- Clusterio 2.0 requires Node 22+; the images run Node 24.

## Consumer verification

Verify native commands and shared plugin dependency resolution offline:

```sh
docker run --rm --network none --user clusterio --entrypoint node my-controller /scripts/verify-cli.cjs controller '["ci_fixture"]'
```

Supply the exact expected discovered plugin array for your image. Without that argument,
the command reports discovered plugins and checks their shared dependencies, but does not
claim that a particular selection was tested. It supports release packages, derived images,
and custom source layouts. Incompatible peer requirements or duplicate lib/web_ui resolution
fail verification; update compatible dependencies instead of deleting arbitrary packages.

For real startup, recreation and configuration-conflict checks, use the commands and
scenario matrix in [tests/README.md](../tests/README.md). The runner records image identities,
individual results, unverified cases and cleanup. Minimal and selected release combinations
run in CI; publication also accepts its exact full release/custom images before pushing them.
