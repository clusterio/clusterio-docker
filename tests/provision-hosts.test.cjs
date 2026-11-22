const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {provision, tokenFiles} = require("../scripts/provision-hosts.cjs");
// A fake controller and tokens volume. `accepted` are tokens the controller still accepts,
// `hosts` the registered hosts, `failPair`/`throwCheck` make pairing/checking fail.
function cluster({tokens = {}, accepted = [], hosts = [], failPair = [], throwCheck = [], failWrite = [], failRevoke = false} = {}) {
  const state = {files: new Map(Object.entries(tokens)), writes: [], pairs: [], checks: [], revoked: [], lists: 0, logs: []};
  let nextId = 933475968;
  state.deps = {
    readToken: name => state.files.get(name),
    writeToken: (name, token) => {
      if (failWrite.includes(name)) throw new Error("cannot write " + name + ".token");
      state.writes.push(name); state.files.set(name, token);
    },
    revoke: async id => { if (failRevoke) throw new Error("revoke failed"); state.revoked.push(id); },
    check: async token => {
      state.checks.push(token);
      if (throwCheck.includes(token)) throw new Error("unexpected status 500 checking the saved token");
      return accepted.includes(token);
    },
    pair: async name => {
      state.pairs.push(name);
      if (failPair.includes(name)) throw new Error("the controller refused to create the host (status 403)");
      return {hostId: nextId++, token: "issued-" + name};
    },
    listHosts: async () => { state.lists++; return hosts.map(host => ({...host})); },
    log: line => state.logs.push(line),
  };
  return state;
}
test("tokens the controller accepts are kept, and the host list is not looked up", async () => {
  const c = cluster({tokens: {"clusterio-host-1": "a", "clusterio-host-2": "b"}, accepted: ["a", "b"]});
  const result = await provision({count: 2, ...c.deps});
  assert.deepEqual(result, {kept: ["clusterio-host-1", "clusterio-host-2"], issued: [], skipped: [], failed: []});
  assert.deepEqual(c.writes, []);
  assert.deepEqual(c.pairs, []);
  assert.equal(c.lists, 0);
  assert.ok(c.logs.some(line => line.includes("still valid: clusterio-host-1, clusterio-host-2")));
});
test("a missing token file is issued", async () => {
  const c = cluster();
  const result = await provision({count: 1, ...c.deps});
  assert.deepEqual(result.issued, ["clusterio-host-1"]);
  assert.equal(c.files.get("clusterio-host-1"), "issued-clusterio-host-1");
  assert.deepEqual(c.checks, []);
  assert.ok(c.logs.some(line => line.includes("clusterio-host-1.token (host id 933475968)")));
});
test("a rejected token is re-issued when no host has that name", async () => {
  const c = cluster({tokens: {"clusterio-host-1": "stale"}, hosts: [{name: "clusterio-host-2", id: 2}]});
  const result = await provision({count: 1, ...c.deps});
  assert.deepEqual(result.issued, ["clusterio-host-1"]);
  assert.equal(c.files.get("clusterio-host-1"), "issued-clusterio-host-1");
  assert.ok(c.logs.some(line => line.includes("replacing one the controller no longer accepts")));
});
test("a registered name is skipped with a WARNING, for a missing and for a rejected file", async () => {
  const hosts = [{name: "clusterio-host-1", id: 11}, {name: "clusterio-host-2", id: 12}];
  const c = cluster({tokens: {"clusterio-host-2": "stale"}, hosts});
  const result = await provision({count: 2, ...c.deps});
  assert.deepEqual(result, {kept: [], issued: [], skipped: ["clusterio-host-1", "clusterio-host-2"], failed: []});
  assert.deepEqual(c.writes, []);
  assert.deepEqual(c.pairs, []);
  assert.equal(c.files.get("clusterio-host-2"), "stale");
  const warnings = c.logs.filter(line => line.includes("WARNING"));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /clusterio-host-1 is registered \(host id 11\) but its token file is missing/);
  assert.match(warnings[1], /clusterio-host-2 is registered \(host id 12\) but the controller rejects its token file/);
  assert.match(warnings[1], /clusterioctl host revoke clusterio-host-2/);
});
test("a pair failure or a check that throws lands in failed; later hosts are still processed", async () => {
  const c = cluster({tokens: {"clusterio-host-2": "flaky"}, throwCheck: ["flaky"], failPair: ["clusterio-host-1"]});
  const result = await provision({count: 3, ...c.deps});
  assert.deepEqual(result, {kept: [], issued: ["clusterio-host-3"], skipped: [], failed: ["clusterio-host-1", "clusterio-host-2"]});
  assert.deepEqual(c.writes, ["clusterio-host-3"]);
  assert.equal(c.files.get("clusterio-host-2"), "flaky");
  assert.ok(c.logs.some(line => line.includes("ERROR: no token for clusterio-host-1: the controller refused")));
  assert.ok(c.logs.some(line => line.includes("ERROR: no token for clusterio-host-2: unexpected status 500")));
});
test("the host list is looked up at most once per run", async () => {
  const c = cluster({tokens: {"clusterio-host-2": "a", "clusterio-host-3": "stale"}, accepted: ["a"]});
  const result = await provision({count: 4, ...c.deps});
  assert.deepEqual(result.issued, ["clusterio-host-1", "clusterio-host-3", "clusterio-host-4"]);
  assert.deepEqual(result.kept, ["clusterio-host-2"]);
  assert.equal(c.lists, 1);
});
test("each host is issued once, and a second run keeps what the first issued", async () => {
  const c = cluster();
  await provision({count: 2, ...c.deps});
  assert.deepEqual(c.pairs, ["clusterio-host-1", "clusterio-host-2"]);
  assert.deepEqual(c.writes, ["clusterio-host-1", "clusterio-host-2"]);
  const again = cluster({tokens: Object.fromEntries(c.files), accepted: [...c.files.values()],
    hosts: [{name: "clusterio-host-1", id: 933475968}, {name: "clusterio-host-2", id: 933475969}]});
  const result = await provision({count: 2, ...again.deps});
  assert.deepEqual(result.kept, ["clusterio-host-1", "clusterio-host-2"]);
  assert.deepEqual(again.pairs, []);
  assert.equal(again.lists, 0);
});
test("a host whose token file cannot be written is taken back out, and the others still get theirs", async () => {
  const c = cluster({failWrite: ["clusterio-host-1"]});
  const result = await provision({count: 2, ...c.deps});
  assert.deepEqual(result.failed, ["clusterio-host-1"]);
  assert.deepEqual(result.issued, ["clusterio-host-2"]);
  assert.deepEqual(c.revoked, [933475968]);
  assert.equal(c.files.has("clusterio-host-1"), false);
  assert.ok(c.logs.some(line => line.includes("ERROR: no token for clusterio-host-1: cannot write")));
});
test("a host that could not be taken back out is named, so it can be revoked by hand", async () => {
  const c = cluster({failWrite: ["clusterio-host-1"], failRevoke: true});
  const result = await provision({count: 1, ...c.deps});
  assert.deepEqual(result.failed, ["clusterio-host-1"]);
  assert.ok(c.logs.some(line => line.includes("WARNING: could not remove host id 933475968")));
});
test("token files are read trimmed, written whole, and a missing one is undefined", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provision-tokens-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const files = tokenFiles(dir);
  assert.equal(files.readToken("clusterio-host-1"), undefined);
  files.writeToken("clusterio-host-1", "a.b.c");
  assert.equal(fs.readFileSync(path.join(dir, "clusterio-host-1.token"), "utf8"), "a.b.c\n");
  assert.deepEqual(fs.readdirSync(dir), ["clusterio-host-1.token"]);
  fs.writeFileSync(path.join(dir, "clusterio-host-2.token"), "  d.e.f \r\n");
  assert.equal(files.readToken("clusterio-host-2"), "d.e.f");
  fs.writeFileSync(path.join(dir, "clusterio-host-3.token"), "\n");
  assert.equal(files.readToken("clusterio-host-3"), undefined);
  assert.throws(() => tokenFiles(path.join(dir, "missing")).writeToken("clusterio-host-1", "a.b.c"), /cannot write/);
});
