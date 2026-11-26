// What the images know about Clusterio's own npm packages: their names, how they are held at
// one version, and how a plugin's peer ranges on them are read. One copy, used by the release
// install (build time), the npm plugin installer and the plugin resolution check (run time).
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const roles = ["controller", "host"];
const bundled = ["global_chat", "player_sync", "player_auth", "research_sync", "statistics_exporter", "subspace_storage"];
// Every @clusterio/* package an image can hold, whether this image installs it or not.
const core = [...roles, "ctl", "lib", "web_ui", ...bundled.map(n => "plugin-" + n)].map(n => "@clusterio/" + n);

// npm `overrides` holding every core package at the image's version wherever it appears in
// the tree, including ones this image does not install. Exact versions alone do not cover
// those: a plugin with a required peer on @clusterio/host, installed into a controller image,
// made npm fetch the newest host from the registry and the lib it depends on with it.
const overrides = version => Object.fromEntries(core.map(name => [name, version]));

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

// semver's `satisfies` as the installation at `root` resolves it (the copy @clusterio/controller
// and @clusterio/host depend on), prereleases included. Undefined when semver is not installed.
function satisfier(root) {
  try {
    const semver = createRequire(path.join(root, "package.json"))("semver");
    return (version, range) => semver.satisfies(version, range, { includePrerelease: true });
  } catch { return undefined; }
}

// True when a plugin's peer range on a core package rules out `version`. A `workspace:` range
// is unpublished source and says nothing about versions, so it rules nothing out.
const peerExcludes = (range, version, satisfies) => !String(range).startsWith("workspace:") && !satisfies(version, String(range));

module.exports = { roles, bundled, core, overrides, mismatches, satisfier, peerExcludes };
