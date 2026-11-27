# Container acceptance

Fast regressions:

```sh
bash tests/seed-instances-order.test.sh
bash tests/seed-mod-versions.test.sh
bash tests/regenerate-export-guard.test.sh
bash tests/pin-main-images.test.sh
node --test tests/*.test.cjs
```

None of these needs Docker or a network. CI runs them in the `gates` job.

| Test | Script under test | What it covers |
|---|---|---|
| `seed-instances-order.test.sh` | `scripts/seed-instances.sh` | No instance config is pushed after `instance assign`; each seed folder's host is addressed by the id its token names; calls that never answer |
| `seed-mod-versions.test.sh` | `scripts/seed-mods.sh` | The mod pack gets the numerically highest version of each seed mod |
| `regenerate-export-guard.test.sh` | `scripts/regenerate-export-data.sh` | A headless host is refused unless `--allow-headless` is given; a failed lookup is refused too |
| `pin-main-images.test.sh` | `.github/scripts/pin-main-images.sh` | Which images a revision pin tags, and that nothing is tagged when one is refused |
| `ctl-json.test.cjs` | `scripts/ctl-json.cjs` | Reading `clusterioctl --output json` answers |
| `ctl-timeout.test.cjs` | `scripts/*.sh` | Every `clusterioctl` call to a controller runs under `timeout` |
| `host-config.test.cjs` | `scripts/configure-host.cjs` | Which token, id, name and paths a host is configured with |
| `host-token.test.cjs` | `scripts/host-token.cjs` | The host id a token names |
| `install-npm-plugins.test.cjs` | `scripts/install-npm-plugins.cjs` | Which `CLUSTERIO_NPM_PLUGINS` values are refused, and what makes an install unusable |
| `install-release.test.cjs` | `scripts/install-release.cjs` | The packages a `CLUSTERIO_PLUGINS` selection installs |
| `plugin-resolution.test.cjs` | `scripts/check-plugin-resolution.cjs` | A duplicate `@clusterio/lib` is reported |
| `provision-hosts.test.cjs` | `scripts/provision-hosts.cjs` | Which host tokens are kept, issued or left alone |
| `spritesheet-pixels.test.cjs` | `tests/spritesheet-pixels.cjs` | The icon counter CI's export check uses |

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

Options of `tests/consumer-smoke.mjs`, after the controller and host image:

| Option | Effect |
|---|---|
| `--plugins <names>` | The bundled plugins both images must report, comma separated, or `none` (the default). The run fails when an image reports another set |
| `--case <name>` | Run one case from the table below. Default: every case |
| `--skip-package` | Skip the check that packs `seed-data/external_plugins/ci_fixture`, installs it into an image derived from the controller image and starts the cluster on that image |
| `--previous-host <image>` | Run `upgrade`. Without it the case is recorded as unverified |
| `--previous-controller <image>` | With `--previous-host`, run `cluster-upgrade`. Without both it is recorded as unverified |
| `--require-complete` | Fail the run when any case is unverified. Not accepted together with `--case` |

Choose a single case with `--case NAME`. Omitting it runs every case. The `npm-plugins` case
runs on release-target images only and needs no network: it starts `tests/npm-registry.cjs`
in a container of the host image, which serves the two packages under `tests/npm-fixture/`
(a plugin with `@clusterio/*` peer ranges, and its dependency), and points the host at it
with `NPM_CONFIG_REGISTRY`. npm also asks a registry about the `@clusterio/*` packages the
plugin names as peers; the fixture registry answers from the image's own installation and
serves none of their tarballs. The case fails when npm requests anything the registry does
not hold; the requests are in the report as `npmRegistryRequests`.

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
`coverageComplete` in `result.json` is true when every case ran and passed. A case that did
not run has status `unverified` and does not change the verdict, unless the run was given
`--require-complete`: then it fails, naming the cases. CI passes that flag for the
release-target images it publishes.
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
The `build` job builds the actual release/custom target and runs acceptance on those
loaded full images, with `--require-complete` on the release target. The `publish` job
loads the same images from the run's artifact, checks their ids and pushes them without
rebuilding; on a pull request it pushes nothing. Existing seeded
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
`consumer-smoke-<plugins>` artifacts. `publication-candidate-images` is the image archive
`build` hands to `publish`, kept for one day. "Re-run failed jobs" does not run `build` again
when it passed, so after a day `publish` finds no archive: re-run all jobs.
