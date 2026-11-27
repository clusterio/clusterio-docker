// Fixture for the acceptance runner's `npm-plugins` case (tests/consumer-smoke.mjs). It is
// served by tests/npm-registry.cjs and installed through CLUSTERIO_NPM_PLUGINS. The
// "clusterio-plugin" keyword, the peer ranges and the dependency in package.json are what the
// installer checks; the instance entrypoint is what the case imports.
export const plugin = {
	name: "ci_npm_fixture",
	title: "CI npm fixture",
	description: "Proves a plugin installed from an npm registry resolves and loads.",
	instanceEntrypoint: "instance.js",
};
