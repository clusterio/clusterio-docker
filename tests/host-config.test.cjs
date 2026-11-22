const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {hostNumber, plan, checkToken} = require("../scripts/configure-host.cjs");
// A host token as the controller issues it; only the payload's claims matter here.
const jwt = (id, claim="host") => "x." + Buffer.from(JSON.stringify({aud:"host",[claim]:id})).toString("base64url") + ".y";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-contract-"));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return {fresh:false, hostName:"clusterio-host-2", factorioDirectory:"/opt/factorio",
    tokenFile:path.join(dir,"token"), configPath:"/data/host.json", env:{}};
}
const stored = {"host.id":7, "host.name":"operator", "host.controller_token":jwt(7),
  "host.controller_url":"http://saved:8080/", "host.factorio_port_range":"35100-35199",
  "host.factorio_directory":"/opt/factorio", "host.instances_directory":"/data/custom"};
test("unchanged restart preserves identity, custom directories, ports and endpoint", t => {
  assert.deepEqual([...plan(stored, fixture(t))], []);
});
test("the id follows a changed token from the environment or the file", t => {
  const options=fixture(t); fs.writeFileSync(options.tokenFile,jwt(9)+"\n");
  options.env.CLUSTERIO_HOST_TOKEN=jwt(933475968);
  assert.deepEqual([...plan(stored,options)], [["host.controller_token",jwt(933475968)],["host.id",933475968]]);
  delete options.env.CLUSTERIO_HOST_TOKEN;
  assert.deepEqual([...plan(stored,options)], [["host.controller_token",jwt(9)],["host.id",9]]);
});
test("a saved id that does not match the saved token is corrected", t => {
  assert.deepEqual([...plan({...stored,"host.id":2},fixture(t))], [["host.id",7]]);
});
test("explicit connection settings override saved values; absence preserves them", t => {
  const options=fixture(t); options.env.CONTROLLER_URL="http://other:8090/";
  options.env.FACTORIO_PORT_RANGE="36100-36199";
  assert.deepEqual([...plan(stored,options)], [
    ["host.controller_url","http://other:8090/"],["host.factorio_port_range","36100-36199"]]);
});
test("fresh config: id from the token, port range from the name's number including 08", t => {
  const options=fixture(t); options.fresh=true; options.hostName="clusterio-host-08";
  options.env.CLUSTERIO_HOST_TOKEN=jwt(933475968);
  const writes=plan(stored,options);
  assert.equal(writes.get("host.id"),933475968);
  assert.equal(writes.get("host.factorio_port_range"),"34800-34899");
  options.hostName="clusterio-host-2"; options.env.CLUSTERIO_HOST_TOKEN=jwt(8);
  assert.equal(plan(stored,options).get("host.id"),8);
  assert.equal(plan(stored,options).get("host.factorio_port_range"),"34200-34299");
  assert.equal(hostNumber("clusterio-host-01"),1);
  assert.throws(()=>hostNumber("host-99999999999999999999"), /valid host number/);
});
test("the pre-alpha-14 slave claim names the host id too", t => {
  const options=fixture(t); options.env.CLUSTERIO_HOST_TOKEN=jwt(5,"slave");
  assert.equal(plan(stored,options).get("host.id"),5);
});
test("log retention: digits are written, empty writes nothing, anything else throws", t => {
  const options=fixture(t);
  options.env.CLUSTERIO_LOG_RETENTION_DAYS="14";
  assert.deepEqual([...plan(stored,options)], [["host.log_retention_days",14]]);
  options.env.CLUSTERIO_LOG_RETENTION_DAYS="0";
  assert.deepEqual([...plan(stored,options)], [["host.log_retention_days",0]]);
  assert.deepEqual([...plan({...stored,"host.log_retention_days":0},options)], []);
  options.env.CLUSTERIO_LOG_RETENTION_DAYS="";
  assert.deepEqual([...plan(stored,options)], []);
  for (const value of ["abc","-1","1.5"]) {
    options.env.CLUSTERIO_LOG_RETENTION_DAYS=value;
    assert.throws(()=>plan(stored,options), /CLUSTERIO_LOG_RETENTION_DAYS/);
  }
});
test("invalid explicit input never silently falls back to saved credentials", t => {
  for(const [key,value] of [["CLUSTERIO_HOST_TOKEN","bad"],["CLUSTERIO_HOST_TOKEN","a..c"],["CLUSTERIO_HOST_TOKEN","a.b. c"]]) {
    const options=fixture(t); options.env[key]=value;
    assert.throws(()=>plan(stored,options));
  }
});
test("a token that does not name a host id is refused", t => {
  const options=fixture(t); options.env.CLUSTERIO_HOST_TOKEN="a.b.c";
  assert.throws(()=>plan(stored,options), /host id.*Configuration was retained/);
});

test("empty optional environment values retain the existing fallback behavior", t => {
  const options=fixture(t);
  options.env={CLUSTERIO_HOST_TOKEN:"",CONTROLLER_URL:"",FACTORIO_PORT_RANGE:"",CLUSTERIO_LOG_RETENTION_DAYS:""};
  assert.deepEqual([...plan(stored,options)],[]);
});

test("the token check maps the controller's answer and never waits on a URL that cannot work", async () => {
  const values = {"host.id":7, "host.controller_url":"http://controller:8080/", "host.controller_token":jwt(7)};
  const calls = [];
  const answering = status => async (url, options) => { calls.push([String(url), options.headers.Authorization]); return {status}; };
  assert.equal(await checkToken(values, answering(200)), "accepted");
  assert.deepEqual(calls[0], ["http://controller:8080/api/host-pairing/check", "Bearer " + jwt(7)]);
  assert.equal(await checkToken(values, answering(401)), "rejected");
  // A proxy in front of a controller that is down is not the controller's answer.
  for (const status of [500, 502, 503, 429]) assert.equal(await checkToken(values, answering(status)), "unreachable");
  assert.equal(await checkToken(values, async () => { throw new TypeError("fetch failed"); }), "unreachable");
  // A controller older than Clusterio 2.1 has no such endpoint.
  for (const status of [404, 403, 302]) assert.equal(await checkToken(values, answering(status)), "unsupported");
  for (const url of ["clusterio-controller:8080/", "ftp://controller/", "http://bad host/", "", undefined]) {
    await assert.rejects(checkToken({...values, "host.controller_url":url}, answering(200)), /Invalid effective host.controller_url/, String(url));
  }
});
