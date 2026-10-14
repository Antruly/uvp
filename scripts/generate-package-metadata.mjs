#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { BANNER, emitGeneratedFile, finishCheck, repositoryPath } from "./lib/generated-file.mjs";

/**
 * Generate `src/generatedPackageMetadata.ts` from the manifests that already
 * carry the same facts.
 *
 * The point is not the typing. It is that the version, the package name, and the
 * MCP server name appear in four files — `package.json`, `server.json`, the
 * registry entry, and whatever the code needs at runtime — and a release tool has
 * to update all of them. Generating the TypeScript one removes the only copy that
 * a human could forget, and the CI check removes the failure mode where someone
 * remembers but forgets to commit.
 *
 * release-please rewrites the annotated line in the output. The annotation is
 * part of the generated text, so regenerating does not remove it.
 */

const OUTPUT = "src/generatedPackageMetadata.ts";

const ANNOTATION = "x-release-please-version";

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: node scripts/generate-package-metadata.mjs [--check]

Writes ${OUTPUT} from package.json and server.json.
--check  fail when the file on disk differs, without writing.`);
  process.exit(0);
}

const packageJson = JSON.parse(await readFile(repositoryPath("package.json"), "utf8"));
const serverJson = JSON.parse(await readFile(repositoryPath("server.json"), "utf8"));

/**
 * The two manifests disagreeing about the version is a release that will publish
 * one version and advertise another, so it fails here rather than downstream.
 */
const registryVersion = serverJson.packages?.[0]?.version;
if (registryVersion !== packageJson.version) {
  console.error(
    `server.json advertises ${registryVersion} but package.json is ${packageJson.version}.`,
  );
  console.error("Both are updated by release-please; a mismatch means one was edited by hand.");
  process.exit(2);
}

const identifier = serverJson.packages?.[0]?.identifier;
if (identifier !== packageJson.name) {
  console.error(`server.json points at npm package ${identifier}, not ${packageJson.name}.`);
  process.exit(2);
}

const contents = `${BANNER}

/**
 * Facts about this build that other layers need at runtime.
 *
 * Everything here is copied from a manifest that is the real source of that
 * fact. Nothing is authored here, and nothing here should be edited by hand —
 * \`npm run metadata:check\` regenerates this file and fails on a difference.
 */

/** The npm package name. */
export const PACKAGE_NAME = ${JSON.stringify(packageJson.name)};

/** The version being run. Kept on one line for the release tooling. */
export const PACKAGE_VERSION = ${JSON.stringify(packageJson.version)}; // ${ANNOTATION}

/** The MCP registry name. Not the npm name; the two are deliberately different. */
export const MCP_SERVER_NAME = ${JSON.stringify(serverJson.name)};

/** The MCP registry entry's human-readable title. */
export const MCP_SERVER_TITLE = ${JSON.stringify(serverJson.title)};

/** One-line description, shared by the CLI banner and the MCP server metadata. */
export const PACKAGE_DESCRIPTION = ${JSON.stringify(packageJson.description)};
`;

const result = await emitGeneratedFile({
  relative: OUTPUT,
  contents,
  check: values.check,
});

if (values.check) {
  process.exit(finishCheck([result], { label: "package metadata" }));
}

console.log(`wrote ${OUTPUT} (${packageJson.name} ${packageJson.version})`);
