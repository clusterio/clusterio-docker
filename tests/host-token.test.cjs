const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {tokenHostId} = require("../scripts/host-token.cjs");
const script = path.join(__dirname, "../scripts/host-token.cjs");
const encode = claims => Buffer.from(JSON.stringify(claims)).toString("base64url");
const jwt = claims => "x." + encode(claims) + ".y";
test("the host claim is the host id", () => {
  assert.equal(tokenHostId(jwt({aud:"host", host:933475968})), 933475968);
  assert.equal(tokenHostId(jwt({aud:"host", host:0})), 0);
  assert.equal(tokenHostId(jwt({aud:"host", host:2147483647})), 2147483647);
  assert.equal(tokenHostId("  " + jwt({aud:"host", host:3}) + "\n"), 3);
});
test("the slave claim of pre-alpha-14 tokens is accepted; host wins when both are present", () => {
  assert.equal(tokenHostId(jwt({aud:"slave", slave:5})), 5);
  assert.equal(tokenHostId(jwt({aud:"host", host:6, slave:5})), 6);
});
test("a token that does not name a valid host id throws", () => {
  for (const token of [
    "a.b.c", "", "x.y", "x." + encode({host:1}), "x." + encode({host:1}) + ".y.z",
    jwt({aud:"host"}), jwt({host:"1"}), jwt({host:1.5}), jwt({host:-1}), jwt({host:2147483648}),
    "x." + Buffer.from("not json").toString("base64url") + ".y", undefined, 7,
  ]) assert.throws(() => tokenHostId(token), /does not name a host id/, String(token));
});
test("CLI: id FILE prints the id; bad input exits 1", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-token-"));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, "clusterio-host-1.token");
  fs.writeFileSync(file, jwt({aud:"host", host:933475968}) + "\n");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {encoding:"utf8"});
  const ok = run("id", file);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "933475968\n");
  fs.writeFileSync(path.join(dir, "bad.token"), "a.b.c\n");
  assert.equal(run("id", path.join(dir, "bad.token")).status, 1);
  assert.equal(run("id", path.join(dir, "missing.token")).status, 1);
  const usage = run("id");
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage/);
  assert.equal(run("claims", file).status, 1);
});
