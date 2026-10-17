#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * The MCP registry entry, checked against the package it points at.
 *
 * The registry publishes metadata, not an artifact: `server.json` names an npm
 * package, a version, and a namespace the registry verifies against that
 * package. A version that disagrees with `package.json`, or a `name` that
 * differs from the package's `mcpName`, is a listing that either cannot be
 * published or resolves to something the caller did not install.
 *
 * This checks the facts this repository owns. The authoritative schema check is
 * `mcp-publisher validate` (the registry's CLI) at publish time; it is not run
 * here because it needs a network download and the publish itself needs the
 * maintainer's authorization. `docs/releasing.md` records both.
 *
 * The 100-character description cap is the one schema constraint checked here,
 * because the description is a field this repository writes and the registry
 * rejects an over-long one at publication — after the release PR has merged.
 */

const failures = [];

const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(REPO_ROOT, relative), "utf8"));

const packageJson = await readJson("package.json");
const server = await readJson("server.json");

/** The schema the entry declares, which must be the registry's own. */
const SCHEMA_PREFIX = "https://static.modelcontextprotocol.io/schemas/";
/** The registry caps a server description at 100 characters. */
const MAX_DESCRIPTION = 100;

const fail = (message) => failures.push(message);
const agree = (label, actual, expected) => {
  if (actual !== expected) {
    fail(`${label} is ${JSON.stringify(actual)}, and it must be ${JSON.stringify(expected)}.`);
  }
};

if (typeof server["$schema"] !== "string" || !server["$schema"].startsWith(SCHEMA_PREFIX)) {
  fail(`server.json: $schema must name the registry's schema (${SCHEMA_PREFIX}…).`);
}

for (const field of ["name", "description", "version"]) {
  if (typeof server[field] !== "string" || server[field].length === 0) {
    fail(`server.json: ${field} is required and must be a non-empty string.`);
  }
}

if (typeof server["description"] === "string" && server["description"].length > MAX_DESCRIPTION) {
  fail(
    `server.json: description is ${String(server["description"].length)} characters; ` +
      `the registry schema caps it at ${String(MAX_DESCRIPTION)}.`,
  );
}

if (typeof server["name"] === "string") {
  if (!/^io\.github\.[^/]+\/[^/]+$/u.test(server["name"])) {
    fail("server.json: name must be an io.github.<owner>/<server> namespace.");
  }
  agree("server.json: name (must equal package.json#mcpName)", server["name"], packageJson.mcpName);
}

agree(
  "server.json: version (must equal package.json#version)",
  server["version"],
  packageJson.version,
);

if (!Array.isArray(server["packages"]) || server["packages"].length === 0) {
  fail("server.json: at least one package entry is required.");
} else {
  for (const [index, entry] of server["packages"].entries()) {
    const at = `server.json: packages[${String(index)}]`;
    if (typeof entry !== "object" || entry === null) {
      fail(`${at} must be an object.`);
      continue;
    }
    agree(`${at}.registryType`, entry["registryType"], "npm");
    agree(`${at}.identifier (must equal package.json#name)`, entry["identifier"], packageJson.name);
    agree(`${at}.version (must equal package.json#version)`, entry["version"], packageJson.version);
    agree(`${at}.runtimeHint`, entry["runtimeHint"], "npx");
    agree(`${at}.transport.type`, entry["transport"]?.["type"], "stdio");

    const args = Array.isArray(entry["packageArguments"]) ? entry["packageArguments"] : [];
    const hasMcp = args.some(
      (argument) =>
        typeof argument === "object" &&
        argument !== null &&
        argument["type"] === "positional" &&
        argument["value"] === "mcp",
    );
    if (!hasMcp) {
      fail(`${at}.packageArguments must include the positional "mcp" argument.`);
    }
  }
}

if (failures.length > 0) {
  console.error(`MCP registry entry: ${String(failures.length)} mismatch(es).\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nFix server.json (or the package facts it must agree with).");
  process.exit(1);
}

console.log(
  `MCP registry entry: ${server["name"]} ${server["version"]} agrees with ` +
    `${packageJson.name}@${packageJson.version} (${String(server["packages"].length)} package entry).`,
);
