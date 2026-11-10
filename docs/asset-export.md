# Asset Export — the Factorio game client & `export-data`

Clusterio's web UI needs icon spritesheets, prototype data, and locale strings. Prototypes,
locale and settings export from any host, but the icons need the **full game client** — the
headless server ships no graphics, so an export from a headless host succeeds with a blank
spritesheet. This repo automates the whole flow: getting a client onto one host, and running
`export-data` against it.

**Licensing**: the client is downloaded with **your** factorio.com credentials and is never
redistributed. Never push an image with a baked-in client to a public registry.

## How the host picks its Factorio directory (resolution order)

On every start, `host-entrypoint.sh` resolves `factorio_directory` in this order:

1. **Volume-installed client** (`/opt/factorio-client`, the external `factorio-client` volume) —
   preferred; survives `docker compose down -v`.
2. **Image-baked client** (only if the image was built with `INSTALL_FACTORIO_CLIENT=true` —
   private images only).
3. **Headless multi-version directory** — Clusterio auto-downloads the mod-pack's target
   headless version at runtime (no credentials needed).

Setting `SKIP_CLIENT=true` on a host forces option 3 even when a client is present (the default
for `clusterio-host-2` in the example compose).

## Getting the client: runtime download (recommended)

Set both credentials in `.env` (find your token at factorio.com → profile):

```bash
FACTORIO_USERNAME=your_username
FACTORIO_TOKEN=your_token
```

On next start, any host **without** `SKIP_CLIENT=true` that has no client yet downloads it into
the `factorio-client` volume (one-time, ~450 MB). Details that matter:

- `FACTORIO_CLIENT_BUILD` — `expansion` (default, includes Space Age) or `alpha` (base game).
- `FACTORIO_CLIENT_TAG` — `stable` (default) or a specific version.
- The token is passed to curl via a **stdin config** (`-K -`), so it never appears in the
  process list.
- Create the volume once before first use: `docker volume create factorio-client`.

The build-time alternative (`INSTALL_FACTORIO_CLIENT=true` in the dev overlay / `Dockerfile.host`)
exists for offline/private images — prefer the runtime path. If you do bake, credentials are
**BuildKit secrets**, not build args: `--secret id=factorio_username,env=FACTORIO_USERNAME
--secret id=factorio_token,env=FACTORIO_TOKEN` (the old `FACTORIO_CLIENT_USERNAME` /
`FACTORIO_CLIENT_TOKEN` build args were removed — see CLAUDE.md pitfall #8).

## Running the export: `EXPORT_HOST`

Set in `.env` (controller env):

```bash
EXPORT_HOST=1        # host ID that has the game client; 0/empty = skip export
```

During first-run seeding, the controller runs `clusterioctl instance export-data` **once**,
against the first auto-start instance on that host, before starting it. Failure is a logged
WARNING, not fatal: the cluster still comes up, without export data.

**If that host has no game client the export still succeeds** — prototypes, locale and settings
are exported, and the spritesheet is blank, so every web-UI icon is blank. Seeding logs a NOTE
when this happens. Once the host has a client, regenerate (below).

**After any Factorio / client / mod-pack version change, regenerate** — the seed-time export
does not re-run, so a version bump otherwise ships stale prototypes and icons:

```bash
docker exec clusterio-controller /scripts/regenerate-export-data.sh <instance-name>
```

(The script stops the instance, retries `export-data` up to 6×, and restarts it.)

**An export replaces the mod pack's whole export manifest.** A headless export run after a
client export therefore swaps the good spritesheet for a blank one; the old file stays in
`/clusterio/static`, but nothing points at it any more. `regenerate-export-data.sh` guards
against this: it checks the instance's host first and **refuses (exit 3, nothing stopped or
changed) when that host is headless**. If it cannot tell — the instance is unassigned or its
host does not answer — it refuses with exit 4. Pass `--allow-headless` to export anyway — useful to
refresh prototypes, locale and settings on a cluster that has no client at all:

```bash
docker exec clusterio-controller /scripts/regenerate-export-data.sh <instance-name> --allow-headless
```

"Headless" is inferred from configuration, not from the host's files: the script treats a
host as headless when its `host.factorio_directory` is exactly `/opt/factorio`, the directory
these images use when no client is installed. A host **not** built from these images that has
the full game installed at that path is therefore refused too — pass `--allow-headless` for it.

The raw `clusterioctl instance export-data` command and the web UI's export action are
upstream Clusterio and have **no such guard** — on a headless host they overwrite silently.

Misconfiguration guard: when `EXPORT_HOST` (set in `.env`, so it reaches the host) designates a
host that resolves to the headless directory, the host logs a **WARNING at startup**.

## What export-data produces

The default mod pack's `ExportManifest` assets, served to the web UI:

- `settings` / `prototypes` — JSON dumps of mod settings and all game prototypes
- `locale` — flattened en locale strings
- `spritesheet` — a single PNG containing all icon categories
- `metadata` — sprite coordinates + category membership (item, recipe, signal, technology,
  planet, quality, entity, static)

The extended per-category sheets are mainlined since Clusterio **alpha.23** (clusterio#838);
the web-UI consumption API changed in **alpha.24** (clusterio#875 — `useExportPrototypeMetadata`,
`FactorioIcon`). See [consumer-integration.md](consumer-integration.md).

## Troubleshooting

- **"Unable to find Factorio version X"** in the *host* log (not the instance's
  factorio-current.log): the resolved Factorio directory doesn't contain the version an
  instance pins. The entrypoint logs which version(s) it found at startup — compare against
  `factorio.version` in the instance config. A client install is a *single* version; keep the
  client's `FACTORIO_CLIENT_TAG` aligned with your instances' target version.
- **All icons blank in the web UI, no errors anywhere**: the last export ran on a headless
  host (credentials missing, or `SKIP_CLIENT=true`). The host log shows
  `Running in headless mode` for the export. Get a client onto the export host, then
  regenerate.
- **`regenerate-export-data.sh` exits 3 or 4**: 3 means the instance's host is headless; 4
  means the instance is unassigned or its host could not be queried. Nothing was changed —
  see "An export replaces…" above.
- **Export WARNING during seeding**: the export itself failed (instance or host problem) —
  check the host log.
- **Icons missing/stale in the web UI** after changing mods: regenerate (see above) — seeding
  only runs the export on first boot.
