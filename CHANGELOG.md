# Changelog — image change notices

Every push that changes image-affecting files (`Dockerfile.*`, `scripts/`,
`docker-compose*.yml`, `.github/workflows/`) must add an entry here; CI's changelog gate
fails the build otherwise. Newest first.

The top entry is published to each build's run summary and, on a tag build, as the GitHub
Release notes. Images carry `/clusterio/BUILD_INFO` (`gitSha`), so a running container
traces back to its notice.

Format: `## YYYY-MM-DD` heading, short bullets. Say what changed for someone running the
images and what they must do. State the Clusterio / Factorio versions when they change.

## 2026-11-25

- **Plugins from npm: `CLUSTERIO_NPM_PLUGINS`.** Set it on the controller and every host to a
  list of npm packages, each optionally with `@version`, comma or space separated
  (`<plugin>@<version>,<other-plugin>@<version>`). They are installed with their
  dependencies when the container starts; no mounts and no image of your own. Unset, nothing
  changes. The six official plugins were and are in the images.
  - The install lives in the container. A `restart` reuses it without the network; a
    recreated container installs again and must reach the npm registry.
  - The container exits 1 with `ERROR: CLUSTERIO_NPM_PLUGINS: …` when a package cannot be
    installed, lacks the `clusterio-plugin` keyword (Clusterio would not load it), or was
    built for another Clusterio version than the image's.
    With `restart: unless-stopped` it then restarts until the install succeeds.
  - To bake plugins into your own image, so a start needs no network: `FROM` the image, then
    `RUN gosu clusterio node /scripts/install-npm-plugins.cjs "name@version"`.
  - Release images only; a `custom` build refuses the variable. Plugin folders still go in
    `/clusterio/external_plugins`.
- **Fixed: installing a plugin could move the core packages.** `/clusterio/package.json`
  recorded caret ranges, so `npm install` of a plugin built for a newer Clusterio (Clusterio's
  own `plugin install` included) upgraded `@clusterio/controller` and `@clusterio/lib` and left
  the rest: a 2.0.3 image ended up with lib 2.1.2. The images now record exact versions, as
  dependencies and as npm `overrides`; every `@clusterio/*` package stays at the image's
  version, including one a plugin brings in that the image did not have.
  - npm therefore no longer refuses a plugin built for another Clusterio version.
    `CLUSTERIO_NPM_PLUGINS` checks that itself and refuses; a bare `npm install` or
    Clusterio's own `plugin install` installs it.
  - **Clusterio's remote update no longer changes its own packages.** The update commands
    (`controller update`, `host update`, the web interface's update button) run
    `npm update --save`; with the exact versions that now succeeds and changes nothing for
    `@clusterio/*` packages, and a plugin update pinned to a version fails with `EOVERRIDE`.
    Before, on a `2.1.1.r1` controller the same command moved the named packages to 2.1.2
    inside the container, until it was recreated. Upgrade Clusterio by changing the image tag.
- **Fixed: a controller that failed to start left its container running.** When the controller
  process stopped before it answered HTTP (a plugin that throws while loading, a config file it
  cannot read), the container waited for it forever and no restart policy applied. It now
  exits with the controller's status after `ERROR: the controller stopped before it answered
  HTTP`. With `restart: unless-stopped` such a controller now restarts in a loop instead of
  sitting idle; `docker logs` shows the cause above that line.
- Clusterio `2.1.2`, unchanged.

## 2026-11-22

- **Clusterio `2.1.2`** (from `2.1.1`). First pin: `2.1.2.r1`. Node `24.22.3`, the Factorio
  2.1 target and the entrypoints are unchanged. Upstream notes: the 2.1.2 section of
  Clusterio's `CHANGELOG.md`. From a `2.1.1` image: change the tag on the controller and
  every host and recreate the containers; there is no migration step. **From `2.0.3` or
  older, the breaking changes are in the Clusterio `2.1.1` entry below**: follow
  `docs/consumer-integration.md` "Upgrading from 2.0.3" and pin `2.1.2.r1` directly.
- **Slow uploads and downloads are closed sooner.** `controller.transfer_min_progress` (KiB
  per 30 seconds, default 30) is replaced by `controller.transfer_min_speed` (KiB/s, default
  `64`, `0` for no limit). With the defaults the controller now closes a transfer that moves
  less than about 1.8 MiB in a minute (about 30 KiB/s); before, the limit was 30 KiB in 30
  seconds. This covers save, mod and export uploads and downloads through the controller. A
  saved value other than the old default is converted on load (`300` becomes `10`). For slow
  links, lower it or set `0`: `clusterioctl controller config set
  controller.transfer_min_speed <KiB/s>`.
  - A script or pre-start hook that still sets `controller.transfer_min_progress` changes
    nothing: the CLI prints `No field named 'controller.transfer_min_progress'` and exits 0.
- **External plugins: plugins load concurrently**, no longer one at a time in plugin list
  order. A plugin that needs another one loaded first waits for it with `plugins.waitFor`.
  `lib.ZipArchive.zipfile` is private (use `openStream` / `openRawStream`),
  `ModInfo.fromModFile` is `ModStore.readModInfo`, and `@clusterio/lib` no longer brings in
  `@types/node` (`docs/plugin-development.md`).
- **Logs.** Clusterio writes its log files itself now (winston-daily-rotate-file is gone).
  File names are the same, and `[cluster-log]` lines still reach `docker logs`. The
  `.*-audit.json` files in the log directories are no longer used and can be deleted.
- New instance options, off by default: `instance.restart_after_crash` restarts an instance
  that crashes after running for at least 10 minutes, up to `instance.crash_retry_attempts`
  (`3`) times. Both can be seeded through `instance.json` (`docs/seed-data.md`).
- **Tests and CI.** `PREVIOUS_HOST_IMAGE` and `PREVIOUS_CONTROLLER_IMAGE` are the `2.1.1.r1`
  digests, so CI's upgrade cases cross `2.1.1` → `2.1.2`. The `cluster-upgrade` case reads
  the host id from the token and the previous controller's Clusterio version from its
  `BUILD_INFO`, so it runs from a 2.1 cluster (both token files kept) as well as a 2.0.3
  one (the never-connected host's token replaced). CI no longer runs the `2.0.3` boundary.

## 2026-11-22

- **Clusterio `2.1.1`** (from `2.0.3`). First pin: `2.1.1.r1`. Node `24.22.3` and the
  Factorio 2.1 target are unchanged. Upstream notes: the 2.1.0 and 2.1.1 sections of
  Clusterio's `CHANGELOG.md`. Upgrade the controller and every host together. Steps:
  `docs/consumer-integration.md` "Upgrading from 2.0.3". `clusterioctl` commands below run in
  the controller container: `docker exec clusterio-controller npx clusterioctl --config
  /clusterio/tokens/config-control.json …`.
- **Before upgrading: log retention.** Clusterio 2.1 deletes log files older than 30 days at
  start and hourly, starting with the first start after the upgrade. New variable
  `CLUSTERIO_LOG_RETENTION_DAYS` (controller and each host, a whole number of days, `0` keeps
  logs forever). When set, it is written to `controller.log_retention_days` /
  `host.log_retention_days` before the server starts, on every boot. An invalid value stops
  the container. To keep older logs, set it to `0` before the first start on 2.1.1.
- **Before upgrading: `subspace_storage` needs its mod.** The plugin stays loaded by default.
  An instance whose mod pack lacks the `subspace_storage` mod (>= `1.99.0`) refuses to start.
  Do one of:
  - add `subspace_storage` and its dependency `clusterio_lib` to the mod pack. A 2.1.1
    controller with Factorio credentials downloads both zips at start, for the default mod
    pack's Factorio version, into its mod store; it adds them to no pack. The credentials
    reach the controller's config only on its first run (`FACTORIO_USERNAME` /
    `FACTORIO_TOKEN`); on an existing cluster set `controller.factorio_username` /
    `controller.factorio_token` with `clusterioctl controller config set`;
  - set `subspace_storage.load_plugin` to `false` on each existing instance
    (`clusterioctl instance config set <instance> subspace_storage.load_plugin false`; this
    works on 2.0.3 too, so it can be done before upgrading and undone once the mod is in the
    pack), in `instance.json` for instances seeding creates, or for the whole controller
    (`clusterioctl controller config set subspace_storage.load_plugin false`, then restart
    the controller);
  - build with a `CLUSTERIO_PLUGINS` selection that leaves it out.

  Seeding now prints the start error instead of only a timeout warning.
- **Breaking: host pairing.** Clusterio 2.1 issues a host token only for a host the controller
  has created. On every start, once it answers HTTP and before seeding, the controller checks
  `clusterio-host-1..HOST_COUNT`. A token file it still accepts is kept. A missing or rejected
  one is replaced through the host pairing endpoint (`POST /api/host-pairing`, admin token).
  If a host of that name is already registered, it logs a warning and issues nothing.
  Recovery: `clusterioctl host revoke clusterio-host-N` (unassigns its instances), restart
  the controller, and once the host has reconnected under its new id assign each instance
  again (`clusterioctl instance assign <instance> <host id>`). A host the controller created
  but could not write a token file for is revoked again, so its name stays free.
  - **Host ids are assigned by the controller at random on new clusters**: `clusterio-host-1`
    no longer has id 1. The host takes `host.id` from its token on every boot. The name's
    number N only picks the token file, the default port range, the seed folder and the
    `EXPORT_HOST` match. Host names are not unique in Clusterio 2.1, so scripts must address
    hosts by id, or by name only when one host has it.
  - Token files appear once the controller is up, not before it starts. Hosts wait for theirs
    (300 s on first boot).
  - Before starting, a host asks the controller whether it accepts its token. If the token is
    rejected, a token from `CLUSTERIO_HOST_TOKEN` exits 1 at once. Otherwise the host waits up
    to 300 s in total for its token file to change, configures again (pre-start hooks run
    again) and rechecks. With no answer, or a 5xx/429 answer, it keeps waiting; any other
    answer (a pre-2.1 controller answers 404) starts the host anyway. An invalid
    `host.controller_url` or host id stops the container. `docker stop` during any of these
    waits ends the container at once ("Stopped before the host started").
  - A first host configuration that fails (for example an invalid
    `CLUSTERIO_LOG_RETENTION_DAYS` or an unusable token) leaves no `config-host.json`, so the
    next start is a first start again.
  - Removed upstream: `clusterioctl host generate-token`, `host revoke-token`,
    `host create-config`, `clusteriocontroller bootstrap generate-host-token`, and the Hosts
    page's "Generate Token" button in the web UI. To add a host, raise `HOST_COUNT` and
    recreate the controller (`docker compose up -d`; `restart` does not re-read the
    environment). A
    remote host takes `/clusterio/tokens/clusterio-host-N.token` from the controller as
    `CLUSTERIO_HOST_TOKEN`, which now also decides `host.id`. New upstream:
    `clusterioctl host pending`, `approve <code>`, `reject <code>`, `revoke <host>`.
  - A token can no longer be rotated in place. `host revoke` deletes the host and unassigns
    its instances; the next controller start issues a new token under a new id.
  - Handled without operator action: raising `HOST_COUNT` (then recreating the controller);
    a wiped host data volume (same id from the token file, instances stay assigned, but their
    saves and files were on that volume and are gone); a wiped controller data volume (every
    token re-issued, hosts take the new one).
  - The controller saves its database every 60 s and on a graceful stop. A controller killed
    within 60 s of creating hosts loses them, with anything else done in that window; on its
    next start it issues new tokens under new ids and the hosts follow.
  - Unchanged: token file names, `HOST_COUNT`, `CLUSTERIO_HOST_TOKEN` precedence, the
    `clusterio-host-N` convention and the port ranges (`34000 + N × 100` to `+99`).
  - Existing 2.0.3 clusters: hosts that have connected keep their id, token and instances;
    nothing to do. A host that never connected gets a new token and id.
- **`clusterioctl` prints results on stdout**, and commands without a result print
  `Command ran successfully`. `--output json` is available. `instance list` has three new
  trailing columns (`isTemplate`, `templateId`, `modPackId`). The image scripts parse JSON;
  consumer scripts that parse tables should move to `--output json`.
- Headless export: `export-data` on a host without the game client still succeeds, but
  exports no icons (an empty spritesheet) instead of blank ones. The host log has a WARN that
  the base game's icon files were not found. Seeding and `regenerate-export-data.sh` say so;
  the guard, its exit codes (`3`, `4`) and `--allow-headless` are unchanged.
- **Breaking for plugins with a web module**: it must be built with Vite (`clusterioPlugin`
  from `@clusterio/web_ui/vite.mjs`). A webpack build still loads its controller, host and
  instance code, but its web UI is rejected ("Incompatible dist/web/manifest.json, the plugin
  must be rebuilt with Vite"). Mount such plugins prebuilt: the release images do not contain
  `vite`. `RequestError` is replaced by HTTP-style error classes, `lib.safeOutputFile` is
  `lib.atomicOverwriteFile`, host token APIs moved to `controller.hosts.*`, and the hosts
  datastore to `controller.hosts.records` (`set`, `delete`, `size`, the `update` event). See
  upstream `docs/devs/plugin-migration-to-2.1.md`.
- New clusters: upstream sets `controller.default_mod_pack_id` to `Base Game 2.1` at first
  start; `DEFAULT_MOD_PACK` still overrides it.
- New image files: `/scripts/ctl-json.cjs` and `/scripts/host-token.cjs` (both images),
  `/scripts/provision-hosts.cjs` (controller). New variable: `CLUSTERIO_LOG_RETENTION_DAYS`.
- CI:
  - New `PREVIOUS_CONTROLLER_IMAGE` (the `2.0.3.r2` controller, by digest) next to
    `PREVIOUS_HOST_IMAGE`. The acceptance harness takes `--previous-controller`.
  - New acceptance cases `host-wipe`, `scale-out`, `controller-wipe` and `cluster-upgrade`.
    `rotation`, `saved-identity`, `hook-identity` and `zero-id` assert the token-derived id.
    Every (re)started host must log `Started host`; real host tokens reach containers through
    the environment, not argv.
  - Both fork-clone steps fail when the fork source is older than Clusterio 2.1.1.
  - New unit tests `tests/ctl-json.test.cjs`, `tests/host-token.test.cjs` and
    `tests/provision-hosts.test.cjs`.
- Custom builds (`CLUSTERIO_TARGET=custom`) need Clusterio source at `2.1.1` or newer: the
  entrypoints use the host pairing endpoint and `clusterioctl --output json`.

## 2026-11-21

- **Behaviour change: `regenerate-export-data.sh` refuses a headless host.** A headless
  export does not fail: it succeeds with a blank spritesheet and replaces the mod pack's
  export manifest, blanking every web-UI icon. The script now exits before stopping the
  instance when the instance's host is headless (exit `3`) or cannot be determined (exit
  `4`). `--allow-headless` exports anyway.
  - "Headless" means `host.factorio_directory` is exactly `/opt/factorio`. A full game
    installed at that path is refused too; a client-less host using another directory is
    not detected.
  - `clusterioctl instance export-data` and the web UI's export action are upstream and
    remain unguarded.
- Seeding on a headless `EXPORT_HOST` logs a NOTE that icons are blank. The host startup
  warning says the same and fires for any headless export host, not only `SKIP_CLIENT=true`.
  Both used to say the export fails.
- **Fix: release builds pin `@clusterio/lib`.** Upstream depends on it as `^2.0.3`, so a
  `2.0.3` image built after Clusterio `2.1.0` was published (2026-11-14) would have shipped
  lib `2.1.1`. The build installs it at `CLUSTERIO_VERSION` and fails if any `@clusterio/*`
  package is off-version. The published `2.0.3.r2` images are unaffected.
- Base image: `node:24-bookworm-slim` re-pinned to `dc26ae92…`. Node `24.22.3` (from
  `24.20.0`), npm `11.19.1` (from `11.19.0`), Debian `12.15`.
- New controller-image file `scripts/export-host-lib.sh`: the definition of a headless host.
- `SECURITY.md` removed (upstream has none, and private vulnerability reporting is not
  enabled here). Key Constraints in `docs/consumer-integration.md` now states that every
  container mounting `shared-tokens` can read the cluster-admin credential, and that the
  token files there are written only on the controller's first run.
- CI:
  - Export-data is tested on every build; the step had always been skipped for lack of
    Factorio credentials.
  - The upgrade acceptance case uses this organisation's `2.0.3.r2` host image instead of
    the `ghcr.io/solarcloud7` alpha image. It is a same-version check until the next
    Clusterio bump, so CI no longer covers the alpha.27 → 2.0 host-configuration path.
  - `test` job capped at 60 minutes with a read-only token; `actions/checkout` and
    `actions/setup-node` at `v7`.
- Clusterio `2.0.3`, unchanged.

## 2026-11-06

- **Images moved to `ghcr.io/clusterio/clusterio-docker-controller` / `-host`**; the
  repository is now `clusterio/clusterio-docker`. The old
  `ghcr.io/solarcloud7/clusterio-docker-*` images stay pullable but are frozen at
  `2.0.3.r1`. The first pin under the new name is `2.0.3.r2`. Compose defaults and image
  labels point at the new location; no other image change. Clusterio `2.0.3`.

## 2026-10-28

- **Clusterio `2.0.3`** (from `2.0.2`). First pin: `2.0.3.r1`. No entrypoint or interface
  changes. [Upstream notes](https://github.com/clusterio/clusterio/releases/tag/v2.0.3).
  Relevant to these images:
  - Fixes instances that start together corrupting a shared Factorio download
    (clusterio#1105).
  - Opt-in Lua UDP messaging (`factorio.enable_lua_udp`, `factorio.lua_udp_port`, default
    off, Factorio ≥ 2.1.10). It binds localhost inside the host container, so there is no
    port to publish.
  - `player_sync` gains per-instance `player_sync.sync_*` options (default `true`) and
    `clusterioctl inventory-sync` tools; `research_sync` gains a cluster research queue;
    `clusterioctl note` is new.
  - External plugins using `@sinclair/typebox` should move to `^0.34`.
- CI: tag builds create the GitHub Release, with the top entry of this file as its notes.

## 2026-10-15

- **Clusterio `2.0.2`** (from `2.0.1`), an upstream patch release. Web plugin
  `controllerConnectionEvent` handlers receive the event name again (clusterio#1083). No
  entrypoint or interface changes. First pin: `2.0.2.r1`.

## 2026-10-14

- **Clusterio `2.0.1`** (from `2.0.0-alpha.27`), the first stable 2.0 line. Factorio target
  unchanged (2.1 packs).
  [Upstream notes](https://github.com/clusterio/clusterio/releases/tag/v2.0.0).
- **Breaking: `inventory_sync` is now `player_sync`** (`@clusterio/plugin-player_sync`).
  `CLUSTERIO_PLUGINS` rejects the old name. Seed `instance.json` fields are `player_sync.*`.
  When `player_sync` is bundled, existing `inventory_sync.*` config, permissions and data
  migrate on load.
- **Breaking: the keys in `/clusterio/tokens/config-control.json` are `ctl.controller_url` /
  `ctl.controller_token`** (were `control.*`). The filename is unchanged, and the controller
  rewrites an existing file in place on boot (same token). Tooling that parsed
  `control.controller_token` must read the new key (`tools/*.ps1` accept both).
- **Breaking: `/metrics` requires a token** for a user holding `core.controller.metrics`
  (401/403 otherwise). `scripts/prometheus.yml` documents the recipe. Its `clusterio-hosts`
  scrape job is removed: hosts have no HTTP endpoint.
- **Breaking: external plugins must be Clusterio 2.0 plugins**: ES modules whose declared
  entrypoints carry the `.js` extension and export a default async function (class exports
  still load, with a deprecation warning). See upstream
  `docs/devs/plugin-migration-to-2.0.md`.
- Entrypoints create config files explicitly (`config create`); in 2.0, `config set` against
  a missing file fails. `CLUSTERIO_SUPPRESS_DEV_WARNING` is removed (the banner is gone
  upstream).
- Fix: `CONTROLLER_PUBLIC_ADDRESS` now sets `controller.public_url`. Setting it used to
  abort the first run.

## 2026-09-30

- Hosts remove stale lock files at startup, as the controller already did. A killed host
  refused to restart ("a valid lock file exists") until the file was deleted by hand.

## 2026-09-27

- `docker stop` shuts the controller and hosts down gracefully. Both now run the Clusterio
  binary directly instead of through `npx`, which did not forward SIGTERM. Compose allows
  30s / 120s to stop.

## 2026-09-10

- **Compose persists controller mods, exported assets and logs in volumes. Existing
  deployments must migrate those container directories before recreating; there is no
  automatic migration.**
- Host token, controller URL and port overrides are reconciled without deleting saved
  configuration; saved identity is preserved.
- Pre-start hooks: scripts in `/etc/clusterio/pre-start.d` run as `clusterio` on every boot,
  after local configuration. A failing hook stops startup.
- Release builds can bundle all, none or a subset of plugins (`CLUSTERIO_PLUGINS`). Defaults
  are unchanged.
- Host readiness matches the host ID, so a saved display name that differs from `HOST_NAME`
  no longer blocks health. Unreadable configuration is reported instead of treated as
  missing.
- CI: publication tests the exact images it then pushes.

## 2026-09-06

- Mod seeding adds only the highest numeric version of each mod to the default pack, so
  `1.10.0` beats `1.9.0`. All seed archives are still uploaded.

## 2026-09-04

- The runtime game-client download resumes instead of restarting from byte 0 (up to 30
  attempts).
- **Revision pins use `.rN`, not `-rN`** (e.g. `2.0.0-alpha.27.r5`). SemVer-aware tooling
  ranked `2.0.0-alpha.27-r1` above `2.0.0-alpha.28`. The published `-r1` to `-r4` pins stay
  as they are; no more `-rN` tags are cut.
- `NODE_IMAGE` digest refreshed to the 2026-08-27 build of `node:24-bookworm-slim`.

## 2026-08-15

- Instance seeding applies `instance.json` before `instance assign`. Config pushed to an
  already-assigned instance could fault a host that was starting it. `SEED_DATA_DIR` is
  overridable (default unchanged).

## 2026-07-26

- **Publishing is gated on the integration suite.** Images, revision pins included, no
  longer publish when the suite fails.
- **Instance seeding reports its errors and stops acting on failed steps.**
  - A failed create or assign skips the rest of that instance; other instances still seed.
  - A failed save upload leaves the instance stopped instead of starting it on a fresh map.
  - A malformed `instance.json` is reported instead of silently defaulting.
  - When anything fails, `.seed-complete` is withheld so the next start retries. The
    controller stays up and healthy.
- Build-time client secrets have carriage returns stripped; a CRLF secret file corrupted
  the download URL.

## 2026-07-25

- **Breaking (build interface): the `FACTORIO_CLIENT_USERNAME` / `FACTORIO_CLIENT_TOKEN`
  build args are removed; credentials are BuildKit secrets.** `--build-arg` values are
  readable via `docker history`.
  - Migration: `docker build --build-arg INSTALL_FACTORIO_CLIENT=true --secret
    id=factorio_username,env=FACTORIO_USERNAME --secret id=factorio_token,env=FACTORIO_TOKEN .`
    Via compose, uncomment host-1's `secrets:` block in `docker-compose.dev.yml`.
  - The old build args have no effect, and a client build without secrets fails with the
    migration command. Builds without `INSTALL_FACTORIO_CLIENT=true` are unaffected.
  - `Dockerfile.host` line 1 must stay `# syntax=docker/dockerfile:1`.
- **Token files on the shared-tokens volume are `0600`, owned by `clusterio` (uid 1001)**;
  they were `0644`. `config-control.json` is a cluster-admin credential and every host
  mounts it. The boot-race guard's derived copy (`/clusterio/data/.guard-control.json`) is
  `0600` and removed on every exit path; it used to persist on the host data volume.
- CI: the version-assert gate checks `README.md`, `CLAUDE.md` and
  `docs/consumer-integration.md` and fails on an empty version; workflow inputs reach
  scripts through `env:` instead of `${{ }}` splicing.

## 2026-07-22

- **Clusterio `2.0.0-alpha.27`** (from `2.0.0-alpha.26`). npm alpha.27 carries the Factorio
  2.1 support the fork carried: the 2.1 API version, the Base Game / Space Age 2.1 default
  packs and the `recycler` builtin.
- **`main` is the active line again, built from the `release` (npm) target.** `:latest` and
  the Clusterio version tag publish from it; they were fork builds from `factorio-2.1.8`,
  now archived. The `custom`/fork build path is kept but dormant.
- **Versioning tracks the Clusterio version plus a docker revision.**
  `:<clusterio-version>` moves; `:<clusterio-version>-rN` is the immutable pin, cut from a
  git tag. The separate repo SemVer (`v*` tags) is retired.
- `docker-compose.yml` defaults to the `latest` image tag (was `factorio-2.1.8`).

## 2026-07-06

- Fix: external-plugin `npm install` on custom-target images. `/clusterio` is a pnpm
  workspace there, so the install failed for every external plugin. `install-plugins.sh`
  now passes `--workspaces=false`.
- CI: asserts the static-cache patch attached, `BUILD_INFO.clusterioTarget` and the per-host
  game-port ranges; adds an external-plugin lifecycle test with a fixture plugin
  (`seed-data/external_plugins/ci_fixture`; the `clusterio-plugin` keyword is required for
  a plugin to load); per-image build caches, deleted when a PR closes.

## 2026-07-05

- **Plugin logs stream to stdout.** The on-disk cluster/host logs are mirrored to container
  stdout with a `[cluster-log]` prefix (`CLUSTERIO_LOG_TO_STDOUT`, default `true`).
- **Healthy means ready.** The controller is healthy once seeding is complete; a host is
  healthy once connected to the controller (process-only when standalone). The seeder's
  `instance start` retries and fails loudly.
- **Static-cache patch.** `/static` is served with revalidation instead of `immutable, 1y`,
  which pinned stale web-UI chunks in returning browsers. Opt out with
  `CONTROLLER_STATIC_CACHE_MODE=immutable`.
- **Boot-race guard.** Once a host is connected, any instance that auto-started before the
  handshake is restarted once so its plugins register. Skipped on standalone hosts without
  the shared tokens volume.
- **Compose pulls prebuilt images** (`CLUSTERIO_IMAGE_TAG`). Source builds moved to the
  `docker-compose.dev.yml` overlay, and `CLUSTERIO_TARGET` defaults to `release`. (#13)
- **Multi-cluster.** Host port publishings (`HOST1_PORTS`, `HOST2_PORTS`) and the client
  volume name (`FACTORIO_CLIENT_VOLUME`) are set in `.env`. See `docs/multi-cluster.md`.
- `scripts/regenerate-export-data.sh` added, to run after a Factorio version bump. The host
  warns at startup when `SKIP_CLIENT=true` on the `EXPORT_HOST` host.
- Space Age packs enable `recycler`; space-age and quality depend on it in Factorio 2.1.x.
  A core missing a DLC builtin logs a WARNING instead of crash-looping the controller. (#13)
- Images carry `/clusterio/BUILD_INFO` and the `io.clusterio.version` label. Each push build
  also publishes `<branch>-clusterio-<version>`. (#13)
- The default branch is `factorio-2.1.8`; `latest` and the version tag publish from its
  custom (fork) builds until npm supports Factorio 2.1.
- CI: changelog gate (this file); PRs into `factorio-*` branches build and test the custom
  target; Actions moved to their Node 24 majors.
- Docs: `.npmrc legacy-peer-deps` requirement for plugins, `auto_pause` example set to
  `false`, README troubleshooting additions.

## 2026-06-22

- **Clusterio `2.0.0-alpha.26`** (all `@clusterio/*` packages, release target).

## 2026-06 (earlier)

- Target **Factorio 2.1.8**; CI asserts the default mod pack is "Space Age 2.1".
- Hosts log the installed Factorio version(s) at startup (#8); a plugin-build failure
  WARNING goes to stderr instead of being swallowed (#10).
