# Container acceptance

Fast regressions:

```sh
bash tests/seed-instances-order.test.sh
bash tests/seed-mod-versions.test.sh
bash tests/regenerate-export-guard.test.sh
node --test tests/*.test.cjs
```

Build the release selection you intend to test, then run one acceptance command:

```sh
docker build -f Dockerfile.controller --build-arg CLUSTERIO_PLUGINS=none -t acceptance-controller .
docker build -f Dockerfile.host --build-arg CLUSTERIO_PLUGINS=none -t acceptance-host .
node tests/consumer-smoke.mjs acceptance-controller acceptance-host \
  --previous-host ghcr.io/clusterio/clusterio-docker-host:2.1.1.r1 \
  --previous-controller ghcr.io/clusterio/clusterio-docker-controller:2.1.1.r1
```

The previous images must be available locally (pull them first when needed). CI pins their
digests (`PREVIOUS_HOST_IMAGE`, `PREVIOUS_CONTROLLER_IMAGE`).
Default expected plugins are `none`; pass `--plugins global_chat` for a selected image, or the
explicit comma-separated six names for a full image. Use `--skip-package` for custom
images: their pnpm workspace is not an npm installation target. The packaged-consumer case
runs on release selections separately. Ordinary CLI verification accepts an explicit
expected plugin array and checks shared package resolution; without an array it reports
discovery without claiming selection coverage.

Choose a single case with `--case NAME`. Omitting it runs every case. The `npm-plugins` case
installs `timeshade@0.1.1` from the npm registry and imports its instance entrypoint, so it
needs network access; it runs on release-target images only.

Hosts the cases restart are stopped before they are replaced, and count as ready only when
they are healthy **and** their own log contains `Started host`: the controller keeps a killed
container's session as connected for up to 60 s, which would otherwise satisfy readiness.
Real host tokens reach containers through the docker client's environment, not argv.

| Case | Contract |
|---|---|
| lifecycle | Fresh boot, non-root hooks, recreation, persisted configuration/mods/assets/logs, served asset bytes; after both containers were killed and recreated, the host runs under the id its token file names (whether or not the controller had saved the hosts it created) |
| shutdown | `docker stop` reaches the controller and host processes (graceful shutdown, no kill) and a controller setting changed just before the stop survives |
| stale-lock | A killed host leaves a lock naming PID 1 (followed by the process start time); recreated with no configuration writes before start, the host logs `Removing stale host lock file(s) from a previous run`, starts and reconnects. Clusterio 2.1 also treats such a lock as stale by itself, so the case proves the entrypoint removes it, not that the removal is still needed |
| rotation | An explicit token of another host (paired with the admin token) wins over the mounted token and decides the host id; omitting the override restores the file's token and id; unrelated configuration survives; a revoked host's token is rejected |
| overrides | Explicit URL/port changes apply; omitted inputs preserve saved values |
| saved-identity | A container renamed to a name without a token file keeps its saved name, token and id, and readiness still passes |
| hook-identity | A hook that sets another host's token and the id that token names, plus a URL, drives readiness; restoring both returns the original id |
| zero-id | A fresh host named `…-01` takes its id from its token and the port range 34100-34199 from its name |
| host-wipe | A host whose data volume is wiped comes back with the same id from its token file, is not registered as a new host, is connected, and its (save-less) instance stays assigned |
| scale-out | Recreating the controller (stopped gracefully, as `docker compose up -d` does) with a raised `HOST_COUNT` issues the new host's token, keeps the existing tokens, and a second recreation does not register the host twice |
| controller-wipe | After the controller data volume is wiped, a host started first logs that it is waiting for the controller; once the controller starts, the host logs `configuring the host again`, takes the re-issued token and its id, and keeps its saved name |
| failures | A failed hook prevents server startup |
| upgrade | Previous image's native CLI creates configuration on a fresh volume; candidate preserves settings and stored files and takes the id from the token |
| cluster-upgrade | A cluster created by the previous controller and host images restarts on the candidates: the host that had connected keeps its token, its id (1 from a pre-2.1 controller, the one in its token since) and assigned instance and is the only connected host; no host is registered twice; the host that never connected keeps its token when the previous controller is Clusterio 2.1 or newer (that controller created it) and gets a new, accepted one from an older controller |

The all-cases run also invokes `native-host-config.cjs` inside the host image. It checks
real CLI reads/writes, invalid numeric writes that return exit code zero, and unreadable
configuration preservation. Settings are written individually; verification reads once
after the batch. This is not an atomic configuration transaction.

Missing `--previous-host` records upgrade as **unverified**, and `cluster-upgrade` needs both
`--previous-host` and `--previous-controller`; either gap sets `coverageComplete: false`.
A passing run covers only its listed cases and build configuration. Tests use no game
world or client download. `cluster-upgrade` starts the candidates on a controller database
(hosts, instances), tokens and host configuration written by the previous images; it starts
no instance. Saves, game data and disaster recovery remain uncovered.

Reports and redacted, bounded logs are under `ci-artifacts/cd-smoke-*/`. Reports identify
images, BUILD_INFO, harness hash, individual cases and cleanup. Each run owns labelled
containers, volumes and a network; cleanup failure fails the run. A force-killed harness
may leave labelled resources, so inspect ownership before cleanup. Local images remain
for inspection.

## CI and local custom builds

PR CI tests minimal and selected release images with independent BuildKit cache scopes.
The publication job builds its actual release/custom target, runs acceptance on those
loaded full images, then pushes the same images without rebuilding. Existing seeded
integration continues to cover Factorio instance startup.

For a custom source test, use the existing canonical Clusterio checkout (Clusterio `2.1.1` or
newer: the entrypoints use the host pairing endpoint and `clusterioctl --output json`):

```sh
python tools/build-custom-context.py ../clusterio --build
node tests/consumer-smoke.mjs clusterio-custom-controller clusterio-custom-host --plugins global_chat,player_sync,player_auth,research_sync,statistics_exporter,subspace_storage --skip-package
```

The helper archives tracked source files and this repository's Docker build inputs;
it creates no checkout and excludes local dependencies and Git metadata. It records
the source revision, tracked modifications and context hash. Adjust the expected plugin
list deliberately when testing a fork with a different supported set.

## Review evidence

Local acceptance on 2026-09-10 (reports use UTC):

| Image under test | Evidence | Result |
|---|---|---|
| Original PR host at `c385326` | `cd-smoke-f768fc27-270` (rotation), `cd-smoke-4bc1a977-7d8` (overrides) | Failed: retained old token and old controller URL |
| Original PR host at `c385326` | `cd-smoke-112e620d-414` (saved identity), `cd-smoke-0c8b53fd-586` (zero-padded ID) | Failed: registered host never reached healthy readiness |
| Revised full release, native alpha.27 | `cd-smoke-709da0bf-2ab` | All eight startup scenarios and native configuration checks passed |
| Revised custom images from canonical source `9e727f9`, native alpha.25 | `cd-smoke-3434376f-94a` | All eight startup scenarios and native configuration checks passed |
| 2026-10-14: Clusterio 2.0.1 release at `b5de653` (PR #55) — native 2.0.1 on both roles, six bundled plugins incl. `player_sync`, previous host alpha.27.r7 | `cd-smoke-25769f81-ae5` | All ten startup scenarios (incl. `stale-lock`, the ESM `--import` shutdown fault and the alpha.27 → 2.0.1 upgrade), packaged-plugin and native configuration checks passed |
| 2026-10-14: the same test file against images built from `6cdf8ee` (pre-#54) | `cd-smoke-3d2dcaf0-ae9` | Failed only at `stale-lock` (`LockFileExistsError`: the host image predated #54); every earlier check passed |
| 2026-10-15: Clusterio 2.0.2 release at `b2368b0` (PR #56) — native 2.0.2 on both roles, six bundled plugins, previous host alpha.27.r7 | `cd-smoke-c87a6fc6-e08` | All ten startup scenarios, packaged-plugin and native configuration checks passed |
| 2026-10-28: Clusterio 2.0.3 release at `d2c0707` — native 2.0.3 on both roles, six bundled plugins, previous host alpha.27.r7 | `cd-smoke-ccf9692a-904` | All ten startup scenarios, packaged-plugin and native configuration checks passed |
| 2026-10-28: the same images, `--case upgrade` with previous host `2.0.2.r1` | `cd-smoke-ebdf3be2-d17` | Failed in the fixture step, before the candidate ran: the harness writes previous-image configuration with `config set` and no `config create`, which a 2.0 CLI rejects on a missing file |
| 2026-10-29: Clusterio 2.0.3 images at `b0c2cc1`, harness fixture runs `config create` first when the previous CLI supports it, `--case upgrade` with previous host alpha.27.r7 | `cd-smoke-f0d6b6e5-1d3` | Upgrade, packaged-plugin and native CLI checks passed; the fixture tolerates the pre-2.0 CLI's `Unknown argument: create` and lets `config set` create the file |
| 2026-10-29: the same images and harness, `--case upgrade` with previous host `2.0.2.r1` | `cd-smoke-b82e8ad6-6a4` | Upgrade, packaged-plugin and native CLI checks passed: 2.0.2-written configuration survives candidate startup |
| 2026-11-21: Clusterio 2.0.3 images built without cache from the working tree on `6e55181` (Node 24.22.3 base, `@clusterio/lib` pinned; every `@clusterio/*` package in both images read back as 2.0.3), six bundled plugins, previous host `2.0.3.r2` by digest | `cd-smoke-e1832200-78c` | All ten startup scenarios (incl. the `2.0.3.r2` → candidate upgrade case), native CLI plugin-selection and native configuration checks passed; run with `--skip-package`, as CI's publication acceptance is |
| 2026-11-22: Clusterio 2.1.1 images built without cache from `f042149` (every `@clusterio/*` package in both images read back as 2.1.1, Node 24.22.3), six bundled plugins, previous controller and host `2.0.3.r2` by digest | `cd-smoke-26feab40-744` | All fourteen cases (incl. `host-wipe`, `scale-out`, `controller-wipe`, and `cluster-upgrade` from volumes written by the `2.0.3.r2` images), packaged-plugin, native CLI plugin-selection and native configuration checks passed |
| 2026-11-22: the same commit built with `CLUSTERIO_PLUGINS=none` and with `global_chat`, no previous images, as CI's `consumer-smoke` job runs | `cd-smoke-7b21bd8e-641` (none), `cd-smoke-bcade6d7-c8c` (global_chat) | Both passed every case that needs no previous image; `upgrade` and `cluster-upgrade` recorded as unverified |
| 2026-11-25: Clusterio 2.1.2 images built from the working tree on `dbcb8b6` (`CLUSTERIO_NPM_PLUGINS`; exact versions and npm `overrides` in `/clusterio/package.json`; the controller container exits when its controller stops before answering HTTP), controller `070a12d8ef27`, host `0da64f77e5b9`, six bundled plugins, previous controller and host `2.1.1.r1` by digest (the workflow's pins), packaged-plugin check included | `cd-smoke-d2207232-8d9`; from the published `2.1.2.r1` images: `cd-smoke-5f9a94f0-13c`, `cd-smoke-80c963fe-033` | All fifteen cases passed. `npm-plugins`: `timeshade@0.1.1` installed from the registry at host start, listed, its instance entrypoint imported, every `@clusterio/*` package still at 2.1.2, a restart reused the install, and a path, a bundled plugin name and a package without the `clusterio-plugin` keyword each stopped the host with exit 1. `failures`: a controller whose config a hook had made unreadable logged `ERROR: the controller stopped before it answered HTTP` and its container exited non-zero. `upgrade` and `cluster-upgrade` passed again from the published `2.1.2.r1` images. The `npm-plugins` case was then cut to one refused value (the others are unit-tested) and passed again on a rebuild (`cd-smoke-ca50f008-2d0`, controller `c02011edfa79`, host `bd7b724c4b2d`). Outside the runner, once each on the same images: a controller with `CLUSTERIO_NPM_PLUGINS=timeshade@0.1.1` logged `Loaded plugin timeshade`, and after its network was removed a restart reused the install; a new container without a network, a package that does not exist, and a folder mounted inside `/clusterio/node_modules` each exited 1 with `ERROR: CLUSTERIO_NPM_PLUGINS`; under `--restart unless-stopped` without a network the container had restarted twice after 200 s; a controller started with `@hornwitser/server_select@2.0.1` (passes the installer, cannot load on Clusterio 2.x) exited 1; a derived image built from another working directory with two unquoted package arguments installed both into `/clusterio`, and a derived image built as in the README started without a network, with the variable set and unset, and logged `Loaded plugin timeshade`. Clusterio's update command (`npm update --save @clusterio/controller @clusterio/plugin-global_chat`): on the published `2.1.1.r1` controller it moved both and lib to 2.1.2; on this tree built at 2.1.1 it exited 0 and changed nothing, and a pinned `npm install --save @clusterio/plugin-global_chat@2.1.2` failed with `EOVERRIDE`. This tree built at 2.0.3 refused `clusterio-discord@0.3.6` (`was built for @clusterio/lib ~2.1.0; this image is Clusterio 2.0.3`) and exited 1. Simulated: the `custom`-target refusal, by editing `BUILD_INFO` in a release image. Not covered: a real `custom`-target image, the reduced-plugin builds, and the workflow's `test` job |

Every listed run cleaned up its disposable resources. Assertions read native effective
configuration independently of startup messages. The two final runs include configuration
written by the r7 release on a fresh volume. Reports retain image IDs and actual native
CLI versions: custom BUILD_INFO's declared version alone is not evidence of the source
package version. The release selections in CI also exercise packaged plugin installation.

Local review caught an empty-environment compatibility regression. Its failing regression
now passes, and the final rotation scenarios confirm empty optional overrides fall back
correctly. The first fresh-volume upgrade fixture needed normal runtime directory ownership
before invoking the previous CLI; that harness setup was corrected before the final runs.

The first native invalid-write fixture used malformed port text, but Clusterio accepts
that string at configuration-write time. That was a harness assumption, not proof of
rejection. The corrected fixture uses an invalid numeric host ID, which the pinned CLI
rejects while returning zero; readback detects the rejected write.

Earlier native startup evidence is retained in git history. The fixture has no web bundle
or host implementation, so its two native plugin warnings are expected.
