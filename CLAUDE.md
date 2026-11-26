# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the clusterio-docker project.

## Project Overview

**clusterio-docker** provides pre-built Docker images for running [Clusterio](https://github.com/clusterio/clusterio) clusters — a clustered Factorio server manager. The project publishes two container images to GHCR:

| Image | Purpose |
|-------|---------|
| `ghcr.io/clusterio/clusterio-docker-controller` | Web UI, API, cluster coordination |
| `ghcr.io/clusterio/clusterio-docker-host` | Factorio headless server host (runs game instances) |

**Note**: GHCR image names include `-docker-` because the CI derives them from the repository name (`clusterio-docker`).

**Clusterio version**: `release` builds are pinned to **`2.1.2`** via the `CLUSTERIO_VERSION` build arg (see Build Arguments). Bump it in both Dockerfiles to upgrade (see Release Process). `custom`/`factorio-*` branch builds compile from the bundled `clusterio/` source instead.

**Clusterio 2.x behaviour the entrypoints depend on** (the images run Node 24): plugins are ES modules with `.js` entrypoint names, ctl config keys are `ctl.*`, config files are created with an explicit `config create`, and `/metrics` needs a token — see Pitfalls #12–#14. Hosts are created by the controller, which assigns their ids, and host tokens come from the host pairing endpoint (the controller entrypoint issues them, see Host Token Issue and Check); `subspace_storage` requires its mod in the mod pack; log files older than the retention setting are deleted; `clusterioctl` has `--output json`; plugin web modules are built with Vite — see Pitfalls #15–#18. What changed with each Clusterio version is recorded in `CHANGELOG.md`.

**Factorio version**: the default `release` target runs Factorio **2.1.x** (`DEFAULT_FACTORIO_VERSION` defaults to `2.1`; the default mod packs are `Base Game 2.1` and `Space Age 2.1`, the latter with the `recycler` builtin enabled). The `custom` target builds Clusterio from source instead of npm, for a Factorio line the npm release does not support — see Branch model in README.md.

## Repository Structure

```
clusterio-docker/
├── .env.example                   # Environment template (all settings in one file)
├── Dockerfile.controller          # Controller image (Node.js + Clusterio controller/ctl + plugins)
├── Dockerfile.host                # Host image (Node.js + Clusterio host/ctl + Factorio headless + plugins)
├── docker-compose.yml             # Default 2-host cluster; pulls the published images
├── docker-compose.dev.yml         # Overlay that adds build contexts (source builds)
├── scripts/
│   ├── controller-entrypoint.sh   # Controller startup: first-run detection, bootstrap, host tokens, seeding
│   ├── host-entrypoint.sh         # Host startup: token loading, config, token check
│   ├── provision-hosts.cjs        # Controller: issues clusterio-host-1..HOST_COUNT tokens via the host pairing endpoint
│   ├── host-token.cjs             # Both images: prints the host id a token was issued for
│   ├── ctl-json.cjs               # Both images: answers questions about `clusterioctl --output json` results (no jq)
│   ├── seed-instances.sh          # Instance creation, assignment, save upload, auto-start
│   ├── export-host-lib.sh         # Sourced by seed-instances.sh + regenerate-export-data.sh: what counts as a headless host
│   ├── seed-mods.sh               # Mod upload to controller
│   ├── install-plugins.sh         # External plugin npm install
│   ├── install-release.cjs        # Release target: npm install of @clusterio/* at CLUSTERIO_VERSION + CLUSTERIO_PLUGINS
│   ├── configure-host.cjs         # Host config reconciliation through the native CLI
│   ├── verify-cli.cjs             # Offline native CLI + plugin-resolution check (consumer verification)
│   ├── run-pre-start.sh           # Runs /etc/clusterio/pre-start.d hooks as clusterio
│   ├── prometheus.yml             # Optional Prometheus scrape config (token-gated /metrics)
│   ├── regenerate-export-data.sh  # Controller: re-runs export-data for an instance; refuses headless hosts
│   ├── stream-logs.sh             # Sourced by both entrypoints: mirrors on-disk logs to stdout ([cluster-log])
│   ├── ctl-config.cjs             # config-control.json: control.* → ctl.* migration; host-reachable copy for the boot-race guard
│   ├── check-plugin-resolution.cjs  # Used by verify-cli.cjs: shared @clusterio dependency resolution
│   └── patches/disable-immutable-cache.js  # Controller: /static revalidation patch (CONTROLLER_STATIC_CACHE_MODE)
├── seed-data/                     # Example seed data (used by CI tests)
│   ├── controller/database/       # users.json, roles.json
│   ├── hosts/                     # Instance folders per host
│   ├── mods/                      # Factorio mod .zip files
│   └── external_plugins/          # External Clusterio plugins
├── tools/
│   ├── build-custom-context.py    # Builds custom-target images from an existing Clusterio checkout
│   ├── deploy-cluster.ps1         # Hot-deploy compiled Clusterio source to running containers
│   └── get-admin-token.ps1        # Retrieve admin token from running controller
├── tests/                         # Unit tests and the container acceptance runner (tests/README.md)
├── docs/
│   ├── asset-export.md            # Game client and export-data
│   ├── clusterio-engineering-notes.md  # Upstream behaviours the images work around
│   ├── consumer-integration.md    # Downstream consumer integration guide
│   ├── multi-cluster.md           # Several clusters on one Docker host
│   ├── plugin-development.md      # Developing a plugin against the images
│   └── seed-data.md               # Seed data documentation
└── .github/workflows/
    ├── docker-build.yml           # CI: gates, tests, build, push to GHCR, GitHub Release
    └── cache-cleanup.yml          # Deletes a closed PR's build caches
```

## Architecture

### Container Startup Flow

#### Controller (`controller-entrypoint.sh`)

```
1. Create data dirs, fix permissions, remove stale lock files from an unclean stop
2. Install external plugins (npm install if mounted)
3. FIRST_RUN check: does config-controller.json exist on the data volume?
   ├── YES → Skip to step 4
   └── NO (first run):
       a. Copy seed database files (users.json, roles.json)
       b. `config create` (2.0: config files are created explicitly), then configure
          controller (port, public URL, factorio credentials)
       c. Bootstrap admin user (idempotent — checks if already in DB)
       d. Generate config-control.json (API token; `ctl.*` keys) → shared tokens volume
4. CLUSTERIO_LOG_RETENTION_DAYS set? → write controller.log_retention_days (every boot; invalid value → exit 1)
5. Migrate a pre-2.0 config-control.json (control.* → ctl.* keys, in place, idempotent)
6. Static-cache patch, pre-start hooks
7. Start controller in background, wait until it answers HTTP
8. Host tokens (every start, HOST_COUNT > 0): provision-hosts.cjs, for N in 1..HOST_COUNT
   ├── clusterio-host-N.token accepted by GET /api/host-pairing/check → keep it
   ├── a host named clusterio-host-N is registered → WARNING, issue nothing
   └── otherwise → POST /api/host-pairing (admin token) → write clusterio-host-N.token (0600)
   A failure is logged as ERROR and does not stop the controller.
9. SEED check: FIRST_RUN=true OR .seed-complete marker missing?
   ├── NO → seed-mods.sh only (new mods), skip to step 10
   └── YES:
       a. Set default mod pack
       b. seed-mods.sh: upload .zip mods to controller
       c. seed-instances.sh: create instances, assign to hosts, upload saves, start
       d. Write .seed-complete marker to data volume
10. Write .seed-healthy, wait on controller process (keep container alive)
```

#### Host (`host-entrypoint.sh`)

```
1. Create data dirs, fix permissions, remove stale lock files from an unclean stop
2. Install external plugins (npm install if mounted)
3. Pre-cache seed mods (copy from seed-mods mount → host mods dir)
4. Runtime client download (if FACTORIO_USERNAME + FACTORIO_TOKEN set, no client yet, SKIP_CLIENT!=true)
   └── Download once → stored in external volume (/opt/factorio-client), persists across restarts
5. Select Factorio directory: volume client → image client → headless
   - The **headless** path (`/opt/factorio`) is a **multi-version parent directory**, **empty by default** — Clusterio downloads the mod-pack's target headless version at runtime on Linux (Wube's EULA forbids bundling it). A non-direct layout is what enables that; `BAKE_FACTORIO_HEADLESS=true` pre-bakes a version in a subdir for private/offline images. The **client** paths are direct installs (no auto-update; pinned to the baked/downloaded client).
   - Runtime-downloaded headless versions land in `/opt/factorio` on the **image layer** (a cache), so they survive `restart` but are re-downloaded after `down`/recreate. Mount a volume at `/opt/factorio` if you want downloaded versions to persist.
6. No config-host.json yet? → wait for a token (CLUSTERIO_HOST_TOKEN or clusterio-host-N.token, up to 300s, then exit 1)
7. Configure host via configure-host.cjs reconcile (fresh volume: `config create` first; a failed first
   configuration removes config-host.json again). Token: CLUSTERIO_HOST_TOKEN, then token file, then saved
   token; host.id from that token's `host` claim; name, controller URL, port range, log retention, paths.
   Then pre-start hooks, then read the effective host.id + controller URL (invalid → exit 1).
8. Token check: configure-host.cjs check → GET /api/host-pairing/check with the configured token
   ├── 200 accepted → step 9
   ├── 401 rejected
   │   ├── token from CLUSTERIO_HOST_TOKEN → exit 1
   │   ├── token file changed → back to step 7 (hooks run again), recheck
   │   └── otherwise wait for the file to change (300s in total across reconfigurations), then exit 1
   ├── no answer, or 5xx/429 → "Waiting for the controller to answer before starting the host...", keep waiting
   ├── any other answer (a controller older than Clusterio 2.1 answers 404) → step 9
   └── check could not run → exit 1
   (SIGTERM during steps 6–8 → "Stopped before the host started", exit 143)
9. Start the boot-race guard in background, start host (exec)
```

### Seeding Flow (`seed-instances.sh`)

```
1. Wait for all expected hosts to connect (up to 30 attempts × 2s)
2. Scan seed-data/hosts/<hostname>/ directories; resolve each folder to a host id:
   the id its clusterio-host-N.token was issued for, else the only host with that name, else id N
   (clusters set up before Clusterio 2.1); none, or the host list cannot be read → ERROR, skip the folder
3. For each instance directory:
   a. Idempotency check: skip if an instance with exactly that name exists (`instance list --output json`)
   b. Create instance via clusterioctl
   c. Apply instance.json config (if present), skipping runtime-specific fields — while still unassigned
   d. Assign to the resolved host id
   e. Upload .zip save files
   f. Start instance (unless instance.auto_start=false); a mod pack lacking a plugin's required mods
      stops the retries and prints the controller's error
```

## Key Design Decisions

### First-Run Detection
- **Controller**: Checks for `config-controller.json` on the data volume. If absent → `FIRST_RUN=true`.
- **Host**: Checks for `config-host.json`. If absent, waits up to 300 s for a token before configuring.
- **Seed completion**: A `.seed-complete` marker file is written after successful API seeding (instances, mods). This allows interrupted first runs to be re-attempted on next startup.

### Idempotency Guarantees
| Operation | Idempotent? | Mechanism |
|-----------|:-----------:|-----------|
| Controller config | ✅ | `FIRST_RUN` flag (file existence check) |
| Admin user creation | ✅ | `grep` check in users.json |
| Admin ctl config (`config-control.json`) | ✅ | Inside `FIRST_RUN` block only |
| Host token issue | ✅ | Every start; a token the controller accepts is kept; a registered host name is never paired again |
| Instance creation | ✅ | Exact-name lookup in `instance list --output json` before `instance create` |
| Mod upload | ⚠️ Partial | Errors swallowed; controller may reject duplicates |
| Mod pack membership | ✅ | `--add-mods` is idempotent; already-added mods are unchanged |
| API seeding block | ✅ | `.seed-complete` marker file |
| Host configuration | ✅ | Saved name + id from the token in use + explicit overrides + native batch readback |

### Host Token Issue and Check
Clusterio 2.1 signs a host token only for a host the controller has created, and the controller picks the host's id. On every start, after the controller answers HTTP, `provision-hosts.cjs` keeps each `clusterio-host-N.token` (N in 1..`HOST_COUNT`) the controller still accepts and creates the missing ones through `POST /api/host-pairing` with the admin token. It never pairs a name that is already registered (host names are not unique in Clusterio 2.1, so a second pairing would add a second host beside the first); it logs a warning with the recovery: `clusterioctl host revoke clusterio-host-N` (unassigns its instances), restart the controller, and once the host has reconnected under its new id, assign its instances again (Pitfall #18). A host it created but could not write a token file for is revoked again, so the name is not blocked. The controller recognises a host by its token file first and only then by the name `clusterio-host-N`: a host whose `host.name` was changed and whose token file is lost is not recognised, so the controller issues a token for a new host of that name and the old host's instances stay assigned to the old id. The controller saves its database at an interval (`controller.autosave_interval`) and on a graceful stop; killed before the first save after creating hosts, it loses them (and anything else done since the last save), issues new tokens under new ids on the next start, and the hosts follow.

The host sets `host.id` from its effective token on every boot and asks `GET /api/host-pairing/check` before starting, because a 2.1 host started with a rejected token does not exit: it opens a join request and waits for approval without rereading its token file. Results:
- Wiped controller volume: every token is re-issued under new ids; hosts see their token rejected, wait for the new file and reconfigure.
- Wiped host volume: the host re-adopts the id from its token file; its instances stay assigned, but their saves and files were on that volume and are gone.
- Raised `HOST_COUNT`: the new host's token is issued once the controller is recreated (`docker compose up -d`; `docker compose restart` does not re-read the environment).

Explicit CLUSTERIO_HOST_TOKEN takes precedence over the mounted token and decides `host.id`; a rejected one exits 1 at once. See the host configuration contract in docs/consumer-integration.md.

### Hostname Conventions
- Host names **must** follow `clusterio-host-N` pattern for automatic token loading
- The host reads the token file named after its `HOST_NAME` (`clusterio-host-N.token`); the controller issues those files for `clusterio-host-1..HOST_COUNT` only
- The number N is extracted via `grep -oE '[0-9]+$'`. It picks the default port range `34000 + N × 100` to `+99` (`34N00-34N99` for N 1–9; N=10 → `35000-35099`; read as decimal: `clusterio-host-01` → `34100-34199`) and the `EXPORT_HOST=N` match
- N is **not** the host id: the id comes from the token (random on new clusters; hosts upgraded from 2.0.3 keep theirs)
- Seed data directories under `hosts/` must match hostnames exactly

## Environment Variables

### Controller
| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `INIT_CLUSTERIO_ADMIN` | **Yes** | — | Admin username (first run only) |
| `CONTROLLER_HTTP_PORT` | No | `8080` | Web UI / API port |
| `CONTROLLER_PUBLIC_ADDRESS` | No | — | Public URL for external access (sets `controller.public_url`) |
| `HOST_COUNT` | No | `0` (standalone) / `2` (compose) | Hosts `clusterio-host-1..N` the controller issues a token for (every start) and seeding waits for |
| `EXPORT_HOST` | No | `1` (compose) | Number N of the host `clusterio-host-N` with game client for export-data (not the host id). Set to `0` or empty to skip. |
| `DEFAULT_MOD_PACK` | No | `Base Game 2.1` (standalone) / `Space Age 2.1` (compose) | Mod pack name for instances (created if not found; DLC auto-enabled if name contains "Space Age") |
| `DEFAULT_FACTORIO_VERSION` | No | `2.1` | Factorio version for auto-created mod packs |
| `FACTORIO_USERNAME` | No | — | Factorio.com username |
| `FACTORIO_TOKEN` | No | — | Factorio.com token |
| `CLUSTERIO_LOG_RETENTION_DAYS` | No | — (Clusterio: `30`) | Written to `controller.log_retention_days` before start, every boot, when set. Whole number; `0` keeps logs forever; invalid → exit 1 |

### Host
| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `HOST_NAME` | No | Container hostname | Must match `clusterio-host-N` pattern |
| `CONTROLLER_URL` | No | `http://clusterio-controller:8080/` | Controller address |
| `CLUSTERIO_HOST_TOKEN` | No | Auto from shared volume | Manual token override; also decides `host.id`. Rejected by the controller → exit 1 |
| `CLUSTERIO_LOG_RETENTION_DAYS` | No | — (Clusterio: `30`) | Written to `host.log_retention_days` before start, every boot, when set. Whole number; `0` keeps logs forever; invalid → exit 1 |
| `FACTORIO_USERNAME` | No | — | Factorio.com username — triggers runtime game client download on first startup |
| `FACTORIO_TOKEN` | No | — | Factorio.com token (from factorio.com/profile) |
| `FACTORIO_CLIENT_BUILD` | No | `expansion` | Runtime client variant: `expansion` (Space Age) or `alpha` (base game) |
| `FACTORIO_CLIENT_TAG` | No | `stable` | Factorio client version tag for runtime download |
| `SKIP_CLIENT` | No | `false` | Set to `true` to force headless even when game client is available |

### Build Arguments (set in `docker-compose.dev.yml` or with `--build-arg`)
| Argument | Default | Description |
|----------|---------|-------------|
| `CLUSTERIO_TARGET` | `release` | Build target: `release` (npm registry) or `custom` (local source in `clusterio/`) |
| `CLUSTERIO_PLUGINS` | `all` | Release-only bundled selection: all, none, or comma-separated names. Custom builds use their source plugins. |
| `CLUSTERIO_VERSION` | `2.1.2` | Pinned Clusterio version for the `release` target. All `@clusterio/*` packages install at this exact version. Ignored by the `custom` target. Bump to upgrade. |
| `NODE_IMAGE` | `node:24-bookworm-slim@sha256:…` | Base Node image, pinned by digest for reproducible builds. Refresh periodically for Debian/Node security patches (see comment in the Dockerfiles). |
| `BAKE_FACTORIO_HEADLESS` | `false` | Bake the Factorio headless server into the image. **Default `false`** — the public image ships no Factorio (Wube's EULA forbids redistributing it) and Clusterio downloads the target version at runtime. Set `true` only for private/offline images you don't redistribute. |
| `FACTORIO_HEADLESS_TAG` | `stable` | Factorio headless version to bake — **only used when `BAKE_FACTORIO_HEADLESS=true`** |
| `FACTORIO_HEADLESS_SHA256` | — | SHA256 checksum for the baked headless archive (bake-only; skips verification if empty) |
| `INSTALL_FACTORIO_CLIENT` | `false` | Install full game client alongside headless for graphical asset export |
| `FACTORIO_CLIENT_BUILD` | `expansion` | Client variant: `alpha` (base game) or `expansion` (Space Age) |
| `FACTORIO_CLIENT_TAG` | `stable` | Factorio client version tag (same format as headless) |
| *(credentials)* | — | **Not build args.** `INSTALL_FACTORIO_CLIENT=true` requires BuildKit secrets `factorio_username` / `factorio_token` — see Pitfall #8 |
| `FACTORIO_CLIENT_SHA256` | — | SHA256 checksum for game client archive (skips verification if empty) |
| `CURL_RETRIES` | `8` | Number of curl retry attempts for Factorio downloads |

The base `docker-compose.yml` has no `build:` section. The `docker-compose.dev.yml` overlay sets build args per service under `build.args`: `CLUSTERIO_TARGET` and `CLUSTERIO_PLUGINS` are interpolated from `.env`, and the per-host client args (e.g. host-1 with game client, host-2 headless-only) are edited in the overlay.

### Custom Clusterio Build (Fork)
To use a Clusterio fork instead of the npm-published packages:
Use the existing canonical Clusterio source checkout. Run
`python tools/build-custom-context.py ../clusterio --build` to create a Docker build archive
and both local custom images without creating another checkout. See tests/README.md for acceptance.
The source must be Clusterio `2.1.1` or newer: the entrypoints use the host pairing endpoint and `clusterioctl --output json`.

The custom target uses a multi-stage build: a builder stage runs `pnpm install` (which compiles TypeScript + bundles the web UI), then the built monorepo is copied into the final image. pnpm hoists bins to `node_modules/.bin/` so all `npx clusterio*` commands work unchanged.

## Volume Mounts

| Mount Point | Purpose | Notes |
|-------------|---------|-------|
| `/clusterio/data` | All persistent data (config, DB, instances) | Docker volume recommended |
| `/clusterio/mods` | Controller mod archives | Persistent controller volume; host copy is a cache |
| `/clusterio/static` | Exported assets | Persistent controller volume |
| `/clusterio/logs` | Log history | Separate persistent volume per container |
| `/etc/clusterio/pre-start.d` | Ordered non-root hooks | Read-only scripts, every boot before server startup |
| `/clusterio/tokens` | Shared token exchange | Controller: rw, Hosts: ro |
| `/clusterio/seed-data` | Seed data for first run | Controller only, read-only |
| `/clusterio/seed-mods` | Mod pre-cache for hosts | Hosts only, read-only |
| `/opt/factorio-client` | Runtime-downloaded game client | `external: true` — survives `down -v` |
| `/clusterio/external_plugins` | External plugin directories | **Must be read-write** (npm install runs) |

**Critical**: External plugins mount must NOT be `:ro` — the entrypoint runs `npm install` inside each plugin directory.

## Development Workflow

Follow [AGENTS.md](AGENTS.md) and [container acceptance](tests/README.md) for startup changes.
`scripts/configure-host.cjs` owns host input reconciliation; `run-pre-start.sh` runs hooks;
`verify-cli.cjs` checks native behavior and shared plugin dependency resolution.

### Quick Start
```bash
cp .env.example .env
# Edit .env: set INIT_CLUSTERIO_ADMIN=your_username
docker volume create factorio-client
docker compose up -d
# Access Web UI at http://localhost:8080
```

### Building Locally
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build   # Both images (the base file alone has no build configuration)
docker build -f Dockerfile.controller -t clusterio-controller .  # Controller only
docker build -f Dockerfile.host -t clusterio-host .              # Host only
```

### Clean Restart
```bash
docker compose down -v   # Remove containers AND volumes (factorio-client persists — it's external)
docker compose up -d     # Fresh start with re-seeding
```

### Restart (Keep Data)
```bash
docker compose restart   # Preserves volumes, no re-seeding
```

### Get Admin Token
```powershell
./tools/get-admin-token.ps1
# Or manually:
docker exec clusterio-controller cat /clusterio/tokens/config-control.json
```

### Viewing Logs
```bash
docker logs clusterio-controller              # Controller logs
docker logs -f clusterio-host-1               # Follow host-1 logs
docker logs clusterio-controller | grep seed  # Check seeding status
```

### Hot Deploy (Custom Fork)
When using `CLUSTERIO_TARGET: custom` with a local fork, use the hot-deploy script to push code changes to running containers without rebuilding images:
```powershell
./tools/deploy-cluster.ps1                         # Build + deploy to all containers
./tools/deploy-cluster.ps1 -Target controller      # Deploy to controller only
./tools/deploy-cluster.ps1 -NoBuild                # Deploy previously compiled artifacts
./tools/deploy-cluster.ps1 -NoBuild -NoRestart     # Deploy without restarting
```
The script compiles TypeScript locally via `pnpm install`, then copies `dist/` directories into containers via `docker cp`. Dependency changes (package.json) still require an image rebuild. Before copying anything, the script reads `clusterioTarget` from each target container's `/clusterio/BUILD_INFO` and exits 1 unless it is `custom`. It needs PowerShell 7 (`pwsh`); Windows PowerShell 5.1 cannot parse the file.

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/docker-build.yml`):
1. Builds both images with Docker Buildx + GHA cache
2. Pushes to GHCR on non-PR events, once the `gates`, `test` and `consumer-smoke` jobs pass (tags: the branch or git tag name, `<branch>-clusterio-<version>` on branch pushes, plus `latest` and the Clusterio version on `main`)
3. Runs integration tests (the `test` job):
   - Database seeding (admin user)
   - Mod seeding (upload + host pre-cache)
   - Instance seeding (create, save upload, auto-start control)
   - **Idempotent restart** (verifies no duplicate instances after `docker compose restart`)

### Release Process

Releases happen on the default branch (`main`) and build the **`release`** target
(`CLUSTERIO_TARGET=release`, npm packages, pinned to `CLUSTERIO_VERSION`).

1. **Bump the version** — set `ARG CLUSTERIO_VERSION` to the new Clusterio version in **both** `Dockerfile.controller` and `Dockerfile.host` (e.g. `2.1.2`). This single value pins the `@clusterio/*` npm packages **and** the published image tag. Update the version references in this file, `README.md`, and `docs/consumer-integration.md` to match (CI's version-assert gate fails otherwise). In the same PR, point **both** `PREVIOUS_HOST_IMAGE` and `PREVIOUS_CONTROLLER_IMAGE` in `.github/workflows/docker-build.yml` at the digests of the newest published pin of the **outgoing** version (`docker buildx imagetools inspect ghcr.io/clusterio/clusterio-docker-host:<old-version>.r<N> --format '{{.Manifest.Digest}}'`, and the same for `clusterio-docker-controller`) so the `upgrade` and `cluster-upgrade` acceptance cases cross the version boundary being released — no gate checks this.
2. **Open a PR → merge to `main`.** On a PR, CI builds the `release` target and runs the full integration suite (seeding, instance start, idempotent restart) — exactly what will publish. Merge once green.
3. **Publish is automatic on the `main` push.** Both images publish to GHCR tagged `:latest` **and** `:<CLUSTERIO_VERSION>` (e.g. `:2.1.2`). The version tag is read from the `CLUSTERIO_VERSION` build arg, so it always matches what's installed. These are **moving** tags — a rebuild on the same Clusterio version overwrites them.
4. **Cut an immutable revision pin** — to publish a reproducible pin, `git tag <CLUSTERIO_VERSION>.r<N>` (e.g. `2.1.2.r1`) and push the tag. CI's tag build publishes `:<CLUSTERIO_VERSION>.r<N>` verbatim on the `release` target, then its `release` job creates the GitHub Release `<tag> — Clusterio <version>` with the top `CHANGELOG.md` entry as notes (an existing release is left unchanged). `.rN` resets to `r1` on each Clusterio bump; increment it for docker-layer rebuilds/fixes that ship on the same Clusterio version. See "Versioning" below.
5. **Make packages public (one-time).** GHCR packages default to private. To allow public `docker pull`: GitHub → profile → Packages → each package (`clusterio-docker-controller`, `clusterio-docker-host`) → Package settings → Change visibility → Public.

### Versioning (Clusterio version + docker revision)

clusterio-docker's version **tracks the Clusterio version**, with a docker-layer revision suffix
`.rN` for rebuilds/fixes that ship on the same Clusterio version. There is **no** separate repo
SemVer: a `v*` git tag matches no workflow trigger. Tags carried by a build:

- `:<CLUSTERIO_VERSION>` — e.g. `:2.1.2` — the bundled Clusterio version. **Moves** as the docker layer rebuilds.
- `:<CLUSTERIO_VERSION>.rN` — e.g. `:2.1.2.r1` — the **immutable** pin (cut a git tag to mint one). `N` resets to `r1` on each Clusterio bump; bump it for docker-layer changes on the same Clusterio version.
- `:latest`, `:main` — newest `main` build. Move.

**Separator is `.` not `-`**: a hyphen (`2.0.0-alpha.27-r1`) makes `27-r1` a single alphanumeric
SemVer prerelease identifier. SemVer precedence ranks alphanumeric identifiers above purely-numeric
ones at the same field position, so that tag would sort as *newer* than `2.0.0-alpha.28` under any
SemVer-aware tooling (Renovate, Dependabot, etc.). The `.` keeps `rN` a separate dot-delimited identifier, so numeric
comparison on the Clusterio version field (`27` vs `28`) still wins first.

**Revision (`.rN`) discipline**: increment `.rN` for any image-affecting change on an unchanged
Clusterio version (entrypoint/seeding/compose fixes, security rebuilds). A breaking
docker-interface change (env/volume/behavior) is signalled by the CHANGELOG notice (the changelog
gate enforces one) plus the `.rN` bump — consumers pin `:<version>.rN` and read CHANGELOG before
moving to a new pin. There is no separate "major" signal.

**Note:** the Clusterio (npm) version is independent of the Factorio version Clusterio downloads at runtime (or, when baking, `FACTORIO_HEADLESS_TAG`).

### Branch-Based Custom Builds

The `custom`/fork path is for a Factorio line the npm release does not support (branch
`factorio-<X.Y>` off `main`) and for testing a Clusterio fork branch. `main` builds `release`
(npm); only the paths below build `custom`.

Non-main branch **pushes** automatically build from the Clusterio fork instead of npm packages (pull requests into `main`, `main`, and tags build the `release` target so CI validates exactly what gets published):

1. CI clones `https://github.com/solarcloud7/clusterio` at the **matching branch name**
2. If the branch doesn't exist in the fork, it falls back to the fork's **default branch** (`master`)
3. The clone step fails if the fork source is older than Clusterio `2.1.1` (the entrypoints need the host pairing endpoint and `clusterioctl --output json`)
4. Images are built with `CLUSTERIO_TARGET=custom` and pushed with the branch name as tag

**Example**: Push to a `beta` branch in clusterio-docker → CI tries to clone `clusterio:beta`, falls back to `clusterio:master` → publishes `:beta` tagged images.

**Workflow for testing a Clusterio PR branch**:
```bash
# In clusterio fork: push your feature branch (e.g., my-feature)
# In clusterio-docker: push a branch with the same name
git checkout -b my-feature
git push  # → CI builds :my-feature images from the fork's branch

# Consumer project uses the tagged images:
#   image: ghcr.io/clusterio/clusterio-docker-controller:my-feature
#   image: ghcr.io/clusterio/clusterio-docker-host:my-feature
```

`main`, tags, and PRs into `main` use `CLUSTERIO_TARGET=release` (npm registry packages); non-main branch pushes and PRs into `factorio-*` branches build `custom`.

## Included Clusterio Plugins

Both images install these official plugins:
- `global_chat` — Cross-server chat
- `player_sync` — Sync player inventories and state (named `inventory_sync` before Clusterio 2.0; `CLUSTERIO_PLUGINS` rejects the old name)
- `player_auth` — Player authentication
- `research_sync` — Sync research progress
- `statistics_exporter` — Prometheus metrics
- `subspace_storage` — Shared item storage (an instance that loads it needs the `subspace_storage` mod in its mod pack — Pitfall #16)

## Seed Data Convention

The `seed-data/` directory structure drives first-run provisioning:

```
seed-data/
├── controller/
│   └── database/          # Copied BEFORE controller starts (direct file copy)
│       ├── users.json     # Pre-created user accounts
│       └── roles.json     # Permission roles
├── mods/                  # Uploaded to controller via API AFTER start
│   └── *.zip
├── external_plugins/      # Mounted into containers for npm install
│   └── my_plugin/
│       └── package.json
└── hosts/
    └── clusterio-host-N/  # Folder name MUST match hostname
        └── InstanceName/
            ├── instance.json  # Optional: Clusterio instance config
            └── *.zip          # Save files to upload
```

### instance.json

Native Clusterio `InstanceConfig` format. Runtime-specific fields are auto-skipped:
`instance.id`, `instance.name`, `instance.assigned_host`, `factorio.host_assigned_game_port`, `factorio.rcon_port`, `factorio.rcon_password`, `factorio.mod_pack_id`, `_warning`

Set `"instance.auto_start": false` to prevent auto-starting after seeding.

## Common Pitfalls

### 1. External Plugins Mount Must Be Read-Write
**Symptom**: Plugin not loaded, npm install errors
**Cause**: Mounting with `:ro` — entrypoint needs to run `npm install`
**Fix**: Remove `:ro` from the external_plugins volume mount

### 2. Host Name Must Match Pattern
**Symptom**: Host logs `Waiting for host token...`, then `ERROR: Timed out waiting for host token after 300s`; or it gets the wrong default port range
**Cause**: Hostname doesn't follow `clusterio-host-N` pattern, N is above `HOST_COUNT`, or N is zero-padded (`clusterio-host-01` looks for `clusterio-host-01.token`; the controller writes `clusterio-host-1.token`)
**Fix**: Ensure hostname and HOST_NAME env var match `clusterio-host-N` with N in 1..`HOST_COUNT`, or pass the token with `CLUSTERIO_HOST_TOKEN`

### 3. Seed Data Directory Names Must Match Hostnames
**Symptom**: Instances not created on expected host
**Cause**: Folder name under `seed-data/hosts/` doesn't match container hostname
**Fix**: Rename folder to match exactly (e.g., `clusterio-host-1`)

### 4. Consumer Projects: Image Names Include `-docker-`
**Symptom**: Image pull fails with `ghcr.io/clusterio/clusterio-controller`
**Cause**: GHCR CI derives image name from repo name (`clusterio-docker`)
**Fix**: Use `ghcr.io/clusterio/clusterio-docker-controller` and `ghcr.io/clusterio/clusterio-docker-host`

### 5. Controller Hostname Must Stay `clusterio-controller`
**Symptom**: Hosts can't connect to controller
**Cause**: Consumer changed the controller's hostname in their compose file
**Fix**: Keep hostname as `clusterio-controller` (container name can be different). Alternatively, set `CONTROLLER_URL` on each host to match the new hostname.

### 6. Game Port Range Auto-Derived from the Host Name's Number
**Symptom**: Multiple hosts assign the same game port to instances, making some unreachable
**Cause**: All hosts used the same default port range
**Fix**: `configure-host.cjs` derives a fresh host's port range from the number N in its name (not from the host id): `34000 + N × 100` to `+99` (`clusterio-host-1` → `34100-34199`, `clusterio-host-10` → `35000-35099`). An existing host keeps its saved range. Override with `FACTORIO_PORT_RANGE` env var if needed. Docker-compose port mappings must match (e.g., host 2 maps `34200-34209:34200-34209/udp`).

### 7. DEFAULT_MOD_PACK and DLC Mods
**Symptom**: Instances start without DLC mods (Space Age, etc.) or export-data is missing DLC assets
**Cause**: `DEFAULT_MOD_PACK` was set to `"Base Game 2.1"` (no DLC)
**Fix**: Set `DEFAULT_MOD_PACK=Space Age 2.1` in controller env. If the name contains "Space Age", the entrypoint automatically enables the `space-age`, `elevated-rails`, `quality`, and `recycler` builtin mods when creating the pack (recycler is a hard dependency of space-age + quality in 2.1.x). If the name doesn't match an existing pack, it's created automatically using `DEFAULT_FACTORIO_VERSION`. The default mod pack is set during first-run seeding only; on an existing cluster set `factorio.mod_pack_id` on each instance (README, "Changing DEFAULT_MOD_PACK after first run").

### 8. Factorio Client Credentials Must Be BuildKit Secrets, Not Build Args
**Symptom**: `docker build --build-arg FACTORIO_CLIENT_TOKEN=… ` does not install the client; the build fails asking for secrets
**Cause**: `--build-arg` values are visible via `docker history`, and the `ARG` declaration alone trips Docker's `SecretsUsedInArgOrEnv` lint. There are no `FACTORIO_CLIENT_USERNAME` / `FACTORIO_CLIENT_TOKEN` build args — passing them has no effect.
**Fix**: Supply credentials as BuildKit secrets. `Dockerfile.host` mounts them at `/run/secrets/*` on a tmpfs that is discarded when the `RUN` ends, so no value reaches a layer:
```bash
docker build -f Dockerfile.host --build-arg INSTALL_FACTORIO_CLIENT=true --secret id=factorio_username,env=FACTORIO_USERNAME --secret id=factorio_token,env=FACTORIO_TOKEN .
```
Via compose, `docker-compose.dev.yml` declares the two secrets (`environment:` sourced from `FACTORIO_USERNAME`/`FACTORIO_TOKEN`); uncomment host-1's `secrets:` block alongside `INSTALL_FACTORIO_CLIENT`.

Notes: `Dockerfile.host` line 1 **must** stay `# syntax=docker/dockerfile:1` — parser directives are only honoured at the very top, and the secret mounts need it. The mounts are deliberately optional (`required=false`) because that `RUN` executes on every build and only its `if` body is conditional; a guard inside the branch fails loudly instead. Residual: the token still travels in the download URL's query string, and curl echoes URLs in some failure messages, so keep failed client-build logs private.

**Most users should skip all of this** and use the **runtime download** — set `FACTORIO_USERNAME` + `FACTORIO_TOKEN` as host env vars and no credential touches the build. Baking is only for private/offline images that cannot reach factorio.com at container start. Published images never take this path: CI passes only `CLUSTERIO_TARGET` and `BUILD_REVISION`.

### 9. Game Client Image Is Much Larger Than Headless
**Symptom**: A locally built host image is much larger than the published one
**Cause**: `INSTALL_FACTORIO_CLIENT=true` bakes the full game client into the image (and `BAKE_FACTORIO_HEADLESS=true` a headless server)
**Fix**: Only enable it for hosts that need export-data with icons. The headless server is sufficient for running game instances — the client is only needed for Clusterio's graphical asset export.

### 10. External Plugin Installs Duplicate @clusterio Packages
**Symptom**: Plugin permissions "not found", events not firing, or other singleton-mismatch errors
**Cause**: `npm install` in the plugin directory installs `@clusterio/lib` (and other peer deps) locally into the plugin's `node_modules/`. This creates two separate module instances — the plugin registers permissions/events in its copy while the controller reads from the monorepo copy.
**Fix**: `install-plugins.sh` removes `node_modules/@clusterio` after `npm install`, forcing Node.js to resolve upward to the image's copies. CI's "Verify external plugin lifecycle" step checks this with the `ci_fixture` plugin.

### 11. Headless Factorio Directory Must Be a Multi-Version Parent
**Symptom**: The host never downloads or updates the headless server, and the installed version isn't driven by the mod pack's Factorio version
**Cause**: `host.factorio_directory` points at a **direct** install (a dir with `data/` + version file). Clusterio does not download Factorio into a direct install.
**Fix**: `host.factorio_directory` must be a **non-direct, multi-version parent**. The entrypoint sets it to `/opt/factorio` — empty by default, so Clusterio downloads the target version into a versioned subdir at runtime. An optional baked headless (`BAKE_FACTORIO_HEADLESS=true`) goes into a **subdirectory** of `/opt/factorio`, never directly into it (that would re-disable runtime download). (The game **client** path for export hosts is intentionally a direct install and does not auto-update.)

### 12. Clusterio 2.0 Plugins Are ES Modules With `.js` Entrypoint Names
**Symptom**: An external plugin npm-installs and is listed, but never loads; the controller/host reports that an entrypoint module cannot be found, or that the entrypoint has no usable export
**Cause**: Clusterio 2.0 loads plugins with `import()`. Entrypoint paths without the `.js` extension (`controllerEntrypoint: "controller"`) do not resolve, and a CommonJS `plugin` export is only detected in the `module.exports = { plugin }` form.
**Fix**: Convert the plugin per upstream `docs/devs/plugin-migration-to-2.0.md`: `"type": "module"`, `.js` in entrypoint names, default async function entrypoints (class exports still load with a deprecation warning). `seed-data/external_plugins/ci_fixture` is the minimal example. Clusterio 2.1 additionally rejects a web module built with webpack (it must be rebuilt with Vite) — see `docs/plugin-development.md` and upstream `docs/devs/plugin-migration-to-2.1.md`.

### 13. `config set` Against a Missing Config File Fails
**Symptom**: Any `config set`/`list`/`show` on a fresh volume fails because the config file cannot be loaded
**Cause**: Clusterio creates config files only on request (`config create`).
**Fix**: The entrypoints, `configure-host.cjs` and `verify-cli.cjs` run `config create` first (a no-op once the file exists). Tooling that drives the native CLI against a new path must do the same; pre-start hooks run after the file exists.

### 14. `/metrics` Requires a Token
**Symptom**: Prometheus scrapes are refused (no token, or the token's user lacks the permission)
**Cause**: Clusterio gates `/metrics` behind the `core.controller.metrics` permission; hosts expose no HTTP metrics endpoint at all.
**Fix**: Create a role with that permission and a dedicated user (`#prometheus`), mint a token with `clusteriocontroller bootstrap generate-user-token`, and pass it via `authorization:` in `scripts/prometheus.yml` (see the README's Prometheus section). Two traps in that recipe: `generate-user-token` is a separate process that reads `users.json` from disk, and a user created via `clusterioctl` only reaches the file on the controller's next autosave (`controller.autosave_interval`) — wait or restart first; and run it as `clusterio` (`docker exec --user clusterio`), or the bootstrap process leaves root-owned log files that break the controller's log rotation.

### 15. Host IDs Are Not the Number in the Host Name
**Symptom**: `clusterioctl instance assign X 1`, `host config list 1` or a script that addresses `clusterio-host-N` as host id `N` does not reach that host
**Cause**: Clusterio 2.1 controllers assign host ids at random when the host is created. Hosts of clusters upgraded from 2.0.3 keep the ids they had. Host names are not unique in Clusterio 2.1.
**Fix**: Look the id up (`docker exec clusterio-controller npx clusterioctl --config /clusterio/tokens/config-control.json host list --output json`, or `docker exec clusterio-controller node /scripts/host-token.cjs id /clusterio/tokens/clusterio-host-N.token`) and address hosts by id; address a host by name only when one host has it.

### 16. `subspace_storage` Instances Refuse to Start Without Its Mod
**Symptom**: Instance start fails with an error that its mod pack does not have the mods required by the loaded plugins; seeding logs `WARNING: instance '…' cannot start: its mod pack lacks mods a loaded plugin requires` followed by the controller's error
**Cause**: Clusterio 2.1 plugins can declare required mods; `subspace_storage` requires the `subspace_storage` mod in the instance's mod pack. The plugin is loaded by default.
**Fix**: One of (`ctl` below = `docker exec clusterio-controller npx clusterioctl --config /clusterio/tokens/config-control.json`):
- Add `subspace_storage` and its dependency `clusterio_lib` to the mod pack. A controller with Factorio credentials downloads both zips at start, for the default mod pack's Factorio version, into its mod store, and adds them to no pack. `FACTORIO_USERNAME`/`FACTORIO_TOKEN` reach the controller's config only on its first run; on an existing cluster set them with `ctl controller config set controller.factorio_username <name>` and `… controller.factorio_token <token>`.
- Stop the plugin loading: on an existing instance `ctl instance config set <instance> subspace_storage.load_plugin false`; for instances seeding creates, `"subspace_storage.load_plugin": false` in `instance.json` (it applies only to instances seeding creates); controller-wide `ctl controller config set subspace_storage.load_plugin false`, then restart the controller.
- Build with a `CLUSTERIO_PLUGINS` selection without it.

The seeded `TestInstance`/`TestInst2` set `subspace_storage.load_plugin: false`.

### 17. Logs Older Than 30 Days Are Deleted
**Symptom**: Old files under `/clusterio/logs/cluster`, `/clusterio/logs/controller` or `/clusterio/logs/host` disappear, starting with the first start on Clusterio 2.1
**Cause**: Clusterio deletes log files older than `controller.log_retention_days` / `host.log_retention_days` (default `30`), beginning when the server starts.
**Fix**: Set `CLUSTERIO_LOG_RETENTION_DAYS` on the controller and on each host (`0` keeps logs forever). The entrypoints write it before the server starts, so set it before the first start on Clusterio 2.1 to keep older logs. A value that is not a whole number stops the container.

### 18. Host Waits for the Controller or Its Token Is Rejected
**Symptom**: Host log repeats `Waiting for the controller to answer before starting the host...`, or shows `The controller rejects this host's token — waiting for it to issue a new token file at …`, then exits with `ERROR: the controller rejects this host's token and no new token file appeared …`; or exits at once with `ERROR: the controller rejects the token in CLUSTERIO_HOST_TOKEN …`
**Cause**: The host checks its token (`GET /api/host-pairing/check`) before starting. The first message means nothing answers at `host.controller_url`, or the answer is a 5xx/429 (e.g. a reverse proxy in front of a controller that is down); the wait is unbounded, and `docker stop` ends it. A rejected token means the host was revoked, the token came from another controller, or its host was never registered. A file token is replaced by the controller on its next start for N in 1..`HOST_COUNT` unless a host of that name is still registered; then the controller logs `WARNING: clusterio-host-N is registered (host id …) but …` and issues nothing. The 300 s allowance for a rejected file token is cumulative over reconfigurations.
A `host.controller_url` that is not `http(s)://…` does not wait: the container exits with `Invalid effective host.controller_url`.
**Fix**: Check `CONTROLLER_URL` and the controller. For a rejected token:
- N above `HOST_COUNT`: raise it and recreate the controller (`docker compose up -d`).
- The controller logged the "is registered" warning: `docker exec clusterio-controller npx clusterioctl --config /clusterio/tokens/config-control.json host revoke clusterio-host-N` (unassigns its instances), restart the controller, and once the host has reconnected under its new id, assign each of its instances again with `… instance assign <instance> <host id>` (same `docker exec` prefix; find the id with `host list --output json`).
- `CLUSTERIO_HOST_TOKEN`: supply a current token (`docker exec clusterio-controller cat /clusterio/tokens/clusterio-host-N.token`).
