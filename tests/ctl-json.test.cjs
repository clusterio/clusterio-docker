const {test} = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {answer} = require("../scripts/ctl-json.cjs");
const script = path.join(__dirname, "../scripts/ctl-json.cjs");
// clusterioctl 2.1.1 `--output json` shapes.
const hosts = [
  {version:"2.1.1", name:"clusterio-host-1", id:933475968, connected:true, tokenValidAfter:0, isDeleted:false},
  {version:"2.1.1", name:"clusterio-host-2", id:2, connected:false, tokenValidAfter:0, isDeleted:false},
  {version:"2.1.1", name:"twin", id:41, connected:true, tokenValidAfter:0, isDeleted:false},
  {version:"2.1.1", name:"twin", id:42, connected:true, tokenValidAfter:0, isDeleted:false},
];
const instances = [
  {name:"TestInstance", id:254111007, assignedHost:933475968, gamePort:34100, status:"running",
    factorioVersion:"latest", startedAtMs:1000, updatedAtMs:2000, excludeFromStartAll:false, isTemplate:false},
  {name:"Unassigned", id:5, status:"stopped", factorioVersion:"latest", startedAtMs:0, updatedAtMs:1,
    excludeFromStartAll:false, isTemplate:false},
  {name:"Late", id:6, assignedHost:933475968, status:"starting", startedAtMs:3000},
  {name:"Elsewhere", id:7, assignedHost:2, status:"running", startedAtMs:500},
];
function cli(args, input) {
  const result = spawnSync(process.execPath, [script, ...args], {input, encoding:"utf8"});
  return {status:result.status, stdout:result.stdout, stderr:result.stderr};
}
test("connected-hosts and host-connected", () => {
  assert.equal(answer("connected-hosts", hosts, []), 3);
  assert.equal(answer("connected-hosts", [], []), 0);
  assert.equal(answer("host-connected", hosts, ["933475968"]), "");
  assert.equal(answer("host-connected", hosts, ["2"]), undefined);
  assert.equal(answer("host-connected", hosts, ["99"]), undefined);
});
test("resolve-host prefers the token's id, then a unique name, then id N", () => {
  assert.equal(answer("resolve-host", hosts, ["clusterio-host-1", "933475968", "1"]), "933475968");
  // A token id that is not registered does not win.
  assert.equal(answer("resolve-host", hosts, ["clusterio-host-1", "77", "1"]), 933475968);
  assert.equal(answer("resolve-host", hosts, ["twin", "", "41"]), "41");
  assert.equal(answer("resolve-host", hosts, ["twin", "42", "41"]), "42");
  assert.equal(answer("resolve-host", hosts, ["twin", "", "3"]), undefined);
  assert.equal(answer("resolve-host", hosts, ["clusterio-host-3", "", "2"]), "2");
  assert.equal(answer("resolve-host", hosts, ["clusterio-host-3", "", "3"]), undefined);
  assert.equal(answer("resolve-host", hosts, ["clusterio-host-3"]), undefined);
});
test("instance fields, empty when unset", () => {
  assert.equal(answer("instance", instances, ["TestInstance", "assignedHost"]), 933475968);
  assert.equal(answer("instance", instances, ["TestInstance", "status"]), "running");
  assert.equal(answer("instance", instances, ["Unassigned", "assignedHost"]), "");
  assert.equal(answer("instance", instances, ["Unassigned", "id"]), 5);
  assert.equal(answer("instance", instances, ["NoSuch", "id"]), undefined);
});
test("instances-before lists running or starting instances of a host started before a time", () => {
  assert.equal(answer("instances-before", instances, ["933475968", "4000"]), "TestInstance\nLate");
  assert.equal(answer("instances-before", instances, ["933475968", "2000"]), "TestInstance");
  assert.equal(answer("instances-before", instances, ["933475968", "1000"]), "");
});
test("mod-pack-id matches the exact name", () => {
  const packs = [{name:"Base Game 2.1", id:11}, {name:"Space Age 2.1", id:12}];
  assert.equal(answer("mod-pack-id", packs, ["Space Age 2.1"]), 12);
  assert.equal(answer("mod-pack-id", packs, ["space age 2.1"]), undefined);
});
test("field reads one key of an object and refuses arrays", () => {
  const config = {"host.name":"clusterio-host-1", "host.id":933475968, "host.factorio_directory":"/opt/factorio"};
  assert.equal(answer("field", config, ["host.factorio_directory"]), "/opt/factorio");
  assert.equal(answer("field", config, ["host.id"]), 933475968);
  assert.equal(answer("field", config, ["host.missing"]), undefined);
  assert.equal(answer("field", {"key":null}, ["key"]), undefined);
  assert.equal(answer("field", [config], ["host.id"]), undefined);
});
test("the wrong kind of input is an error, not an answer", () => {
  assert.throws(() => answer("connected-hosts", {"host.id":1}, []), /JSON array/);
  assert.throws(() => answer("field", "text", ["x"]), /JSON object or array/);
  assert.throws(() => answer("field", null, ["x"]), /JSON object or array/);
  assert.throws(() => answer("nope", [], []), /Unknown query/);
  assert.throws(() => answer("constructor", [], []), /Unknown query/);
});
test("CLI: exit 0 with the answer, 1 for no, 2 for input that is not the expected JSON", () => {
  assert.deepEqual(cli(["connected-hosts"], JSON.stringify(hosts)), {status:0, stdout:"3\n", stderr:""});
  assert.deepEqual(cli(["instance", "TestInstance", "status"], JSON.stringify(instances)),
    {status:0, stdout:"running\n", stderr:""});
  // An empty answer prints nothing but is still a yes.
  assert.deepEqual(cli(["host-connected", "933475968"], JSON.stringify(hosts)), {status:0, stdout:"", stderr:""});
  assert.deepEqual(cli(["instance", "Unassigned", "assignedHost"], JSON.stringify(instances)),
    {status:0, stdout:"", stderr:""});
  assert.equal(cli(["instance", "NoSuch", "id"], JSON.stringify(instances)).status, 1);
  assert.equal(cli(["host-connected", "2"], JSON.stringify(hosts)).status, 1);
  // clusterioctl's table output, and no output at all, are not JSON.
  const table = cli(["connected-hosts"], "name | id | connected\nclusterio-host-1 | 1 | true\n");
  assert.equal(table.status, 2);
  assert.match(table.stderr, /^ctl-json: /);
  assert.equal(cli(["connected-hosts"], "").status, 2);
  assert.equal(cli(["connected-hosts"], '{"success":true}').status, 2);
  assert.equal(cli(["bogus"], "[]").status, 2);
});
test("export-asset reads a file name from a mod pack's export manifest", () => {
  const pack = {name: "Space Age 2.1", exportManifest: {assets: {spritesheet: "spritesheet.abc.png"}}};
  assert.equal(answer("export-asset", pack, ["spritesheet"]), "spritesheet.abc.png");
  assert.equal(answer("export-asset", pack, ["locale"]), undefined);
  assert.equal(answer("export-asset", {name: "never exported"}, ["spritesheet"]), undefined);
  assert.throws(() => answer("export-asset", [pack], ["spritesheet"]), /JSON object/);
});
