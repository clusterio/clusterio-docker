// Runs offline inside the candidate host image, as clusterio. Real CLI, no mocks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {nativeConfig,reconcile,applyChanges,effective} = require("/scripts/configure-host.cjs");
// A host token as the controller issues it; only the payload's `host` claim matters here.
const jwt = id => "x." + Buffer.from(JSON.stringify({aud:"host",host:id})).toString("base64url") + ".y";
assert.notEqual(process.getuid(),0);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"native-host-"));
const config=path.join(dir,"host.json"), token=path.join(dir,"host.token");
try {
  const cli=nativeConfig(config);
  // A first configuration that fails leaves no file: one holding Clusterio's defaults
  // would pass for a configured host on the next boot.
  assert.throws(()=>reconcile(config,"/opt/factorio","clusterio-host-08",token,
    {CLUSTERIO_HOST_TOKEN:jwt(933475968),CLUSTERIO_LOG_RETENTION_DAYS:"abc"}), /CLUSTERIO_LOG_RETENTION_DAYS/);
  assert.equal(fs.existsSync(config),false);
  reconcile(config,"/opt/factorio","clusterio-host-08",token,{CLUSTERIO_HOST_TOKEN:jwt(933475968),CLUSTERIO_LOG_RETENTION_DAYS:"0"});
  assert.equal(cli.read()["host.log_retention_days"],0);
  assert.equal(cli.read()["host.name"],"clusterio-host-08");
  assert.equal(cli.read()["host.id"],933475968);
  assert.equal(cli.read()["host.factorio_port_range"],"34800-34899");
  cli.write("host.name","operator name"); cli.write("host.instances_directory",path.join(dir,"custom"));
  reconcile(config,"/opt/factorio","clusterio-host-1",token,{CLUSTERIO_HOST_TOKEN:jwt(17)});
  assert.equal(cli.read()["host.name"],"operator name");
  assert.equal(cli.read()["host.instances_directory"],path.join(dir,"custom"));
  assert.equal(cli.read()["host.controller_token"],jwt(17));
  assert.equal(cli.read()["host.id"],17);
  cli.write("host.id",21); cli.write("host.controller_url","http://effective:8080/");
  assert.equal(effective(config),"21\nhttp://effective:8080/");
  const before=fs.readFileSync(config,"utf8");
  assert.throws(()=>applyChanges(cli,new Map([["host.id","not-a-number"]])), /did not accept/);
  assert.equal(fs.readFileSync(config,"utf8"),before);
  fs.writeFileSync(config,"broken JSON");
  assert.throws(()=>reconcile(config,"/opt/factorio","host-1",token,{}), /configuration command failed/);
  assert.equal(fs.readFileSync(config,"utf8"),"broken JSON");
  console.log(JSON.stringify({nativeConfiguration:"passed", invalidWriteRejected:true, unreadableConfigPreserved:true, failedFirstConfigurationRemoved:true}));
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
