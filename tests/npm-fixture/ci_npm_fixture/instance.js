// Both imports have to resolve from /clusterio/node_modules: the image's own @clusterio/host,
// and the dependency npm installed beside this package.
import { BaseInstancePlugin } from "@clusterio/host";
import { marker } from "ci_npm_fixture_dep";

if (typeof BaseInstancePlugin !== "function") {
	throw new Error("@clusterio/host did not export BaseInstancePlugin");
}
if (marker !== "ci_npm_fixture_dep") {
	throw new Error("ci_npm_fixture_dep did not resolve to the fixture dependency");
}

export default async function(context) {
	context.logger.info("ci_npm_fixture instance plugin loaded");
}
