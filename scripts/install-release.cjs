const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const all = ["global_chat", "player_sync", "player_auth", "research_sync", "statistics_exporter", "subspace_storage"];
// `lib` is named explicitly although every package below depends on it: upstream declares that
// dependency as a caret range (`^2.0.3`), so left to npm it resolves to the newest 2.x on the
// registry — a 2.0.3 image built after 2.1.1 was published got lib 2.1.1. A top-level exact
// spec satisfies those ranges, so npm dedupes every dependant onto it.
// --save-exact carries the same pin into the image's package.json. With caret ranges there, any
// later `npm install <plugin>` in the image (CLUSTERIO_NPM_PLUGINS, Clusterio's own `plugin
// install`) may move the core packages to satisfy the plugin's peer range: installing a plugin
// built for 2.1 into a 2.0.3 image upgraded controller and lib and left the rest. With exact
// versions npm refuses (ERESOLVE) and changes nothing.
function packages(role, version, selection = "all") {
  if (!["host", "controller"].includes(role)) throw new Error("Invalid Clusterio role");
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error("Invalid Clusterio version");
  const names = selection === "all" ? all : selection === "none" ? [] : selection.split(",");
  if (names.includes("inventory_sync"))
    throw new Error("inventory_sync was renamed to player_sync in Clusterio 2.0.0 (@clusterio/plugin-player_sync); use player_sync in CLUSTERIO_PLUGINS");
  if (new Set(names).size !== names.length || names.some(n => !all.includes(n)))
    throw new Error("CLUSTERIO_PLUGINS must be all, none, or unique comma-separated bundled plugin names");
  return [role, "ctl", "lib", ...names.map(n => "plugin-" + n)].map(n => "@clusterio/" + n + "@" + version);
}
// npm `overrides` holding every @clusterio/* package at the image's version wherever it appears
// in the tree, including ones this image does not install. Exact versions alone do not cover
// those: a plugin with a required peer on @clusterio/host, installed into a controller image,
// made npm fetch the newest host from the registry and the lib it depends on with it.
function overrides(version) {
  return Object.fromEntries(["controller", "ctl", "host", "lib", "web_ui", ...all.map(n => "plugin-" + n)]
    .map(n => ["@clusterio/" + n, version]));
}
// Every installed @clusterio/* package, nested copies included, that is not exactly `version`.
// Returns "name@found (path)" strings; empty means the install is the release it claims to be.
function mismatches(nodeModules, version) {
  const found = [];
  const scan = dir => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const pkg of fs.readdirSync(full, { withFileTypes: true })) if (pkg.isDirectory()) visit(path.join(full, pkg.name));
      } else visit(full);
    }
  };
  const visit = pkgDir => {
    const manifest = path.join(pkgDir, "package.json");
    if (fs.existsSync(manifest)) {
      const { name, version: actual } = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (typeof name === "string" && name.startsWith("@clusterio/") && actual !== version)
        found.push(name + "@" + actual + " (" + pkgDir + ")");
    }
    scan(path.join(pkgDir, "node_modules"));
  };
  scan(nodeModules);
  return found;
}
module.exports = { packages, overrides, mismatches, all };
if (require.main === module) {
  const [, version] = process.argv.slice(2);
  const specs = packages(...process.argv.slice(2));
  // Written before the install so the lock file is resolved under the overrides from the start.
  const rootManifest = path.join(process.cwd(), "package.json");
  const root = fs.existsSync(rootManifest) ? JSON.parse(fs.readFileSync(rootManifest, "utf8")) : {};
  fs.writeFileSync(rootManifest, JSON.stringify({ ...root, overrides: { ...root.overrides, ...overrides(version) } }, null, 2) + "\n");
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", ...specs],
    { stdio: "inherit" });
  const wrong = mismatches(path.join(process.cwd(), "node_modules"), version);
  if (wrong.length) {
    console.error("Release install is not uniformly Clusterio " + version + ":\n  " + wrong.join("\n  "));
    process.exit(1);
  }
}
