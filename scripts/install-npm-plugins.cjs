// Installs Clusterio plugins published on npm into the image's Clusterio installation.
// Run by both entrypoints for CLUSTERIO_NPM_PLUGINS, and usable as a RUN line in a derived
// image: `RUN gosu clusterio node /scripts/install-npm-plugins.cjs name@version other@version`.
// Always installs into ROOT, whatever the working directory is.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { mismatches, satisfier, peerExcludes } = require("./clusterio-packages.cjs");

// Written after a verified install. It is what lets a restart skip npm (and the network): the
// install lives in the container's writable layer, so it is there after a restart and gone,
// marker included, after the container is recreated.
const MARKER = ".npm-plugins.json";
const ROOT = "/clusterio";

// `name` or `name@version`, comma or whitespace separated. Nothing npm would read as a flag,
// path, URL, git remote or alias: every spec is a registry package.
function parse(value) {
  const specs = [];
  for (const spec of String(value ?? "").split(/[\s,]+/).filter(Boolean)) {
    const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([\w.+~^][\w.+~^-]*))?$/.exec(spec);
    if (!match) throw new Error("Invalid plugin '" + spec + "': expected an npm package name, optionally with @version");
    const [, name, version] = match;
    if (name.startsWith("@clusterio/"))
      throw new Error(name + " belongs to the image: bundled plugins are chosen with the CLUSTERIO_PLUGINS build argument");
    if (specs.some(other => other.name === name)) throw new Error("Plugin " + name + " is listed twice");
    specs.push({ name, version, spec });
  }
  return specs;
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };
const manifest = (root, name) => readJson(path.join(root, "node_modules", name, "package.json"));
const wanted = specs => specs.map(s => s.spec).sort();

// True when this exact list was installed and verified in this container before.
function upToDate(root, specs) {
  const done = readJson(path.join(root, MARKER));
  return Array.isArray(done) && JSON.stringify(done) === JSON.stringify(wanted(specs))
    && specs.every(s => manifest(root, s.name));
}

const isPlugin = pkg => Array.isArray(pkg?.keywords) && pkg.keywords.includes("clusterio-plugin");

// Third-party plugin packages at the top of node_modules: the named ones and the plugins they depend on.
function installedPlugins(root) {
  const modules = path.join(root, "node_modules"), names = [];
  for (const entry of fs.existsSync(modules) ? fs.readdirSync(modules) : []) {
    if (entry === "@clusterio" || entry.startsWith(".")) continue;
    if (!entry.startsWith("@")) names.push(entry);
    else for (const scoped of fs.readdirSync(path.join(modules, entry))) names.push(entry + "/" + scoped);
  }
  return names.map(name => manifest(root, name)).filter(isPlugin);
}

// What is wrong with the installation after npm ran; empty when it is fit to start.
function problems(root, specs, satisfies = satisfier(root)) {
  const found = [];
  for (const { name } of specs) {
    const pkg = manifest(root, name);
    if (!pkg) found.push(name + " is not installed");
    // Clusterio only loads packages carrying this keyword; without it the plugin never appears.
    else if (!isPlugin(pkg))
      found.push(name + "@" + pkg.version + " is not a Clusterio 2.x plugin (no \"clusterio-plugin\" keyword), so Clusterio would not load it");
  }
  // The version the image was built as; lib's own version is the fallback, and can be the one that moved.
  const core = readJson(path.join(root, "BUILD_INFO"))?.clusterioVersion ?? manifest(root, "@clusterio/lib")?.version;
  // The image's npm overrides hold the core packages in place whatever a plugin asks for, so npm
  // no longer refuses a plugin built for another Clusterio release. Its peer ranges are read here.
  if (!satisfies) found.push("cannot check which Clusterio version the plugins were built for: semver is not installed");
  else if (core) for (const pkg of installedPlugins(root))
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {}))
      if (peer.startsWith("@clusterio/") && peerExcludes(range, core, satisfies))
        found.push(pkg.name + "@" + pkg.version + " was built for " + peer + " " + range + "; this image is Clusterio " + core);
  // Belt and braces: nothing the install did may have moved a core package.
  for (const wrong of core ? mismatches(path.join(root, "node_modules"), core) : ["@clusterio/lib is not installed"])
    found.push("Clusterio is no longer uniformly " + core + ": " + wrong);
  return found;
}

function install(root, value) {
  const specs = parse(value);
  if (!specs.length) return;
  if (typeof process.getuid === "function" && process.getuid() === 0)
    throw new Error("run as the clusterio user (gosu clusterio node " + __filename + " ...), not root");
  if (readJson(path.join(root, "BUILD_INFO"))?.clusterioTarget === "custom")
    throw new Error("npm plugins are not supported on custom (source) builds; mount the plugin's source at /clusterio/external_plugins instead");
  const list = specs.map(s => s.spec).join(" ");
  if (upToDate(root, specs)) return console.log("npm plugins already installed: " + list);
  console.log("Installing npm plugins: " + list);
  fs.rmSync(path.join(root, MARKER), { force: true });
  try {
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--save", ...specs.map(s => s.spec)],
      { cwd: root, stdio: "inherit" });
  } catch {
    throw new Error("npm could not install " + list + " (its output is above)");
  }
  const wrong = problems(root, specs);
  if (wrong.length) throw new Error("the installation is not usable:\n  " + wrong.join("\n  "));
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify(wanted(specs)));
  for (const { name } of specs) console.log("  Installed " + name + "@" + manifest(root, name).version);
}

module.exports = { parse, upToDate, problems, install, MARKER };
if (require.main === module) {
  // Every argument is part of the list, so a quoted list and one package per argument both work.
  try { install(ROOT, process.argv.slice(2).join(" ")); } catch (error) {
    // Fatal on purpose: a cluster that starts without a plugin it was told to run fails later
    // and less visibly (unsynchronised inventories, a silent bridge) than one that does not start.
    console.error("ERROR: CLUSTERIO_NPM_PLUGINS: " + error.message);
    process.exit(1);
  }
}
