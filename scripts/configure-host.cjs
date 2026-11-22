// Reconcile container inputs through the native CLI; preserve unrelated saved fields.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { tokenHostId } = require("./host-token.cjs");

function nativeConfig(configPath) {
  const binary = "/clusterio/node_modules/.bin/clusteriohost";
  function run(args, input) {
    try {
      return execFileSync(binary, ["--log-level", "error", "--config", configPath, "config", ...args],
        { encoding: "utf8", input, timeout: 30000, maxBuffer: 1048576 });
    } catch {
      // Do not print execFileSync's error: it contains argv/output and may include credentials.
      throw new Error("Native host configuration command failed; inspect the host log. Configuration was retained.");
    }
  }
  return {
    read() {
      const values = {};
      for (const line of run(["list"]).trim().split(/\r?\n/)) {
        const separator = line.indexOf(" ");
        if (separator < 1) throw new Error("Invalid native host configuration output");
        const key = line.slice(0, separator);
        if (Object.hasOwn(values, key)) throw new Error("Duplicate native configuration field");
        try { values[key] = JSON.parse(line.slice(separator + 1)); }
        catch { throw new Error("Invalid native configuration value for " + key); }
      }
      for (const key of ["host.id", "host.name", "host.controller_url", "host.controller_token"]) {
        if (!Object.hasOwn(values, key)) throw new Error("Missing native configuration field: " + key);
      }
      return values;
    },
    write(key, value) { run(["set", key, "--stdin"], String(value)); },
    // Clusterio 2.0 creates config files only on request; `list`/`set` fail on a missing file.
    create() { run(["create"]); },
  };
}
// The number a host is named with (clusterio-host-N). It picks the default game port range.
// It is not the host id: since Clusterio 2.1 the controller assigns that, see host-token.cjs.
function hostNumber(hostName) {
  const number = Number(hostName.match(/[0-9]+$/)?.[0] || "1");
  if (!Number.isSafeInteger(number) || number < 0 || number > 2147483647)
    throw new Error("HOST_NAME must end in a valid host number");
  return number;
}
function explicit(env, key) {
  // Match the entrypoint's existing nonempty override convention (including .env templates).
  return env[key] || undefined;
}
function plan(values, { fresh, configPath, hostName, factorioDirectory, tokenFile, env }) {
  const writes = new Map();
  if (fresh) {
    writes.set("host.name", hostName);
    writes.set("host.instances_directory", path.join(path.dirname(configPath), "instances"));
  }
  const controller = explicit(env, "CONTROLLER_URL");
  if (controller !== undefined || fresh) {
    writes.set("host.controller_url", controller ??
      "http://clusterio-controller:" + (env.CONTROLLER_HTTP_PORT || "8080") + "/");
  }
  const ports = explicit(env, "FACTORIO_PORT_RANGE");
  if (ports !== undefined || fresh) {
    const start = ports === undefined ? 34000 + hostNumber(hostName) * 100 : undefined;
    if (ports === undefined && start + 99 > 65535)
      throw new Error("Host number requires an explicit FACTORIO_PORT_RANGE");
    writes.set("host.factorio_port_range", ports ?? start + "-" + (start + 99));
  }
  const token = explicit(env, "CLUSTERIO_HOST_TOKEN") ??
    (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : undefined) ??
    values["host.controller_token"];
  if (typeof token !== "string" || !/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(token))
    throw new Error("No usable host token: supply CLUSTERIO_HOST_TOKEN or a token file. Configuration was retained.");
  writes.set("host.controller_token", token);
  // The controller refuses a host whose id is not the one its token was issued for, so the
  // id always follows the token in use. A pre-start hook that changes one must change both.
  try { writes.set("host.id", tokenHostId(token)); }
  catch (error) { throw new Error(error.message + ". Configuration was retained."); }
  const retention = explicit(env, "CLUSTERIO_LOG_RETENTION_DAYS");
  if (retention !== undefined) {
    if (!/^[0-9]{1,5}$/.test(retention))
      throw new Error("CLUSTERIO_LOG_RETENTION_DAYS must be a whole number of days, 0 to keep logs forever. Configuration was retained.");
    writes.set("host.log_retention_days", Number(retention));
  }
  writes.set("host.factorio_directory", factorioDirectory);
  return new Map([...writes].filter(([key, value]) => values[key] !== value));
}
function reconcile(configPath, factorioDirectory, hostName, tokenFile, env = process.env) {
  const fresh = !fs.existsSync(configPath);
  const cli = nativeConfig(configPath);
  if (fresh) cli.create();
  try {
    const values = cli.read(); // Never replace an unreadable saved config with defaults.
    const writes = plan(values, { fresh, configPath, hostName, factorioDirectory, tokenFile, env });
    applyChanges(cli, writes);
  } catch (error) {
    // A file left behind here holds Clusterio's defaults (name "New Host", a relative
    // instances directory, controller on localhost). The next boot would take it for a
    // configured host and never write the fresh-host fields.
    if (fresh) {
      fs.rmSync(configPath, { force: true });
      // The messages end by saying the configuration was kept, which is not true of a first one.
      throw new Error(error.message.replace(/[.;][^.;]*configuration (was )?retained\.?$/i, "") + ". No configuration was written.");
    }
    throw error;
  }
  console.log(fresh ? "Host configured" : "Host configuration reconciled");
}
function applyChanges(cli, writes) {
  for (const [key, value] of writes) cli.write(key, value);
  const actual = cli.read();
  for (const [key, value] of writes) {
    if (actual[key] !== value)
      throw new Error("Native configuration did not accept " + key + "; startup stopped and configuration retained");
  }
}
function effectiveValues(values) {
  const id = values["host.id"], url = values["host.controller_url"];
  if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw new Error("Invalid effective host.id");
  if (typeof url !== "string" || /\s/.test(url) || !/^https?:\/\//.test(url) || !URL.canParse(url))
    throw new Error("Invalid effective host.controller_url");
  return { id, url };
}
function effective(configPath) {
  const { id, url } = effectiveValues(nativeConfig(configPath).read());
  return id + "\n" + url;
}
// Asks the controller whether it accepts the token this host is about to start with.
// Started with a token the controller rejects, a 2.1 host does not exit: it asks to join
// again and waits for someone to approve it, without rereading its token file.
//   accepted     200
//   rejected     401: revoked, issued by another controller, or its host was never created
//   unreachable  no answer, or an answer that is not the controller's (5xx/429 from a proxy
//                in front of a controller that is down): worth waiting for
//   unsupported  anything else; a controller older than 2.1 answers 404
// An invalid URL throws instead: waiting cannot fix it.
async function checkToken(values, request = fetch) {
  const { url } = effectiveValues(values);
  let response;
  try {
    response = await request(new URL("api/host-pairing/check", url),
      { headers: { Authorization: "Bearer " + values["host.controller_token"] }, signal: AbortSignal.timeout(10000) });
  } catch { return "unreachable"; }
  if (response.status >= 500 || response.status === 429) return "unreachable";
  return { 200: "accepted", 401: "rejected" }[response.status] ?? "unsupported";
}
const check = (configPath, request) => checkToken(nativeConfig(configPath).read(), request);
const checkExitCodes = { accepted: 0, rejected: 3, unreachable: 4, unsupported: 5 };
module.exports = { nativeConfig, hostNumber, plan, reconcile, applyChanges, effective, check, checkToken };
if (require.main === module) {
  try {
    const [mode, configPath, ...args] = process.argv.slice(2);
    if (mode === "reconcile" && args.length === 3) reconcile(configPath, ...args);
    else if (mode === "effective" && args.length === 0) console.log(effective(configPath));
    else if (mode === "check" && args.length === 0) {
      check(configPath).then(answer => { console.log(answer); process.exitCode = checkExitCodes[answer]; },
        error => { console.error(error.message); process.exitCode = 1; });
    } else throw new Error("Usage: configure-host.cjs reconcile CONFIG FACTORIO_DIR HOST_NAME TOKEN_FILE | effective CONFIG | check CONFIG");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
