// Every clusterioctl call a shell script makes to a controller runs under `timeout`:
// clusterioctl has no client-side timeout and waits forever on a controller that accepts
// the connection but does not answer (docs/clusterio-engineering-notes.md, entry 4).
const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const scripts = path.join(__dirname, "../scripts");

// `clusterioctl config set ctl.*` edits the ctl config file and contacts no controller.
const local = /\bnpx clusterioctl --log-level error config set ctl\./;
const call = /\bnpx clusterioctl\b/;
const bounded = /\btimeout -k \d+ (?:"\$\w+"|\d+) gosu clusterio npx clusterioctl\b/;

// Lines of `source` that call clusterioctl without a time limit, as "N: text".
function unbounded(source) {
  return source.split("\n")
    .map((line, index) => ({line, number: index + 1}))
    .filter(({line}) => !line.trim().startsWith("#") && call.test(line))
    .filter(({line}) => !local.test(line) && !bounded.test(line))
    .map(({line, number}) => number + ": " + line.trim());
}

test("every clusterioctl call that contacts a controller runs under timeout", () => {
  let calls = 0;
  for (const name of fs.readdirSync(scripts).filter(file => file.endsWith(".sh"))) {
    const source = fs.readFileSync(path.join(scripts, name), "utf8");
    calls += source.split("\n").filter(line => !line.trim().startsWith("#") && call.test(line)).length;
    assert.deepEqual(unbounded(source), [], name + " calls clusterioctl without `timeout -k N LIMIT`");
  }
  assert.ok(calls >= 10, "found only " + calls + " clusterioctl calls: the pattern no longer matches the scripts");
});

test("the check reports an unbounded call and accepts bounded and local ones", () => {
  const sample = [
    "# gosu clusterio npx clusterioctl in a comment",
    "gosu clusterio npx clusterioctl --log-level error host list",
    "x=$(timeout 25 gosu clusterio npx clusterioctl --log-level error host list)",
    "timeout -k 5 \"$CTL_ACTION_TIMEOUT\" gosu clusterio npx clusterioctl --log-level error mod-pack edit 1",
    "timeout -k 5 25 gosu clusterio npx clusterioctl --log-level error instance list",
    "gosu clusterio npx clusterioctl --log-level error config set ctl.controller_url http://localhost:8080/",
  ].join("\n");
  assert.deepEqual(unbounded(sample), [
    "2: gosu clusterio npx clusterioctl --log-level error host list",
    "3: x=$(timeout 25 gosu clusterio npx clusterioctl --log-level error host list)",
  ]);
});
