# Plugin Development against these containers

How to develop a Clusterio plugin (Node + optional save-patched Lua module) using the prebuilt
images — without rebuilding images and without the classic traps. For *running* third-party
plugins, the README's [External Plugins](../README.md#external-plugins) section is enough (a
plugin published on npm is one `CLUSTERIO_NPM_PLUGINS` entry, with no mount); this
guide is for writing one.

## Setup

1. Put your plugin in a directory with a `package.json`, and mount the parent into **both** the
   controller and every host (uncomment the volumes in `docker-compose.yml`):
   ```yaml
   volumes:
     - ./plugins:/clusterio/external_plugins
   ```
   The mount must be writable — the entrypoint npm-installs inside each plugin dir.
2. On container start, `install-plugins.sh` installs each plugin's production deps (its full
   contract — non-fatal stderr WARNINGs, the `@clusterio` strip — is documented in the README).
   **Registration is separate and automatic**: Clusterio's startup scan (`loadPluginList`)
   walks `external_plugins/` and registers any directory whose `package.json` has
   **`"clusterio-plugin"` in `keywords`**. That keyword is load-bearing — without it the
   plugin npm-installs cleanly and then **silently never loads**. CI pins this whole
   lifecycle with the `seed-data/external_plugins/ci_fixture` plugin.
3. **Target Clusterio 2.1's plugin API** (the 2.0 module rules below still apply). Plugins are ES modules (`"type": "module"`), the
   entrypoint paths in the plugin declaration carry the `.js` extension
   (`controllerEntrypoint: "controller.js"`), and each entrypoint exports a default async
   function that attaches hooks. Class exports still load but log a deprecation warning, and
   a CommonJS plugin only registers if its `plugin` export is detectable from the source
   (`module.exports = { plugin }`). Upstream's
   [2.0 migration guide](https://github.com/clusterio/clusterio/blob/v2.0.1/docs/devs/plugin-migration-to-2.0.md)
   covers the conversion; `ci_fixture` is a minimal worked example.
4. **Clusterio 2.0.3 changes for plugins.** `@clusterio/lib` uses `@sinclair/typebox` 0.34;
   upstream asks plugins that use typebox to depend on `^0.34`. A plugin can declare the
   `LuaUdp` feature (alongside `SavePatching` and `ScriptCommands`) to use `sendUdp` and
   in-game `clusterio_api.send_udp`; Clusterio then rejects enabling its `<name>.load_plugin`
   on an instance without `factorio.enable_lua_udp` (see
   [seed-data.md](seed-data.md#instance-configuration)).
5. **Clusterio 2.1 changes for plugins** (upstream's `docs/devs/plugin-migration-to-2.1.md`
   has the details):
   - **Web modules are built with Vite**: a `vite.config.js` using `clusterioPlugin` from
     `@clusterio/web_ui/vite.mjs`, and `vite build` in place of webpack. A plugin built with
     webpack still loads its controller, host and instance code, but its web UI is rejected
     ("Incompatible dist/web/manifest.json, the plugin must be rebuilt with Vite").
   - **Mount a web module prebuilt.** `install-plugins.sh` runs `npm install --omit=dev`, and
     the release images do not contain `vite`, so `dist/web` must already be in the plugin directory.
   - `RequestError` is replaced by error classes following HTTP status codes (`ValidationError`,
     `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnavailableError`, `TimeoutError`);
     `lib.safeOutputFile` is `lib.atomicOverwriteFile`; host token APIs moved to
     `controller.hosts.*` (`signHostToken`, `verifyHostToken`, `createHost`), and the hosts
     datastore to `controller.hosts.records` (`set`, `delete`, `size`, the `update` event;
     upstream's "Host manager" section).
   - A plugin can declare `requiredMods`; an instance whose mod pack lacks them refuses to
     start (the bundled `subspace_storage` requires the `subspace_storage` mod).
6. **Clusterio 2.1.2 changes for plugins** (the 2.1.2 section of upstream's `CHANGELOG.md`):
   - **Plugins load concurrently**, no longer one at a time in plugin list order. A plugin
     that depends on another being loaded first must wait for it with `plugins.waitFor` from
     its load context (`plugins.checkInstalled` and `plugins.checkEnabled` are there too).
   - `lib.ZipArchive.zipfile` is private; read entries with `ZipArchive.openStream` /
     `openRawStream`. `ModInfo.fromModFile` is `ModStore.readModInfo`.
   - `@clusterio/lib` no longer brings in `@types/node`, `@types/yauzl` or `@types/yazl`. A
     TypeScript plugin that relied on them lists them in its own `devDependencies`.

## The two rules that cost the most when unknown

1. **`@clusterio/*` must be peerDependencies, never dependencies.** Clusterio fatally rejects a
   duplicate `@clusterio/lib` — one vendored copy crashes every `clusterioctl` invocation
   cluster-wide. The entrypoint strips stray copies **on every boot** as a backstop (look for
   "Removing local @clusterio packages" in logs), but npm 7+ auto-installs peer deps on a
   workstation `npm install`, so also ship a plugin-level `.npmrc` with
   `legacy-peer-deps=true` and keep your host-side dev types in a directory *above* the plugin
   (they resolve via Node's upward walk). Two proven workstation patterns from production
   consumers: **repo-root devDeps** (the `@clusterio` types live in a parent `package.json`
   that is never mounted into containers), or **isolated-container builds** (a build script
   that compiles in a throwaway node container, with a named volume shadowing `node_modules`
   so the mounted plugin dir never receives an install). Never run a bare install inside the
   mounted plugin dir.
2. **Node plugin code is cached by the long-lived host process.** An `instance stop/start`
   re-patches the save-embedded **Lua** module but does **not** reload plugin **Node** code —
   the require cache keeps serving the old build (and it will even log "plugin initialized").
   After changing Node code: restart the **host container**, then follow the boot-race protocol
   below. (Same class: the controller caches its plugin code too — restart the controller
   container for controller-side changes.)

## The dev loop

```text
edit → build (tsc → dist/) → docker restart <host container>
     → wait healthy → clusterioctl instance stop/start   (boot-race protocol)
     → verify a NEW-code-only behavior (new log line / new column / new command)
```

- **Boot race**: an instance that auto-starts before its host finishes the controller handshake
  silently skips instance plugins — no error, IPC just goes nowhere. Always stop/start the
  instance after the container is healthy, then **prove the plugin loaded** by observing
  behavior only the new build has. "It responds" is not "it's your build" — consider stamping a
  build id into your plugin's status output.
- **Lua module changes** (save-patched): an instance stop/start alone is sufficient — the save
  is re-patched on start.

## Where the output goes

| What | Where |
|---|---|
| Instance-plugin log lines | controller: `/clusterio/logs/cluster/cluster-*.log` (NOT `docker logs`) |
| Host-side log lines | host: `/clusterio/logs/host/host-*.log` |
| Engine + module Lua output | the instance's `factorio-current.log` |
| clusterioctl access | `docker exec clusterio-controller npx clusterioctl --config /clusterio/tokens/config-control.json …` |

**Windows note**: run RCON / clusterioctl commands with leading-slash arguments (e.g. `/command`)
from PowerShell, not git-bash/MSYS — MSYS rewrites leading-slash args into filesystem paths,
silently corrupting the command.

## Publishing to npm

A plugin published on npm is installed by naming it in `CLUSTERIO_NPM_PLUGINS` on the controller
and every host — no mount (README, [Plugins from npm](../README.md#plugins-from-npm)). For the
installer to accept your package, and for Clusterio to load it:

| In `package.json` | Why |
|---|---|
| `"clusterio-plugin"` in `keywords` | Clusterio only loads npm packages that carry it. Without it the container exits with `… is not a Clusterio 2.x plugin`. |
| `@clusterio/*` under `peerDependencies`, with ranges that include the image's Clusterio version | The ranges are how the installer tells which Clusterio the plugin was built for (optional peers are read too). A range that excludes the image's version stops the container with `… was built for @clusterio/lib <range>; this image is Clusterio <version>`. Clusterio minor versions can break plugins, so `~2.1.0` says more than `^2.0.0`. |
| Everything needed at run time under `dependencies` | `devDependencies` are not installed. |
| The built output in the published files (`dist/`, and `dist/web` for a web module) | Nothing is built in the container: an install from the registry does not run your `prepare` script, and the images contain no `vite` or `tsc`. Check with `npm pack --dry-run` before publishing. |

- The installer does not check that the plugin loads. Entrypoints without the `.js` extension
  pass every check above and then stop the controller at startup, and its container with it
  (Setup, step 3).
- Install scripts (`install`, `postinstall`) of your package and of its dependencies do run,
  as the `clusterio` user.
- To try a build before publishing, mount it as a folder (Setup). To try a published one, pin
  the version, prerelease versions included: `CLUSTERIO_NPM_PLUGINS=<your-plugin>@1.3.0-rc.1`.
- Confirm it: the container logs `Installed <your-plugin>@<version>`, and
  `clusterioctl plugin list` (access in the table above) names the package.

## Worked example

[`solarcloud7/clustorio-atlas`](https://github.com/solarcloud7/clustorio-atlas) is a full
production plugin developed against these images — TypeScript instance plugin + save-patched Lua
module + ctl commands — including a deterministic deploy script (`tools/deploy-plugin.ps1`)
that encodes the loop above, and an `AGENTS.md` capturing the operational rules.
