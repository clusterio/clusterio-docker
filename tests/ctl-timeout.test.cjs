// Every clusterioctl call the image's shell scripts (scripts/*.sh) make to a controller runs
// under `timeout`: clusterioctl has no client-side timeout and waits forever on a controller
// that accepts the connection but does not answer (docs/clusterio-engineering-notes.md,
// entry 4).
//
// This reads the scripts as text. It cannot see a call assembled from variables; the
// scripts have none, and the stub tests cover what a call that never answers does.
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scripts = path.join(__dirname, "../scripts");

// A call: clusterioctl run through npx (with or without npx options) or by its bin path.
const call = /(?:\bnpx\s+(?:-\S+\s+)*|\/\.bin\/)clusterioctl\b/g;
const bounded = /\btimeout -k \d+ (?:"\$\w+"|\d+) gosu clusterio (?:npx\s+(?:-\S+\s+)*|\S*\/\.bin\/)clusterioctl\b/g;
// `clusterioctl config set ctl.*` edits the ctl config file and contacts no controller.
const local = /clusterioctl --log-level error config set ctl\.\S+ /g;

// Commands of `source` that call clusterioctl without a time limit, as "N: text". A command
// continued with a trailing backslash is one command, numbered by its first line.
function unbounded(source) {
  const commands = [];
  let current = null;
  source.split("\n").forEach((line, index) => {
    if (current === null) {
      if (line.trim().startsWith("#")) return;
      current = {number: index + 1, text: ""};
    }
    const continued = line.endsWith("\\");
    current.text += (continued ? line.slice(0, -1) : line).trim() + " ";
    if (!continued) { commands.push(current); current = null; }
  });
  if (current !== null) commands.push(current);
  const count = (text, pattern) => (text.match(pattern) || []).length;
  return commands
    .filter(({text}) => count(text, call) > count(text, bounded) + count(text, local))
    .map(({number, text}) => number + ": " + text.trim().replace(/\s+/g, " "));
}

function calls(source) {
  return source.split("\n").filter(line => !line.trim().startsWith("#"))
    .reduce((total, line) => total + (line.match(call) || []).length, 0);
}

test("every clusterioctl call that contacts a controller runs under timeout", () => {
  let found = 0;
  for (const name of fs.readdirSync(scripts).filter(file => file.endsWith(".sh"))) {
    const source = fs.readFileSync(path.join(scripts, name), "utf8");
    found += calls(source);
    assert.deepEqual(unbounded(source), [], name + " calls clusterioctl without `timeout -k N LIMIT`");
  }
  assert.ok(found >= 10, "found only " + found + " clusterioctl calls: the pattern no longer matches the scripts");
});

test("the check reports unbounded calls and accepts bounded and local ones", () => {
  const accepted = [
    "# gosu clusterio npx clusterioctl in a comment",
    "timeout -k 5 \"$CTL_ACTION_TIMEOUT\" gosu clusterio npx clusterioctl --log-level error mod-pack edit 1",
    "timeout -k 5 25 gosu clusterio npx clusterioctl --log-level error instance list",
    "timeout -k 5 25 \\",
    "  gosu clusterio npx clusterioctl --log-level error instance list",
    "timeout -k 5 25 gosu clusterio /clusterio/node_modules/.bin/clusterioctl host list",
    "gosu clusterio npx clusterioctl --log-level error config set ctl.controller_url http://localhost:8080/ --config x",
  ];
  assert.deepEqual(unbounded(accepted.join("\n")), []);

  const rejected = [
    "gosu clusterio npx clusterioctl --log-level error host list",
    "x=$(timeout 25 gosu clusterio npx clusterioctl --log-level error host list)",
    "gosu clusterio npx \\",
    "  clusterioctl --log-level error host list",
    "gosu clusterio /clusterio/node_modules/.bin/clusterioctl host list",
    "gosu clusterio npx --no-install clusterioctl host list",
    "timeout -k 5 25 gosu clusterio npx clusterioctl a; gosu clusterio npx clusterioctl b",
    "gosu clusterio npx clusterioctl --log-level error config set ctl.controller_url u --config x; gosu clusterio npx clusterioctl host list",
  ];
  assert.deepEqual(unbounded(rejected.join("\n")).map(entry => Number(entry.split(":")[0])), [1, 2, 3, 5, 6, 7, 8]);
});
