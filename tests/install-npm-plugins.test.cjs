const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {parse, upToDate, problems, install, MARKER} = require("../scripts/install-npm-plugins.cjs");

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-npm-plugins-"));
  const put = (name, fields, dir = "node_modules") => {
    fs.mkdirSync(path.join(root, dir, name), {recursive: true});
    fs.writeFileSync(path.join(root, dir, name, "package.json"), JSON.stringify({name, ...fields}));
  };
  try {
    put("@clusterio/lib", {version: "2.1.2"});
    put("@clusterio/host", {version: "2.1.2"});
    return run(root, put);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}
const plugin = version => ({version, keywords: ["clusterio", "clusterio-plugin"]});
// Stands in for semver in the fixtures: a range is the list of versions it accepts.
const satisfies = (version, range) => range.split(" || ").includes(version);

test("specs are names with an optional version, separated by commas or whitespace", () => {
  assert.deepEqual(parse(" clusterio-discord@0.3.6,@expcluster/server-ups@^7.0.5\n timeshade ").map(s => s.spec),
    ["clusterio-discord@0.3.6", "@expcluster/server-ups@^7.0.5", "timeshade"]);
  assert.deepEqual(parse("@scope/a_b.c@1.2.3-rc.1+build")[0],
    {name: "@scope/a_b.c", version: "1.2.3-rc.1+build", spec: "@scope/a_b.c@1.2.3-rc.1+build"});
  assert.equal(parse("x@latest")[0].version, "latest");
  for (const empty of [undefined, "", " , \n"]) assert.deepEqual(parse(empty), []);
});

test("anything npm would not read as a registry package is refused before npm runs", () => {
  for (const spec of ["--ignore-scripts", "-g", "../plugin", "./plugin", "/tmp/plugin", "file:plugin", "plugin.tgz@", "x@",
    "https://example.com/p.tgz", "github:user/repo", "user/repo", "git+ssh://host/repo", "alias@npm:other@1", "x@-1",
    "x@1 || 2", "x@>=1", "Plugin", "@scope", "@scope/", "x;id", "$(id)", "x@1;id"])
    assert.throws(() => parse(spec), /Invalid plugin|listed twice/, spec);
});

test("the image's own packages and repeated names are refused", () => {
  assert.throws(() => parse("@clusterio/plugin-global_chat"), /CLUSTERIO_PLUGINS build argument/);
  assert.throws(() => parse("@clusterio/lib@2.1.3"), /belongs to the image/);
  assert.throws(() => parse("timeshade timeshade@0.1.1"), /listed twice/);
});

test("a verified install is skipped only for the same list with every package still present", () => fixture((root, put) => {
  const specs = parse("b@2.0.0 a");
  assert.equal(upToDate(root, specs), false);
  put("a", plugin("1.0.0")); put("b", plugin("2.0.0"));
  assert.equal(upToDate(root, specs), false, "installed but never verified");
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify(["a", "b@2.0.0"]));
  assert.equal(upToDate(root, specs), true);
  assert.equal(upToDate(root, parse("a,b@2.0.0")), true, "order does not matter");
  assert.equal(upToDate(root, parse("a b@2.0.1")), false, "a changed version reinstalls");
  assert.equal(upToDate(root, parse("a")), false, "a shorter list reinstalls");
  fs.rmSync(path.join(root, "node_modules", "a"), {recursive: true});
  assert.equal(upToDate(root, specs), false, "a missing package reinstalls");
  fs.writeFileSync(path.join(root, MARKER), "{");
  assert.equal(upToDate(root, specs), false, "an unreadable marker reinstalls");
}));

test("a usable installation has no problems", () => fixture((root, put) => {
  put("clusterio-discord", plugin("0.3.6"));
  put("discord.js", {version: "14.14.1"});
  assert.deepEqual(problems(root, parse("clusterio-discord@0.3.6"), satisfies), []);
}));

test("missing packages and packages Clusterio would not load are reported", () => fixture((root, put) => {
  put("old-bridge", {version: "0.2.5", keywords: ["clusterio", "discord"]});
  put("no-keywords", {version: "1.0.0"});
  const found = problems(root, parse("old-bridge absent no-keywords"), satisfies);
  assert.equal(found.length, 3);
  assert.match(found[0], /^old-bridge@0\.2\.5 is not a Clusterio 2\.x plugin/);
  assert.equal(found[1], "absent is not installed");
  assert.match(found[2], /^no-keywords@1\.0\.0 is not a Clusterio 2\.x plugin/);
}));

test("core packages moved by a plugin's peer range are reported, nested copies included", () => fixture((root, put) => {
  put("for-next", plugin("3.0.0"));
  put("@clusterio/controller", {version: "2.2.0"});
  put("@clusterio/lib", {version: "2.2.0"}, "node_modules/@clusterio/controller/node_modules");
  const found = problems(root, parse("for-next"), satisfies);
  assert.equal(found.length, 2);
  for (const line of found) assert.match(line, /^Clusterio is no longer uniformly 2\.1\.2: @clusterio\/(controller|lib)@2\.2\.0 /);
}));

test("the image's recorded version is the reference when lib itself moved", () => fixture((root, put) => {
  put("for-next", plugin("3.0.0"));
  fs.writeFileSync(path.join(root, "BUILD_INFO"), JSON.stringify({clusterioVersion: "2.1.2", clusterioTarget: "release"}));
  put("@clusterio/lib", {version: "2.2.0"});
  assert.deepEqual(problems(root, parse("for-next"), satisfies).map(line => line.split(" (")[0]),
    ["Clusterio is no longer uniformly 2.1.2: @clusterio/lib@2.2.0"]);
}));

test("a plugin built for another Clusterio version is reported, named or pulled in as a dependency", () => fixture((root, put) => {
  fs.writeFileSync(path.join(root, "BUILD_INFO"), JSON.stringify({clusterioVersion: "2.1.2"}));
  put("fits", {...plugin("1.0.0"), peerDependencies: {"@clusterio/lib": "2.1.1 || 2.1.2", "other": "9"}});
  put("@scope/too-new", {...plugin("3.0.0"), peerDependencies: {"@clusterio/lib": "2.2.0", "@clusterio/host": "2.2.0"}});
  put("too-old-dependency", {...plugin("0.9.0"), peerDependencies: {"@clusterio/controller": "2.0.3"}});
  put("not-a-plugin", {version: "1.0.0", peerDependencies: {"@clusterio/lib": "1.0.0"}});
  assert.deepEqual(problems(root, parse("fits @scope/too-new"), satisfies).sort(), [
    "@scope/too-new@3.0.0 was built for @clusterio/host 2.2.0; this image is Clusterio 2.1.2",
    "@scope/too-new@3.0.0 was built for @clusterio/lib 2.2.0; this image is Clusterio 2.1.2",
    "too-old-dependency@0.9.0 was built for @clusterio/controller 2.0.3; this image is Clusterio 2.1.2",
  ]);
  assert.match(problems(root, parse("fits"), undefined).join("\n"), /cannot check which Clusterio version/);
}));

test("install does nothing for an empty list and refuses a custom build", () => fixture(root => {
  install(root, "");
  install(root, undefined);
  assert.equal(fs.existsSync(path.join(root, MARKER)), false);
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  fs.writeFileSync(path.join(root, "BUILD_INFO"), JSON.stringify({clusterioTarget: "custom"}));
  assert.throws(() => install(root, "timeshade"), /not supported on custom/);
  assert.throws(() => install(root, "--global"), /Invalid plugin/);
}));

test("install skips npm when the list is already installed and verified", () => fixture((root, put) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  put("timeshade", plugin("0.1.1"));
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify(["timeshade@0.1.1"]));
  // No npm project here: reaching npm would throw.
  install(root, "timeshade@0.1.1");
}));
