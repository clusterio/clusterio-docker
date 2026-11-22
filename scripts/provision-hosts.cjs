// Issues the host tokens on the shared tokens volume (Clusterio 2.1+).
//
// Clusterio 2.1 removed `bootstrap generate-host-token`: a host now exists only once it has
// been approved, and the controller picks its id. This asks the running controller to create
// each expected host through the host pairing endpoint, authenticated as the admin user
// (docs/devs/protocol.md "Host pairing" upstream), and writes the token it answers with to
// clusterio-host-N.token, which is where the host entrypoint has always looked.
//
// Runs on every controller start and only fills gaps: a token the controller still accepts
// is left alone, so hosts keep their id. Usage: provision-hosts.cjs CONTROL_CONFIG TOKENS_DIR COUNT
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

async function provision({ count, readToken, writeToken, check, pair, revoke, listHosts, log }) {
  const result = { kept: [], issued: [], skipped: [], failed: [] };
  let hosts; // Looked up once, and only when a token has to be issued.
  for (let number = 1; number <= count; number++) {
    const name = "clusterio-host-" + number;
    try {
      const saved = readToken(name);
      if (saved !== undefined && await check(saved)) { result.kept.push(name); continue; }
      hosts ??= await listHosts();
      // Host names are not unique: issuing a token for a name that is taken would add a
      // second host beside the first, with the instances still assigned to the first.
      const taken = hosts.find(host => host.name === name);
      if (taken) {
        result.skipped.push(name);
        log("  WARNING: " + name + " is registered (host id " + taken.id + ") but " + (saved === undefined
          ? "its token file is missing" : "the controller rejects its token file") + "; not issuing a second "
          + "host under that name. A host that still holds its token keeps working. To issue a new token, run "
          + "`clusterioctl host revoke " + name + "` (this unassigns its instances) and restart the controller.");
        continue;
      }
      const issued = await pair(name);
      try { writeToken(name, issued.token); }
      catch (error) {
        // A host without its token file blocks its own name: the next start would find the
        // name registered and issue nothing. Take the host back out.
        await revoke(issued.hostId).catch(() => log("  WARNING: could not remove host id " + issued.hostId
          + " again; revoke it before the next controller start (`clusterioctl host revoke " + issued.hostId + "`)"));
        throw error;
      }
      hosts.push({ name, id: issued.hostId });
      result.issued.push(name);
      log("  Token issued: " + name + ".token (host id " + issued.hostId + ")"
        + (saved === undefined ? "" : ", replacing one the controller no longer accepts"));
    } catch (error) {
      result.failed.push(name);
      log("  ERROR: no token for " + name + ": " + error.message);
    }
  }
  if (result.kept.length) log("  Token(s) still valid: " + result.kept.join(", "));
  return result;
}

function controllerClient(controlConfig) {
  const config = JSON.parse(fs.readFileSync(controlConfig, "utf8"));
  const url = config["ctl.controller_url"], adminToken = config["ctl.controller_token"];
  if (typeof url !== "string" || typeof adminToken !== "string") throw new Error("No controller URL and token in " + controlConfig);
  const ctl = (...args) => execFileSync("/clusterio/node_modules/.bin/clusterioctl",
    ["--log-level", "error", "--config", controlConfig, ...args],
    { encoding: "utf8", timeout: 25000, stdio: ["ignore", "pipe", "ignore"] });
  // Never report a response body or a thrown fetch error verbatim: either may carry a token.
  const request = async (route, options) => {
    try { return await fetch(new URL(route, url), { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error("the controller did not answer " + route); }
  };
  return {
    async check(token) {
      const response = await request("api/host-pairing/check", { headers: { Authorization: "Bearer " + token } });
      if (response.status === 200) return true;
      if (response.status === 401) return false;
      throw new Error("unexpected status " + response.status + " checking the saved token");
    },
    async pair(name) {
      const response = await request("api/host-pairing", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
        body: JSON.stringify({ name }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 404) throw new Error("this controller has no host pairing endpoint (Clusterio older than 2.1)");
      if (response.status !== 200 || !Number.isInteger(body.hostId) || typeof body.token !== "string")
        throw new Error("the controller refused to create the host (status " + response.status
          + (typeof body.error === "string" ? ", " + body.error : "") + ")");
      return { hostId: body.hostId, token: body.token };
    },
    async listHosts() {
      try { return JSON.parse(ctl("host", "list", "--output", "json")); }
      catch { throw new Error("could not list the registered hosts"); }
    },
    async revoke(hostId) { ctl("host", "revoke", String(hostId)); },
  };
}
function tokenFiles(tokensDir) {
  const file = name => path.join(tokensDir, name + ".token");
  return {
    readToken(name) {
      try { return fs.readFileSync(file(name), "utf8").trim() || undefined; }
      catch (error) { if (error.code === "ENOENT") return undefined; throw new Error("cannot read " + file(name)); }
    },
    // Atomic (tmp + rename): a host may be reading the file over the shared volume.
    writeToken(name, token) {
      try {
        fs.writeFileSync(file(name) + ".tmp", token + "\n", { mode: 0o600 });
        fs.renameSync(file(name) + ".tmp", file(name));
      } catch { throw new Error("cannot write " + file(name)); }
    },
  };
}
module.exports = { provision, tokenFiles };
if (require.main === module) {
  (async () => {
    const [controlConfig, tokensDir, countText] = process.argv.slice(2);
    const count = Number(countText);
    if (!controlConfig || !tokensDir || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Usage: provision-hosts.cjs CONTROL_CONFIG TOKENS_DIR COUNT");
    const result = await provision({ count, ...tokenFiles(tokensDir), ...controllerClient(controlConfig), log: console.log });
    if (result.failed.length) process.exitCode = 1;
  })().catch(error => { console.error("ERROR: " + error.message); process.exitCode = 1; });
}
