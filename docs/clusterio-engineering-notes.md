# Clusterio engineering notes — upstream behaviors these images build around

Runtime behaviours of Clusterio that the images work around or document: what the images do
about each, and where a change upstream would remove the workaround.

Status legend: 🛡 = handled by these images · 📝 = documented protocol · ⬆ = upstream
contribution candidate.

## Process & lifecycle

### 1. Instance auto-start races the controller handshake (🛡 ⬆)
An instance that starts before its host completes the controller handshake **silently skips
instance plugins** — no error, IPC goes nowhere. Everything looks alive.
**Images**: the host entrypoint's *boot-race guard* restarts any instance whose `startedAtMs`
predates the handshake. **Upstream candidate**: fail loud (minimum) or gate auto-start on plugin
registry readiness.

### 2. Plugin Node code is cached for the host process's lifetime (📝 ⬆)
`instance stop/start` re-patches the save-embedded **Lua** module but never reloads plugin
**Node** code — the host process keeps serving the build it loaded.
**Images**: documented deploy protocol (restart the *host container*, then verify a
new-code-only behavior) in [plugin-development.md](plugin-development.md). **Upstream
candidate**: report loaded plugin version/build per host (would make deploy-freshness checks
generic instead of every plugin hand-rolling a build stamp).

### 3. Lua modules are save-patched (📝)
Module code lives inside the save file; it goes live only when Clusterio re-patches the save
(instance restart). A plain container restart can reuse the previously patched `script.dat`.
Not a bug — a design with non-obvious deploy consequences. Documented in the plugin guide.

## Tooling

### 4. `clusterioctl` has no client-side timeout (🛡)
Against an unreachable, or reachable-but-mid-boot, controller, `clusterioctl` **hangs
indefinitely** rather than failing. A frozen call in a poll loop never reaches the loop's own
deadline check.
**Images**: every `clusterioctl` call the image's shell scripts (`scripts/*.sh`) make to a
controller runs under `timeout`, with one of three limits: 25 s for queries, 60 s for
changes and for the two queries whose answer decides whether something is created, 300 s
for uploads and `export-data`. The limit ends the client; what the controller
or host was asked to do may still complete. **Rule for this repo**: no `clusterioctl` call to
a controller without a time limit in those scripts; `tests/ctl-timeout.test.cjs` fails on one.

### 5. `create-ctl-config` bakes a controller-local URL (🛡)
The shared `config-control.json` carries a loopback `ctl.controller_url`
(`http://localhost:<port>/`, set by the controller entrypoint in place of the URL
`create-ctl-config` writes) — correct inside the controller container, a **self-dial** from
any other container. Combined with #4, a host using the shared config hangs instead of erroring.
**Images**: the host's boot-race guard derives its own copy (`ctl-config.cjs derive`),
rewriting `controller_url` to the host's configured controller URL.

### 6. The controller serves non-hashed `/static` assets as `immutable, max-age=1y` (🛡 ⬆)
Fixed-name assets get pinned by returning browsers for a year. Since Clusterio 2.1 the web
bundles of core and of plugins built with Vite's `clusterioPlugin` are content-hashed, and so
are export assets; a plugin's other static files and
anything placed in `/clusterio/static` are still served under fixed names.
**Images**: the controller entrypoint patches `Controller.js` at start
(`scripts/patches/disable-immutable-cache.js`) unless `CONTROLLER_STATIC_CACHE_MODE=immutable`;
the patch logs and changes nothing when the upstream code no longer matches. **Upstream candidate**: serve non-hashed
assets with revalidation.

## Versioning & packaging

### 7. The npm release can lag the fork's Factorio-version support (🛡)
The npm `@clusterio/*` release can lack support for a Factorio version that a fork branch has.
**Images**: a push to any branch other than `main` (branch names without a `/`), and a PR
into a `factorio-*` branch, builds the `custom` target from the fork branch of the same name;
`main`, tags and PRs into `main` build `release`. Enabling the DLC mods of a "Space Age" pack
is non-fatal, with a WARNING, on a core that lacks one of the builtins. `BUILD_INFO`'s
`clusterioTarget` and `clusterioVersion` say which core an image runs.

### 8. Duplicate `@clusterio/lib` is fatal, and npm plants duplicates by default (🛡 📝)
Clusterio needs a single `@clusterio/lib` — but npm installs peerDependencies by default,
so a routine `npm install` inside a mounted plugin dir plants a second copy.
**Images**: the entrypoint strips stray `@clusterio/*` from each external plugin on **every
boot** (logged); the plugin guide documents `.npmrc legacy-peer-deps=true` plus two
workstation patterns (repo-root devDeps; isolated-container builds).

### 9. Custom builds track the fork branch tip (📝)
CI clones the fork branch at build time (`--depth 1`) — there is no
commit-level pin in this repo, so two `custom` builds of the same docker-repo commit can embed
different core code. `BUILD_INFO.gitSha` records the *docker repo* commit, not the fork's.

## Game/server semantics

### 10. Headless servers pause at 0 players, freezing plugin pipelines (📝)
`auto_pause` defaults true; a paused game stops `on_tick` — every tick-driven plugin queue
silently stalls **while RCON keeps answering**, so the cluster looks healthy.
**Images**: documented ([seed-data.md](seed-data.md), README troubleshooting); the seeder logs
an INFO when an instance is created without an explicit setting.

### 11. Plugin logger output goes to files, not container stdout (🛡)
`this.logger.*` lands in `/clusterio/logs/{cluster,host}/*.log`, not on the process's stdout.
**Images**: `stream-logs.sh` mirrors those files to container stdout, each line prefixed
`[cluster-log] `, unless `CLUSTERIO_LOG_TO_STDOUT=false`.

## Host pairing (Clusterio 2.1)

### 12. A host started with a rejected token waits for approval forever (🛡)
`clusteriohost run` with a token the controller rejects does not exit: it opens a join
request and waits for someone to approve it, and it never rereads its token file. A fresh,
valid token file on the shared volume is only picked up by a container restart.
**Images**: the host entrypoint asks `GET /api/host-pairing/check` before starting. A
rejected file token waits up to 300 s for the file to change and reconfigures; a rejected
`CLUSTERIO_HOST_TOKEN` exits 1.

### 13. Host names are not unique; the controller picks host ids (🛡)
Pairing the same name twice gives two host records with that name, and
`clusterioctl instance assign` given that name picks one of them. Ids come from the controller at random.
**Images**: the controller entrypoint never pairs a name that is already registered (it
warns instead), hosts take `host.id` from their token, and seeding resolves a seed folder to
the id its token file names before falling back to the name.

---

*When adding an entry: neutral description of the behavior, what the images do, upstream
status. Keep the entry numbers stable: scripts and the workflow cite them.*
