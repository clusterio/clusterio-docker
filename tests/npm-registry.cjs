// A read-only npm registry for the acceptance runner's `npm-plugins` case. It packs every
// package directory under the directory it is given and serves those packages and nothing
// else, so the case installs from a registry the run owns. Runs inside a host image
// container (node and npm are there). Each request is logged as `METHOD /path STATUS`; the
// runner reads that log to see what npm asked for.
//
// npm also asks the registry about every @clusterio/* package a plugin names as a peer,
// although the image already holds it. Those are answered from <installed root>: the
// installed package.json with the integrity its package-lock.json records, and a tarball
// address this server does not serve. A request for such a tarball would mean npm set out
// to replace a package of the image; it is answered 404 and shows in the log.
// Usage: node npm-registry.cjs <packages directory> <installed root> [port]
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const [source, installed, port = "4873"] = process.argv.slice(2);
const packed = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
const packages = new Map(), tarballs = new Map();
for (const entry of fs.readdirSync(source)) {
  const directory = path.join(source, entry);
  if (!fs.existsSync(path.join(directory, "package.json"))) continue;
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packed],
    { cwd: directory, encoding: "utf8" }));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const data = fs.readFileSync(path.join(packed, filename));
  packages.set(manifest.name, { manifest, filename, data });
  tarballs.set(manifest.name + "/-/" + filename, data);
}

const scope = path.join(installed, "node_modules", "@clusterio");
const locked = JSON.parse(fs.readFileSync(path.join(installed, "package-lock.json"), "utf8")).packages;
for (const entry of fs.readdirSync(scope)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(scope, entry, "package.json"), "utf8"));
  const lock = locked["node_modules/" + manifest.name];
  if (!lock) throw new Error(path.join(installed, "package-lock.json") + " has no entry for " + manifest.name);
  const { integrity } = lock;
  packages.set(manifest.name, { manifest, filename: entry + "-" + manifest.version + ".tgz", integrity });
}

const hash = (algorithm, data, encoding) => crypto.createHash(algorithm).update(data).digest(encoding);
function packument({ manifest, filename, data, integrity }, origin) {
  return {
    name: manifest.name,
    "dist-tags": { latest: manifest.version },
    versions: { [manifest.version]: { ...manifest, dist: {
      tarball: origin + "/" + manifest.name + "/-/" + filename,
      ...(data ? { shasum: hash("sha1", data, "hex"), integrity: "sha512-" + hash("sha512", data, "base64") } : { integrity }),
    } } },
  };
}

http.createServer((request, response) => {
  const route = decodeURIComponent(request.url.split("?")[0]).replace(/^\/+/, "");
  let status = 404, type = "application/json", body = JSON.stringify({ error: "not found" });
  if (request.method === "GET" && packages.has(route)) {
    status = 200; body = JSON.stringify(packument(packages.get(route), "http://" + request.headers.host));
  } else if (request.method === "GET" && tarballs.has(route)) {
    status = 200; type = "application/octet-stream"; body = tarballs.get(route);
  }
  console.log(request.method + " /" + route + " " + status);
  response.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}).listen(Number(port), () => console.log("registry ready: " + [...tarballs.keys()].map(file => file.split("/-/")[0]).sort().join(", ")));
