// Native container acceptance. All resources belong to this run; no live cluster access.
import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {mkdirSync, writeFileSync, cpSync, readFileSync} from "node:fs";
import {resolve, join} from "node:path";
import {randomUUID, createHash} from "node:crypto";
const [controllerImage, hostImage, ...flags] = process.argv.slice(2);
assert.ok(controllerImage && hostImage, "consumer-smoke.mjs CONTROLLER HOST [--plugins names|none] [--case name] [--skip-package] [--previous-host IMAGE] [--previous-controller IMAGE]");
const options = {plugins:"none", case:"all"};
for(let i=0;i<flags.length;i++) {
  const key=flags[i];
  if(key==="--skip-package") options.skipPackage=true;
  else if(["--plugins","--case","--previous-host","--previous-controller"].includes(key)) {
    assert.ok(flags[i+1] && !flags[i+1].startsWith("--"), "Missing value for "+key);
    options[key.slice(2)]=flags[++i];
  } else throw Error("Unknown option "+key);
}
const cases=["lifecycle","shutdown","stale-lock","rotation","overrides","saved-identity","hook-identity","zero-id","host-wipe","scale-out","controller-wipe","failures","upgrade","cluster-upgrade"];
assert.ok(options.case==="all" || cases.includes(options.case), "Unknown acceptance case");
const expected=options.plugins==="none"?[]:options.plugins.split(",").sort();
const run="cd-smoke-"+randomUUID().slice(0,12), label="clusterio-docker.smoke";
const directory=resolve("ci-artifacts",run); mkdirSync(directory,{recursive:true});
const report={schemaVersion:2,run,startedAt:new Date().toISOString(),checks:[],cases:[],cleanup:false,
  options, harnessSha256:createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex")};
const volumes=[], containers=[];
let network=false;
const redact=value=>String(value).replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,"[REDACTED]");
const docker=(...args)=>dockerWith({},...args);
// `secrets` reach the docker client through its environment (`-e NAME` without a value), so
// a real token is never an argument of a process on this machine.
function dockerWith(secrets,...args) {
  try { return execFileSync("docker",args,{encoding:"utf8",timeout:180000,maxBuffer:2097152,stdio:["pipe","pipe","pipe"],env:{...process.env,...secrets}}).trim(); }
  catch(error) {
    // exec errors contain argv (including temporary tokens); never retain that object.
    throw Error("docker "+args[0]+" failed ("+(error.status??error.code)+"): "+redact(error.stderr||"").slice(-4000));
  }
}
const check=name=>{report.checks.push(name);console.log("PASS: "+name);};
async function until(read,description) {
  const end=Date.now()+150000;let last;
  while(Date.now()<end) {
    try {if(read())return;}catch(error){last=error.message;}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw Error(description+" timed out"+(last?": "+last:""));
}
function owned(kind,name) {
  assert.ok(name.startsWith(run));
  const info=JSON.parse(docker(kind,"inspect",name))[0];
  assert.equal((kind==="container"?info.Config.Labels:info.Labels)?.[label],run);
}
function create(name,image,args=[]) {
  dockerWith(args.secrets??{},"create","--name",name,"--label",label+"="+run,...(network?["--network",run]:[]),...args,image);
  containers.push(name);
}
// Container arguments that give it a host token without putting the token in argv.
const withHostToken=(args,jwt)=>Object.assign([...args,"-e","CLUSTERIO_HOST_TOKEN"],{secrets:{CLUSTERIO_HOST_TOKEN:jwt}});
function remove(name) {
  owned("container",name);docker("rm","-f",name);containers.splice(containers.indexOf(name),1);
}
function local(name,role,...args) {
  return docker("exec","--user","clusterio",name,"/clusterio/node_modules/.bin/clusterio"+role,
    "--log-level","error","--config","/clusterio/data/config-"+role+".json",...args);
}
const ctl=run+"-controller",host=run+"-host";
const ctlArgs=(hostCount=2)=>["--network-alias","controller","--network-alias","alternate","-p","127.0.0.1::8080",
  "-e","INIT_CLUSTERIO_ADMIN=smoke","-e","HOST_COUNT="+hostCount,"-e","EXPORT_HOST=0",
  ...["data","logs","mods","static","tokens"].flatMap(s=>["-v",run+"-controller-"+s+":/clusterio/"+s])];
const hostArgs=({CLUSTERIO_HOST_TOKEN:explicit,...env}={},dataVolume=run+"-host-data")=>{
  const args=[
    ...Object.entries({HOST_NAME:"clusterio-host-1",CONTROLLER_URL:"http://controller:8080/",...env})
      .filter(([,v])=>v!==null).flatMap(([k,v])=>["-e",k+"="+v]),
    "-v",dataVolume+":/clusterio/data","-v",run+"-host-logs:/clusterio/logs",
    "-v",run+"-controller-tokens:/clusterio/tokens:ro"];
  // An empty value is a setting under test, not a secret.
  return explicit?withHostToken(args,explicit):explicit===""?[...args,"-e","CLUSTERIO_HOST_TOKEN="]:args;
};
const hook=join(directory,"10-config.sh");
writeFileSync(hook,'set -eu\n[ "$(id -u)" -ne 0 ]\n/clusterio/node_modules/.bin/clusterio"$CLUSTERIO_ROLE" --log-level error --config "$CLUSTERIO_CONFIG_PATH" config set "$CLUSTERIO_ROLE.allow_remote_updates" false\nif [ "$CLUSTERIO_ROLE" = host ] && [ ! -e /clusterio/data/hook-calls ]; then\n  /clusterio/node_modules/.bin/clusteriohost --log-level error --config "$CLUSTERIO_CONFIG_PATH" config set host.name persisted-operator-name\nfi\nprintf "hook\\n" >> /clusterio/data/hook-calls\n');
function copyHook(name){docker("cp",hook,name+":/etc/clusterio/pre-start.d/10-config.sh");}
const health=name=>until(()=>JSON.parse(docker("inspect",name))[0].State.Health?.Status==="healthy",name+" health");
const token=(id,controller=ctl)=>docker("exec",controller,"cat","/clusterio/tokens/clusterio-host-"+id+".token");
const controlOn=(controller,...args)=>docker("exec","--user","clusterio",controller,"/clusterio/node_modules/.bin/clusterioctl","--log-level","error","--config","/clusterio/tokens/config-control.json",...args);
const control=(...args)=>controlOn(ctl,...args);
// Clusterio 2.1: the controller assigns host ids, and a token names the id it was issued for.
const hostIdOf=jwt=>JSON.parse(Buffer.from(jwt.split(".")[1],"base64url")).host;
const unsignedToken=id=>"x."+Buffer.from(JSON.stringify({aud:"host",host:id})).toString("base64url")+".y";
const hosts=(controller=ctl)=>JSON.parse(controlOn(controller,"host","list","--output","json"));
// Speaks the host pairing endpoints from outside, as the admin user. Tokens stay out of argv.
async function controllerApi(route,{bearer,body,controller=ctl}={}) {
  const admin=()=>JSON.parse(docker("exec",controller,"cat","/clusterio/tokens/config-control.json"))["ctl.controller_token"];
  const response=await fetch("http://"+docker("port",controller,"8080/tcp").split("\n")[0]+"/"+route,{method:body?"POST":"GET",
    headers:{Authorization:"Bearer "+(bearer??admin()),...(body?{"Content-Type":"application/json"}:{})},
    body:body&&JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {status:response.status,json:await response.json().catch(()=>null)};
}
const accepted=async(jwt,controller)=>(await controllerApi("api/host-pairing/check",{bearer:jwt,controller})).status===200;
const logsOf=name=>{
  const output=spawnSync("docker",["logs",name],{encoding:"utf8",timeout:15000,maxBuffer:8388608});
  return String(output.stdout)+String(output.stderr);
};
// Healthy means the controller reports the host connected, and a killed container's session
// can keep that flag up for a minute. The host's own log line is what proves this container
// connected.
async function hostReady(name) {
  await health(name);
  assert.match(logsOf(name),/Started host/,name+" is reported healthy but never logged that it started");
}
async function restartHost(env={},extraHook,dataVolume) {
  // Stopped before it is removed, so the controller sees the old session close.
  if(containers.includes(host)) {docker("stop","-t","60",host);remove(host);}
  create(host,report.images.host,hostArgs(env,dataVolume));copyHook(host);
  if(extraHook)docker("cp",extraHook,host+":/etc/clusterio/pre-start.d/20-case.sh");
  docker("start",host);await hostReady(host);
}
async function scenario(name,fn) {
  if(options.case!=="all" && options.case!==name) return;
  const entry={name,status:"running",startedAt:new Date().toISOString()};report.cases.push(entry);
  try{await fn();entry.status="passed";check(name);}catch(error){entry.status="failed";throw error;}
  finally{entry.finishedAt=new Date().toISOString();}
}
try {
  report.images=Object.fromEntries([["controller",controllerImage],["host",hostImage]].map(([role,image])=>
    [role,docker("image","inspect",image,"--format","{{.Id}}")]));
  for(const [role,image] of Object.entries(report.images)) {
    const name=run+"-cli-"+role;
    docker("create","--name",name,"--label",label+"="+run,"--network","none","--user","clusterio",
      "--entrypoint","node",image,"/scripts/verify-cli.cjs",role,JSON.stringify(expected));containers.push(name);
    const output=docker("start","-a",name);
    assert.equal(JSON.parse(docker("inspect",name))[0].State.ExitCode,0,"Native CLI failed");
    (report.nativeCli??={})[role]=JSON.parse(output);
    assert.deepEqual(report.nativeCli[role].plugins,expected);check(role+" native CLI and explicit plugin selection");
    report[role+"BuildInfo"]=JSON.parse(docker("run","--rm","--network","none","--entrypoint","cat",image,"/clusterio/BUILD_INFO"));
  }
  if(options.case==="all") {
    const name=run+"-native-config";
    docker("create","--name",name,"--label",label+"="+run,"--network","none","--user","clusterio",
      "--entrypoint","node",report.images.host,"/tmp/native-host-config.cjs");containers.push(name);
    docker("cp","tests/native-host-config.cjs",name+":/tmp/native-host-config.cjs");
    docker("start","-a",name);
    assert.equal(JSON.parse(docker("inspect",name))[0].State.ExitCode,0,"Native configuration contract failed");
    check("native configuration rejection and preservation");
  }
  let consumer=report.images.controller;
  if(!options.skipPackage) {
    const context=join(directory,"consumer");mkdirSync(context);
    cpSync("seed-data/external_plugins/ci_fixture",join(context,"fixture"),{recursive:true,filter:p=>!p.includes("node_modules")});
    const baseTag=run+"-base";docker("tag",consumer,baseTag);
    const pack='const cp=require("child_process"); const result=JSON.parse(cp.execFileSync("npm",["pack","--json","--pack-destination","/tmp"],{cwd:"/tmp/fixture",encoding:"utf8"})); cp.execFileSync("npm",["install","--omit=dev","--no-audit","--no-fund","/tmp/"+result[0].filename],{cwd:"/clusterio",stdio:"inherit"});';
    writeFileSync(join(context,"install.cjs"),pack);
    writeFileSync(join(context,"Dockerfile"),"FROM "+baseTag+"\nUSER root\nCOPY fixture /tmp/fixture\nCOPY install.cjs /tmp/install.cjs\nRUN node /tmp/install.cjs\nUSER clusterio\nRUN node /scripts/verify-cli.cjs controller '"+JSON.stringify([...expected,"ci_fixture"].sort())+"'\nUSER root\n");
    const derived=run+"-consumer";docker("build","-t",derived,context);
    consumer=docker("image","inspect",derived,"--format","{{.Id}}");
    check("packaged plugin discovery and shared dependency resolution");
  } else report.packageCheck="skipped: base-image acceptance; packaged plugin tested separately";
  report.consumerImage=consumer;
  docker("network","create","--label",label+"="+run,run);network=true;
  for(const suffix of ["controller-data","controller-logs","controller-mods","controller-static","controller-tokens","host-data","host-logs"]) {
    const name=run+"-"+suffix;docker("volume","create","--label",label+"="+run,name);volumes.push(name);
  }
  async function startController(hostCount) {create(ctl,consumer,ctlArgs(hostCount));copyHook(ctl);docker("start",ctl);await health(ctl);}
  await startController();await restartHost();
  assert.equal(local(host,"host","config","show","host.name"),"persisted-operator-name");
  assert.equal(local(host,"host","config","show","host.allow_remote_updates"),"false");
  await scenario("lifecycle",async()=>{
    for(const dir of ["data","mods","static","logs"])
      docker("exec","--user","clusterio",ctl,"sh","-c","printf retained > /clusterio/"+dir+"/keep");
    remove(host);remove(ctl);await startController();await restartHost();
    // Both were killed, the controller possibly before it saved the hosts it had just
    // created (it autosaves every 60s). Whether it kept them or issued new tokens, the host
    // must be running as the host its token file names.
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(token(1))));
    for(const [name,role] of [[ctl,"controller"],[host,"host"]]) {
      assert.equal(local(name,role,"config","show",role+".allow_remote_updates"),"false");
      assert.equal(docker("exec",name,"cat","/clusterio/data/hook-calls"),"hook\nhook");
    }
    for(const dir of ["data","mods","static","logs"])
      assert.equal(docker("exec",ctl,"cat","/clusterio/"+dir+"/keep"),"retained");
    const port=docker("port",ctl,"8080/tcp");assert.match(port,/^127\.0\.0\.1:\d+$/);
    const response=await fetch("http://"+port+"/static/keep",{signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);assert.equal(await response.text(),"retained");
  });
  await scenario("shutdown",async()=>{
    // Changed well inside the 60s autosave interval, so only a graceful stop can persist it.
    const name="graceful-"+run;
    control("controller","config","set","controller.name",name);
    const stop=target=>{
      const started=Date.now();docker("stop","-t","60",target);
      const logs=spawnSync("docker",["logs","--tail","200",target],{encoding:"utf8",timeout:15000,maxBuffer:1048576});
      return {target,ms:Date.now()-started,exitCode:JSON.parse(docker("inspect",target))[0].State.ExitCode,
        text:String(logs.stdout)+String(logs.stderr)};
    };
    const assertGraceful=result=>{
      assert.match(result.text,/Caught termination, shutting down/,result.target+" did not receive SIGTERM");
      assert.equal(result.exitCode,0,result.target+" exited "+result.exitCode+" after "+result.ms+"ms instead of shutting down cleanly");
    };
    for(const target of [ctl,host]) assertGraceful(stop(target));
    docker("start",ctl);await health(ctl);
    assert.equal(local(ctl,"controller","config","show","controller.name"),name);
    // Control: a host whose shutdown rejects must fail the same check.
    // Clusterio 2.0 is ESM: preload the fault with --import (an .mjs), not --require.
    const fault=run+"-fault-host", preload=join(directory,"fail-shutdown.mjs");
    writeFileSync(preload,'import Host from "/clusterio/node_modules/@clusterio/host/dist/node/src/Host.js";\nHost.prototype.shutdown=async()=>{throw new Error("injected shutdown failure");};\n');
    create(fault,report.images.host,[...hostArgs(),"-e","NODE_OPTIONS=--import /tmp/fail-shutdown.mjs"]);
    copyHook(fault);docker("cp",preload,fault+":/tmp/fail-shutdown.mjs");docker("start",fault);await health(fault);
    const failed=stop(fault);remove(fault);
    assert.match(failed.text,/Error during shutdown/,"the shutdown fault was not injected");
    assert.throws(()=>assertGraceful(failed),/exited 1 /,"a failed shutdown must not pass as graceful");
    docker("start",host);await health(host);
  });
  await scenario("stale-lock",async()=>{
    // A killed host leaves its lock naming PID 1, which is the restarted host itself. Before
    // Clusterio 2.1 that lock never counted as stale; 2.1 compares the process start time
    // too. The entrypoint removes it either way, and says so.
    // Recreate without the fixture hook: its CLI write would clear the lock first (EPERM on
    // root's PID 1 counts as stale), while an unchanged configuration writes nothing.
    docker("kill",host);
    const lock=join(directory,"config-host.json.lock");
    docker("cp",host+":/clusterio/data/config-host.json.lock",lock);
    // Clusterio 2.1 writes the process start time after the pid.
    assert.equal(readFileSync(lock,"utf8").trim().split(/\s+/)[0],"1","the killed host did not leave a lock naming PID 1");
    remove(host);create(host,report.images.host,hostArgs());docker("start",host);await hostReady(host);
    assert.match(logsOf(host),/Removing stale host lock file\(s\) from a previous run/,"the entrypoint did not remove the lock");
  });
  await scenario("rotation",async()=>{
    // Clusterio 2.1 cannot issue a second token for a host, so the explicit token belongs to
    // another host: one approved with the admin token, as a remote host's would be.
    const old=token(1), paired=await controllerApi("api/host-pairing",{body:{name:"explicit-token-host"}});
    assert.equal(paired.status,200,"the admin token could not create a host");
    const next=paired.json.token;
    assert.notEqual(hostIdOf(next),hostIdOf(old),"an explicit token must name another host");
    await restartHost({CLUSTERIO_HOST_TOKEN:next});
    assert.equal(local(host,"host","config","show","host.controller_token"),next);
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(next)),"the host id must follow the explicit token");
    assert.equal(local(host,"host","config","show","host.name"),"persisted-operator-name");
    // The stale file still exists: explicit environment credentials must win.
    assert.equal(token(1),old);
    await restartHost({CLUSTERIO_HOST_TOKEN:"",CONTROLLER_URL:"",FACTORIO_PORT_RANGE:""}); // Empty optional values also fall back.
    assert.equal(local(host,"host","config","show","host.controller_token"),old);
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(old)),"the host id must follow the token file");
    control("host","revoke",String(hostIdOf(next)));
    assert.equal(await accepted(next),false,"a revoked host's token must be rejected");
  });
  await scenario("overrides",async()=>{
    await restartHost({CONTROLLER_URL:"http://alternate:8080/",FACTORIO_PORT_RANGE:"35100-35199"});
    assert.equal(local(host,"host","config","show","host.controller_url"),"http://alternate:8080/");
    assert.equal(local(host,"host","config","show","host.factorio_port_range"),"35100-35199");
    await restartHost({CONTROLLER_URL:null});
    assert.equal(local(host,"host","config","show","host.controller_url"),"http://alternate:8080/");
    assert.equal(local(host,"host","config","show","host.factorio_port_range"),"35100-35199");
  });
  await scenario("saved-identity",async()=>{
    await restartHost({HOST_NAME:"clusterio-host-99",CONTROLLER_URL:null});
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(token(1))));
    assert.equal(local(host,"host","config","show","host.name"),"persisted-operator-name");
  });
  await scenario("hook-identity",async()=>{
    const file=join(directory,"identity.sh");
    // The hook takes over another host's identity: its token, and the id that token names.
    writeFileSync(file,'set -eu\ncli=/clusterio/node_modules/.bin/clusteriohost\ntoken=/clusterio/tokens/clusterio-host-2.token\n"$cli" --log-level error --config "$CLUSTERIO_CONFIG_PATH" config set host.id "$(node /scripts/host-token.cjs id "$token")"\n"$cli" --log-level error --config "$CLUSTERIO_CONFIG_PATH" config set host.controller_token --stdin < "$token"\n"$cli" --log-level error --config "$CLUSTERIO_CONFIG_PATH" config set host.controller_url http://alternate:8080/\n');
    await restartHost({},file);
    assert.notEqual(hostIdOf(token(2)),hostIdOf(token(1)));
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(token(2))));
    assert.equal(local(host,"host","config","show","host.controller_url"),"http://alternate:8080/");
    // Restore both identity and its credential together before following cases.
    writeFileSync(file,readFileSync(file,"utf8").replace("host-2.token","host-1.token"));
    await restartHost({},file);
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(token(1))));
  });
  await scenario("zero-id",async()=>{
    remove(host);
    const name=run+"-zero-id";
    create(name,report.images.host,withHostToken(["-e","HOST_NAME=clusterio-host-01","-e","CONTROLLER_URL=http://controller:8080/",
      "-v",run+"-controller-tokens:/clusterio/tokens:ro"],token(1)));
    docker("start",name);await health(name);
    // The id comes from the token; the name's number only picks the port range.
    assert.equal(local(name,"host","config","show","host.id"),String(hostIdOf(token(1))));
    assert.equal(local(name,"host","config","show","host.factorio_port_range"),"34100-34199");
    remove(name);await restartHost();
  });
  await scenario("host-wipe",async()=>{
    // A host that loses its data volume comes back as the same host, from its token file.
    const before=local(host,"host","config","show","host.id"), known=hosts().map(entry=>entry.id).sort();
    control("instance","create","wipe-"+run);control("instance","assign","wipe-"+run,before);
    docker("stop","-t","60",host);remove(host);owned("volume",run+"-host-data");docker("volume","rm",run+"-host-data");
    docker("volume","create","--label",label+"="+run,run+"-host-data");
    await restartHost();
    assert.equal(local(host,"host","config","show","host.id"),before);
    assert.deepEqual(hosts().map(entry=>entry.id).sort(),known,"the wiped host must not be registered as a new host");
    assert.equal(hosts().find(entry=>String(entry.id)===before).connected,true);
    const instance=JSON.parse(control("instance","list","--output","json")).find(entry=>entry.name==="wipe-"+run);
    assert.equal(String(instance.assignedHost),before,"the instance must still be assigned to the host");
  });
  await scenario("scale-out",async()=>{
    // Raising HOST_COUNT issues the new host's token on the next controller start, and
    // leaves the tokens it already issued alone.
    // Stopped, not killed, as `docker compose up -d` does: hosts the controller created
    // since its last autosave (60s) exist only in memory until it shuts down.
    const recreate=async count=>{docker("stop","-t","60",ctl);remove(ctl);await startController(count);};
    const before=[token(1),token(2)];
    assert.throws(()=>token(3),"host 3 must not have a token yet");
    await recreate(3);
    assert.deepEqual([token(1),token(2)],before);
    assert.equal(await accepted(token(3)),true,"the new host's token must be accepted");
    assert.equal(hosts().filter(entry=>entry.name==="clusterio-host-3").length,1);
    await recreate(3);
    assert.equal(hosts().filter(entry=>entry.name==="clusterio-host-3").length,1,"a restart must not register the host twice");
    await until(()=>hosts().some(entry=>entry.connected),"host reconnecting after the controller restarts");
  });
  await scenario("controller-wipe",async()=>{
    // A wiped controller volume invalidates every host token. The host is started first,
    // as compose does after a controller restart: it has to wait for its token to be
    // issued again and take the new identity without anyone restarting it.
    const old=token(1);
    remove(host);remove(ctl);owned("volume",run+"-controller-data");docker("volume","rm",run+"-controller-data");
    docker("volume","create","--label",label+"="+run,run+"-controller-data");
    create(host,report.images.host,hostArgs());copyHook(host);docker("start",host);
    await until(()=>/Waiting for the controller to answer/.test(logsOf(host)),"host waiting for the controller");
    await startController();
    assert.notEqual(token(1),old,"the controller must issue a new token");
    await hostReady(host);
    assert.equal(local(host,"host","config","show","host.controller_token"),token(1));
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(token(1))));
    assert.equal(local(host,"host","config","show","host.name"),"persisted-operator-name");
    assert.match(logsOf(host),/configuring the host again/,"the host did not take the re-issued token file");
  });
  await scenario("failures",async()=>{
    const name=run+"-bad-hook";
    create(name,report.images.host,["-e","CLUSTERIO_HOST_TOKEN="+unsignedToken(7),"-e","HOST_NAME=clusterio-host-1"]);
    const bad=join(directory,"fail.sh");writeFileSync(bad,"exit 17\n");
    docker("cp",bad,name+":/etc/clusterio/pre-start.d/10-fail.sh");docker("start",name);
    await until(()=>JSON.parse(docker("inspect",name))[0].State.Status==="exited","failing hook");
    assert.equal(JSON.parse(docker("inspect",name))[0].State.ExitCode,17);
  });
  if(options["previous-host"]) await scenario("upgrade",async()=>{
    remove(host);
    const previous=docker("image","inspect",options["previous-host"],"--format","{{.Id}}");
    report.previousHostImage=previous;
    const name=run+"-previous-config";
    const dataVolume=run+"-upgrade-data";
    docker("volume","create","--label",label+"="+run,dataVolume);volumes.push(dataVolume);
    // Clusterio 2.0 CLIs need `config create` before `config set` on a missing file; pre-2.0
    // CLIs create it on `set` and reject `create` as an unknown argument, the only failure tolerated.
    const script='const cp=require("child_process"),fs=require("fs");const config="/clusterio/data/config-host.json"; const cli=["clusterio","/clusterio/node_modules/.bin/clusteriohost","--log-level","error","--config",config,"config"]; cp.execFileSync("chown",["clusterio:clusterio","/clusterio/data"]); if(!fs.existsSync(config)) try{cp.execFileSync("gosu",[...cli,"create"],{stdio:["ignore","pipe","pipe"]});}catch(error){if(!String(error.stderr).includes("Unknown argument: create"))throw error;} for(const [key,value] of [["host.id","1"],["host.controller_url","http://controller:8080/"],["host.controller_token",fs.readFileSync("/clusterio/tokens/clusterio-host-1.token","utf8").trim()],["host.name","previous-image-operator"],["host.instances_directory","/clusterio/data/operator-instances"]]) cp.execFileSync("gosu",[...cli,"set",key,"--stdin"],{input:value,stdio:["pipe","pipe","pipe"]}); fs.mkdirSync("/clusterio/data/operator-instances",{recursive:true});fs.writeFileSync("/clusterio/data/operator-instances/keep","retained");';
    docker("create","--name",name,"--label",label+"="+run,"--network","none","--user","root",
      "-v",dataVolume+":/clusterio/data","-v",run+"-controller-tokens:/clusterio/tokens:ro","--entrypoint","node",previous,"-e",script);containers.push(name);
    docker("start","-a",name);assert.equal(JSON.parse(docker("inspect",name))[0].State.ExitCode,0);
    // This case preserves prior-image configuration without the display-name fixture hook.
    create(host,report.images.host,hostArgs({},dataVolume));docker("start",host);await hostReady(host);
    assert.equal(local(host,"host","config","show","host.name"),"previous-image-operator");
    assert.equal(local(host,"host","config","show","host.instances_directory"),"/clusterio/data/operator-instances");
    assert.equal(docker("exec",host,"cat","/clusterio/data/operator-instances/keep"),"retained");
    // The fixture wrote the pre-2.1 id (1, from the name); the candidate takes it from the token.
    assert.equal(local(host,"host","config","show","host.id"),String(hostIdOf(token(1))));
    report.upgradeBoundary="Configuration written by previous native CLI, then candidate startup; no game or database migration";
  }); else if(options.case==="all" || options.case==="upgrade") {
    report.cases.push({name:"upgrade",status:"unverified",reason:"No --previous-host supplied"});
    if(options.case==="upgrade")throw Error("--case upgrade requires --previous-host");
  }
  if(options["previous-host"] && options["previous-controller"]) await scenario("cluster-upgrade",async()=>{
    // A cluster created and used by the previous images, then restarted on the candidates.
    const previous=Object.fromEntries(["controller","host"].map(role=>
      [role,docker("image","inspect",options["previous-"+role],"--format","{{.Id}}")]));
    report.previousClusterImages=previous;
    const up=run+"-up", upCtl=up+"-controller", upHost=up+"-host";
    for(const suffix of ["controller-data","controller-tokens","controller-logs","host-data","host-logs"]) {
      docker("volume","create","--label",label+"="+run,up+"-"+suffix);volumes.push(up+"-"+suffix);
    }
    const upCtlArgs=["--network-alias","upgrade-controller","-p","127.0.0.1::8080","-e","INIT_CLUSTERIO_ADMIN=smoke",
      "-e","HOST_COUNT=2","-e","EXPORT_HOST=0",...["data","tokens","logs"].flatMap(s=>["-v",up+"-controller-"+s+":/clusterio/"+s])];
    const upHostArgs=["-e","HOST_NAME=clusterio-host-1","-e","CONTROLLER_URL=http://upgrade-controller:8080/",
      "-v",up+"-host-data:/clusterio/data","-v",up+"-host-logs:/clusterio/logs","-v",up+"-controller-tokens:/clusterio/tokens:ro"];
    create(upCtl,previous.controller,upCtlArgs);docker("start",upCtl);await health(upCtl);
    create(upHost,previous.host,upHostArgs);docker("start",upHost);await health(upHost);
    const before=[token(1,upCtl),token(2,upCtl)];
    // The id the previous controller knows host 1 by: 1 before Clusterio 2.1, random since.
    const hostId=hostIdOf(before[0]);
    controlOn(upCtl,"instance","create","kept");controlOn(upCtl,"instance","assign","kept",String(hostId));
    const previousVersion=JSON.parse(docker("exec",upCtl,"cat","/clusterio/BUILD_INFO")).clusterioVersion;
    report.clusterUpgradeFrom=previousVersion;
    const [major,minor]=String(previousVersion).split(".").map(Number);
    assert.ok(Number.isInteger(major) && Number.isInteger(minor),"previous controller's BUILD_INFO names no Clusterio version");
    // Since Clusterio 2.1 the controller creates every host it issues a token for. Before,
    // a host was registered only once it had connected.
    const createsHosts=major>2 || (major===2 && minor>=1);
    for(const name of [upHost,upCtl]) {docker("stop","-t","60",name);remove(name);}
    create(upCtl,report.images.controller,upCtlArgs);docker("start",upCtl);await health(upCtl);
    // Host 1 connected under the previous version, so the controller knows it: token and id
    // survive. Host 2 never connected: a 2.1 controller created it anyway and its token
    // survives too; a pre-2.1 token names a host that does not exist and is replaced.
    assert.equal(token(1,upCtl),before[0],"a host that had connected must keep its token");
    if(createsHosts) assert.equal(token(2,upCtl),before[1],"a host the previous controller created must keep its token");
    else assert.notEqual(token(2,upCtl),before[1],"a host that never connected must get a new token");
    assert.equal(await accepted(token(2,upCtl),upCtl),true);
    create(upHost,report.images.host,upHostArgs);docker("start",upHost);await hostReady(upHost);
    assert.equal(local(upHost,"host","config","show","host.id"),String(hostId));
    assert.deepEqual(hosts(upCtl).filter(entry=>entry.connected).map(entry=>entry.id),[hostId]);
    assert.equal(hosts(upCtl).length,2,"the upgrade must not register a host twice");
    assert.equal(JSON.parse(controlOn(upCtl,"instance","list","--output","json")).find(entry=>entry.name==="kept").assignedHost,hostId);
    report.clusterUpgradeBoundary="Controller database, tokens and host configuration written by the previous images, then candidate startup; no instance was started";
  }); else if(options.case==="all" || options.case==="cluster-upgrade") {
    report.cases.push({name:"cluster-upgrade",status:"unverified",reason:"Needs --previous-host and --previous-controller"});
    if(options.case==="cluster-upgrade")throw Error("--case cluster-upgrade requires --previous-host and --previous-controller");
  }
  report.coverageComplete=report.cases.every(entry=>entry.status==="passed");
  report.verdict="PASS";
} catch(error) {report.verdict="FAIL";report.error=redact(error.stack);process.exitCode=1;}
finally {
  const errors=[];
  for(const name of [...containers].reverse()) {
    try {
      owned("container",name);
      const output=spawnSync("docker",["logs","--tail","100",name],{encoding:"utf8",timeout:15000,maxBuffer:1048576});
      writeFileSync(join(directory,name+".log"),redact(String(output.stdout||"")+"\n"+String(output.stderr||"")).slice(-131072));
      if(output.error)(report.incompleteDiagnostics??=[]).push(name);
      docker("rm","-f",name);
    } catch(error){errors.push(error.message);}
  }
  for(const name of volumes) {try{owned("volume",name);docker("volume","rm",name);}catch(error){errors.push(error.message);}}
  if(network) {try{owned("network",run);docker("network","rm",run);}catch(error){errors.push(error.message);}}
  for(const kind of ["container","volume","network"]) {
    try {assert.equal(docker(...(kind==="container"?["ps","-aq"]:[kind,"ls","-q"]),"--filter","label="+label+"="+run),"");}
    catch(error){errors.push(error.message);}
  }
  report.cleanup=errors.length===0;report.cleanupErrors=errors;report.finishedAt=new Date().toISOString();
  if(!report.cleanup){report.verdict="FAIL";process.exitCode=1;}
  writeFileSync(join(directory,"result.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({verdict:report.verdict,cases:report.cases,cleanup:report.cleanup,error:report.error,report:join(directory,"result.json")},null,2));
}
