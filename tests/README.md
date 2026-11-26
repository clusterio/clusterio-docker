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
  --previous-host ghcr.io/clusterio/clusterio-docker-host:<previous-pin> \
  --previous-controller ghcr.io/clusterio/clusterio-docker-controller:<previous-pin>
```

`<previous-pin>` is a published pin of the previous Clusterio version. The previous images
must be available locally (pull them first when needed). CI pins their
digests (`PREVIOUS_HOST_IMAGE`, `PREVIOUS_CONTROLLER_IMAGE`).
Default expected plugins are `none`; pass `--plugins global_chat` for a selected image, or the
explicit comma-separated six names for a full image. Use `--skip-package` for custom
images: their pnpm workspace is not an npm installation target. The packaged-consumer case
runs on release selections separately. Ordinary CLI verification accepts an explicit
expected plugin array and checks shared package resolution; without an array it reports
discovery without claiming selection coverage.

Choose a single case with `--case NAME`. Omitting it runs every case.

Hosts the cases restart are stopped before they are replaced, and count as ready only when
they are healthy **and** their own log contains `Started host`: the controller keeps a killed
container's session as connected for a while, which would otherwise satisfy readiness.
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

## Recording a run

Record an acceptance run in the pull request it supports: the command, the image ids, and
each case as passed, failed or unverified. `result.json` in the run's report directory holds
all of these. `ci-artifacts/` is not tracked, so a report directory name alone identifies
nothing to another reader.

CI uploads the reports of its own runs as the `publication-candidate-acceptance` and
`consumer-smoke-<plugins>` artifacts.
