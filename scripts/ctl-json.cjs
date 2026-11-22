// Answers the entrypoints' questions about `clusterioctl --output json` results (Clusterio
// 2.1.1+), read from stdin. Neither image has jq. Exit 0 with the answer on stdout, 1 when
// the answer is "no" or "not found", 2 when stdin is not the expected JSON.
//   connected-hosts                 host list      -> number of connected hosts
//   host-connected ID               host list      -> exit 0 if that host is connected
//   resolve-host NAME [ID] [N]      host list      -> id of the host a seed folder names
//   instance NAME FIELD             instance list  -> a field of the instance, "" if unset
//   instances-before HOST_ID MS     instance list  -> running instances started before MS
//   mod-pack-id NAME                mod-pack list  -> id of the pack with exactly that name
//   export-asset KEY                mod-pack show  -> file name of that asset in the export manifest
//   field KEY                       config list, or any object -> its value for KEY
"use strict";

const text = value => typeof value === "string" ? value : JSON.stringify(value);
const queries = {
  "connected-hosts": hosts => hosts.filter(h => h.connected).length,
  "host-connected": (hosts, id) => hosts.some(h => String(h.id) === id && h.connected) ? "" : undefined,
  // Host names are not unique in Clusterio 2.1, so a name alone is not an address. Prefer the
  // id the host's token file was issued for, then a name only one host has, then the pre-2.1
  // convention that clusterio-host-N has id N.
  "resolve-host": (hosts, name, tokenId, number) => {
    if (tokenId && hosts.some(h => String(h.id) === tokenId)) return tokenId;
    const named = hosts.filter(h => h.name === name);
    if (named.length === 1) return named[0].id;
    if (number && hosts.some(h => String(h.id) === number)) return number;
    return undefined;
  },
  "instance": (instances, name, field) => {
    const instance = instances.find(i => i.name === name);
    return instance && (instance[field] ?? "");
  },
  "instances-before": (instances, hostId, ms) => instances
    .filter(i => String(i.assignedHost) === hostId && ["running", "starting"].includes(i.status)
      && i.startedAtMs > 0 && i.startedAtMs < Number(ms))
    .map(i => i.name).join("\n"),
  "mod-pack-id": (packs, name) => packs.find(p => p.name === name)?.id,
  "export-asset": (pack, key) => pack.exportManifest?.assets?.[key],
  "field": (object, key) => Array.isArray(object) ? undefined : object[key] ?? undefined,
};
function answer(query, data, args) {
  if (!Object.hasOwn(queries, query)) throw new Error("Unknown query " + query);
  if (data === null || typeof data !== "object") throw new Error("Expected a JSON object or array");
  const takesObject = ["field", "export-asset"].includes(query);
  if (Array.isArray(data) === takesObject && query !== "field") throw new Error("Expected a JSON " + (takesObject ? "object" : "array"));
  return queries[query](data, ...args);
}
module.exports = { answer };
if (require.main === module) {
  const [query, ...args] = process.argv.slice(2);
  let input = "";
  process.stdin.setEncoding("utf8").on("data", chunk => { input += chunk; }).on("end", () => {
    try {
      const result = answer(query, JSON.parse(input), args);
      if (result === undefined) process.exitCode = 1;
      else if (text(result) !== "") console.log(text(result));
    } catch (error) { console.error("ctl-json: " + error.message); process.exitCode = 2; }
  });
}
