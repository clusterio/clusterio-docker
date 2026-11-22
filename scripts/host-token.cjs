// Host identity comes from the host token. Since Clusterio 2.1 the controller assigns host
// ids, and the id a token was issued for is its `host` claim (`slave` before alpha 14).
// The signature is not checked here: only the controller can do that.
//   id FILE   print the host id the token in FILE was issued for
"use strict";
const fs = require("node:fs");

function tokenHostId(token) {
  const parts = typeof token === "string" ? token.trim().split(".") : [];
  let id;
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    id = claims.host ?? claims.slave;
  } catch { /* reported below */ }
  if (parts.length !== 3 || !Number.isSafeInteger(id) || id < 0 || id > 2147483647)
    throw new Error("Host token does not name a host id");
  return id;
}
module.exports = { tokenHostId };
if (require.main === module) {
  try {
    const [mode, file] = process.argv.slice(2);
    if (mode !== "id" || !file) throw new Error("Usage: host-token.cjs id FILE");
    console.log(tokenHostId(fs.readFileSync(file, "utf8")));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
