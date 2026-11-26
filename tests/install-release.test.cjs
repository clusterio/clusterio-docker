const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {packages, overrides, mismatches, all} = require("../scripts/install-release.cjs");
test("default selection preserves all six bundled plugins", () => {
  assert.equal(packages("host", "2.0.1").length, 9);
  for (const name of all) assert.ok(packages("controller", "2.0.1").includes("@clusterio/plugin-" + name + "@2.0.1"));
});
test("minimal and subset use pinned native packages", () => {
  assert.deepEqual(packages("host", "2.0.1", "none"), ["@clusterio/host@2.0.1","@clusterio/ctl@2.0.1","@clusterio/lib@2.0.1"]);
  assert.equal(packages("controller", "2.0.1", "global_chat,statistics_exporter").length, 5);
});
test("lib is pinned for every role and selection", () => {
  for (const role of ["host", "controller"]) for (const selection of ["all", "none", "player_sync"])
    assert.ok(packages(role, "2.0.3", selection).includes("@clusterio/lib@2.0.3"));
});
test("overrides hold every @clusterio package at the version, installed in this image or not", () => {
  const held = overrides("2.1.2");
  for (const name of ["controller", "ctl", "host", "lib", "web_ui", ...all.map(n => "plugin-" + n)])
    assert.equal(held["@clusterio/" + name], "2.1.2");
  assert.equal(Object.keys(held).length, 11);
  // npm rejects an override that differs from a direct dependency's spec: both must be the bare version.
  for (const spec of packages("controller", "2.1.2")) assert.equal(held[spec.slice(0, spec.lastIndexOf("@"))], "2.1.2");
});
test("invalid selections and roles fail before npm runs", () => {
  for (const selection of ["", "all,none", "global_chat,global_chat", "../x", "--ignore-scripts"])
    assert.throws(() => packages("host", "2.0.1", selection));
  assert.throws(() => packages("bad", "2.0.1"));
  assert.throws(() => packages("host", "latest"));
  assert.throws(() => packages("host", "2.0.1", "inventory_sync"), /player_sync/);
});
test("mismatches reports every @clusterio package off the pinned version, nested included", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-release-"));
  const put = (dir, name, version) => {
    fs.mkdirSync(path.join(root, dir), {recursive: true});
    fs.writeFileSync(path.join(root, dir, "package.json"), JSON.stringify({name, version}));
  };
  try {
    put("node_modules/@clusterio/host", "@clusterio/host", "2.0.3");
    put("node_modules/@clusterio/lib", "@clusterio/lib", "2.0.3");
    put("node_modules/other", "other", "9.9.9");
    put("node_modules/@scope/other", "@scope/other", "9.9.9");
    assert.deepEqual(mismatches(path.join(root, "node_modules"), "2.0.3"), []);
    // The drift this guards against: a caret range resolving lib to a newer minor, hoisted or nested.
    put("node_modules/@clusterio/lib", "@clusterio/lib", "2.1.1");
    put("node_modules/@clusterio/host/node_modules/@clusterio/lib", "@clusterio/lib", "2.1.0");
    put("node_modules/other/node_modules/@clusterio/ctl", "@clusterio/ctl", "2.1.1");
    const wrong = mismatches(path.join(root, "node_modules"), "2.0.3").map(line => line.split(" ")[0]).sort();
    assert.deepEqual(wrong, ["@clusterio/ctl@2.1.1", "@clusterio/lib@2.1.0", "@clusterio/lib@2.1.1"]);
    assert.deepEqual(mismatches(path.join(root, "missing"), "2.0.3"), []);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
