#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { emitGeneratedFile, finishCheck, repositoryPath } from "./lib/generated-file.mjs";
import { npmPurl } from "./lib/npmPurl.mjs";
import { loadProductionClosure } from "./lib/productionClosure.mjs";

/**
 * Write the bill of materials for what actually ships: `sbom.cdx.json`.
 *
 * CycloneDX 1.5, which is the version `npm sbom` emits and the version the
 * consumers that matter (GitHub's dependency graph, `cyclonedx-cli validate`,
 * Grype, Trivy) read.
 *
 * ## Why this is not `npm sbom`
 *
 * The tool exists and produces the right shape, and using it would be less code.
 * It was measured instead, on npm 11.19.0 with this repository's lockfile, and
 * three of the four answers are wrong for a released artifact:
 *
 *   - `--omit dev --package-lock-only` yields three components. `zod` is not
 *     among them, though `package.json` declares it, `zod` 4.4.3's lockfile entry
 *     carries no `dev` flag, and `node_modules/.package-lock.json` agrees. An
 *     artifact SBOM that omits a dependency a user installs is the one error this
 *     file could make that actively misleads.
 *   - Without `--omit dev` the same command describes ~300 packages, every dev
 *     tool included, which is a bill of materials for the build machine.
 *   - Reading `node_modules` describes this host's *stale* tree: it still lists
 *     `@modelcontextprotocol/client`, which `npm ls` itself reports as
 *     `extraneous` and which the lockfile no longer resolves.
 *
 * The fourth: an npm that has no `sbom` command — 9.2.0 at `/usr/bin/npm` here —
 * prints `Unknown command: "sbom"` **on stdout and exits 0**. A generator that
 * shelled out would have to parse the output to know a BOM was produced, so it
 * would already be reading the document rather than the status. Given that,
 * walking the same closure `lib/productionClosure.mjs` gives the licence file is
 * both smaller and checkable against that file.
 *
 * Generate mode therefore runs `npm sbom` anyway and prints how the two disagree.
 * That is a measurement taken where it can be taken, not a claim: the tool is
 * missing or its output unparseable on some hosts, and that is reported as
 * unread rather than as agreement.
 *
 * ## What makes the file reproducible
 *
 * `npm sbom` varies run to run in `serialNumber` and `metadata.timestamp`. A
 * committed generated file that differs from itself cannot be checked by
 * comparison, so both are handled rather than copied: `metadata.timestamp` is
 * omitted, and `serialNumber` is derived from the document's own content — RFC
 * 4122 §4.3 name-based, version 5, over the standard URL namespace — so the same
 * closure always mints the same UUID and a changed closure always mints a
 * different one. The lockfile's SHA-512 goes in `metadata.properties`, which is
 * what says *which* tree this file describes.
 *
 * ## Scope, and the line it does not cross
 *
 * The closure is production npm dependencies. libuvcpp is deliberately absent:
 * uvp does not bundle it, does not link it, and does not redistribute it — it
 * generates projects that link an installation the user supplies, which is the
 * subject of THIRD_PARTY_NOTICES.md rather than of this file.
 */

const OUTPUT = "sbom.cdx.json";
const SCHEMA = "http://cyclonedx.org/schema/bom-1.5.schema.json";

/** The RFC 4122 appendix C namespace for URLs; a constant, not a derived value. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: node scripts/sbom.mjs [--check]

Writes ${OUTPUT} (CycloneDX 1.5) for the production dependency closure.
--check  fail when the file on disk differs, without writing.`);
  process.exit(0);
}

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

/**
 * An SPDX identifier when the string is a bare token, a free-text name otherwise.
 *
 * A heuristic, and stated as one: this does not validate against the SPDX list,
 * so `Foo` is reported as the identifier `Foo`. The alternative — a table of
 * every identifier — would silently become an authority on which licences exist
 * and would misreport a new one. CycloneDX distinguishes the two cases, so the
 * wrong guess is a name where an id was available, never a wrong id.
 */
const SPDX_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u;
const licenseEntry = (license) =>
  SPDX_TOKEN.test(license) ? { license: { id: license } } : { license: { name: license } };

/**
 * RFC 4122 §4.3, version 5: SHA-1 over the namespace's bytes and the name.
 *
 * Version and variant bits are forced into the digest, which is what makes the
 * result a UUID rather than 16 arbitrary bytes.
 */
const nameBasedUuid = (namespace, name) => {
  const bytes = Buffer.from(
    createHash("sha1")
      .update(Buffer.from(namespace.replace(/-/gu, ""), "hex"))
      .update(name, "utf8")
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The SHA-512 a lockfile integrity string carries, or `undefined`. */
const integrityHash = (integrity) => {
  const match = /^sha512-(?<base64>[A-Za-z0-9+/=]+)$/u.exec(integrity ?? "");
  if (match === null) return undefined;
  return Buffer.from(match.groups.base64, "base64").toString("hex");
};

// ---------------------------------------------------------------- the document

const manifest = JSON.parse(await readFile(repositoryPath("package.json"), "utf8"));

if (typeof manifest.name !== "string" || manifest.name === "") {
  fail("package.json has no `name`, so the root component of the bill of materials has no name.");
}
if (typeof manifest.version !== "string" || manifest.version === "") {
  fail("package.json has no `version`, so nothing in the bill of materials can be referenced.");
}

let closure;
try {
  closure = await loadProductionClosure();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const { entries, unresolved, optionalHolders, lockfileVersion, lockfileSha512 } = closure;

if (unresolved.length > 0) {
  fail(
    `Could not resolve ${unresolved.length} package(s): ${unresolved.join(", ")}\n` +
      "The lockfile and the dependency graph disagree; run `npm install` and retry.",
  );
}

const versionless = entries.filter((entry) => entry.version === null);
if (versionless.length > 0) {
  // A component with no version cannot be referenced by a dependency edge, so
  // this is not a note: the graph would be wrong, not merely thin.
  fail(
    `The lockfile records no version for ${versionless.map((entry) => entry.name).join(", ")}, ` +
      "so no bom-ref can be built for them.",
  );
}

const ref = (entry) => `${entry.name}@${entry.version}`;
const byLocation = new Map(entries.map((entry) => [entry.location, entry]));

const externalReferences = (url) => (url === null ? [] : [{ type: "distribution", url }]);

const components = entries.map((entry) => {
  const hash = integrityHash(entry.integrity);
  return {
    "bom-ref": ref(entry),
    type: "library",
    name: entry.name,
    version: entry.version,
    scope: entry.optional ? "optional" : "required",
    purl: npmPurl(entry.name, entry.version),
    properties: [],
    externalReferences: externalReferences(entry.resolved),
    ...(hash === undefined ? {} : { hashes: [{ alg: "SHA-512", content: hash }] }),
    ...(entry.license === null ? {} : { licenses: [licenseEntry(entry.license)] }),
  };
});

const rootReference = `${manifest.name}@${manifest.version}`;
const rootComponent = {
  "bom-ref": rootReference,
  type: "library",
  name: manifest.name,
  version: manifest.version,
  scope: "required",
  ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
  purl: npmPurl(manifest.name, manifest.version),
  properties: [],
  externalReferences: [
    ...(typeof manifest.repository?.url === "string"
      ? [{ type: "vcs", url: manifest.repository.url }]
      : []),
    ...(typeof manifest.homepage === "string" ? [{ type: "website", url: manifest.homepage }] : []),
    ...(typeof manifest.bugs?.url === "string"
      ? [{ type: "issue-tracker", url: manifest.bugs.url }]
      : []),
  ],
  ...(typeof manifest.license === "string" ? { licenses: [licenseEntry(manifest.license)] } : {}),
};

const properties = [
  { name: "uvp:source", value: "package-lock.json" },
  { name: "uvp:lockfile-version", value: String(lockfileVersion) },
  { name: "uvp:lockfile-sha512", value: lockfileSha512 },
  { name: "uvp:closure", value: "production" },
];

if (optionalHolders.length > 0) {
  properties.push({
    name: "uvp:optional-dependencies-not-followed",
    value: optionalHolders.join(", "),
  });
}

/** Everything but `serialNumber`, which is derived from exactly this. */
const document = {
  $schema: SCHEMA,
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    // No `timestamp`: a value that changes on every run makes the file
    // uncheckable by comparison, and it says when the file was written, which is
    // not a fact about the artifact.
    lifecycles: [{ phase: "pre-build" }],
    tools: [{ vendor: "uvp", name: "scripts/sbom.mjs", version: manifest.version }],
    component: rootComponent,
    properties,
  },
  components,
  dependencies: [
    {
      ref: rootReference,
      dependsOn: entries
        .filter((entry) => entry.direct)
        .map(ref)
        .sort(),
    },
    ...entries.map((entry) => ({
      ref: ref(entry),
      dependsOn: entry.dependencies
        .map((location) => byLocation.get(location))
        .filter((resolved) => resolved !== undefined)
        .map(ref)
        .sort(),
    })),
  ],
};

const contents = `${JSON.stringify(
  {
    ...document,
    serialNumber: `urn:uuid:${nameBasedUuid(NAMESPACE_URL, JSON.stringify(document))}`,
  },
  null,
  2,
)}\n`;

// ------------------------------------------------------- the rules, self-tested

/**
 * Run the extractors against inputs whose answers are known before anything is
 * concluded. A rule that has stopped seeing what it is written to see reads
 * exactly like a rule that found nothing wrong, and this file's failure mode is
 * a document that parses and is wrong.
 */
const selfChecks = [
  ["purl, scoped", npmPurl("@scope/name", "1.2.3"), "pkg:npm/%40scope/name@1.2.3"],
  ["purl, unscoped", npmPurl("name", "1.2.3"), "pkg:npm/name@1.2.3"],
  ["spdx id", JSON.stringify(licenseEntry("Apache-2.0")), '{"license":{"id":"Apache-2.0"}}'],
  [
    "spdx name",
    JSON.stringify(licenseEntry("SEE LICENSE IN LICENSE")),
    '{"license":{"name":"SEE LICENSE IN LICENSE"}}',
  ],
  [
    "integrity, sha512",
    integrityHash(`sha512-${Buffer.from("uvp").toString("base64")}`),
    Buffer.from("uvp").toString("hex"),
  ],
  ["integrity, not sha512", String(integrityHash("sha1-abc")), "undefined"],
  ["integrity, absent", String(integrityHash(null)), "undefined"],
  ["uuid, version nibble", nameBasedUuid(NAMESPACE_URL, "uvp")[14], "5"],
  ["uuid, variant nibble", "89ab".includes(nameBasedUuid(NAMESPACE_URL, "uvp")[19]), "true"],
  ["uuid, stable", nameBasedUuid(NAMESPACE_URL, "uvp"), nameBasedUuid(NAMESPACE_URL, "uvp")],
  [
    "uuid, content-sensitive",
    String(nameBasedUuid(NAMESPACE_URL, "uvp") !== nameBasedUuid(NAMESPACE_URL, "uvq")),
    "true",
  ],
];

const brokenRules = selfChecks.filter(([, actual, expected]) => String(actual) !== expected);
if (brokenRules.length > 0) {
  console.error("The rules this generator applies are not behaving as measured:");
  for (const [label, actual, expected] of brokenRules) {
    console.error(
      `  ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  console.error("Writing the bill of materials anyway would produce a document nobody can trust.");
  process.exit(2);
}

// ------------------------------------------------- the document's own invariants

/**
 * The properties a consumer relies on, asserted here rather than assumed.
 *
 * This is **not** schema validation. The document was validated against the
 * published CycloneDX 1.5 schema with `ajv-cli` in draft-07 mode, and it passed;
 * that ran once, by hand, with the three schema files fetched from
 * `cyclonedx.org`, because a validator is not a dependency of this repository and
 * the check would need the network. So a green gate says the document still has
 * the shape it was validated with, not that it is still schema-valid.
 *
 * What it does say is that the four rules a code change is most likely to break
 * still hold: the version fields a consumer switches on, a unique `bom-ref` per
 * component, a `type` and `name` on each, and a dependency graph whose every
 * reference names something the document defines. A dangling `dependsOn` is the
 * failure this catches — it parses, validates nothing, and turns a real
 * dependency into an invisible one.
 */
const structuralFailures = [];
{
  // Read the document that is about to be written, not the arrays it was built
  // from. The first version of this block set `document.components` from these
  // and then checked `components`, so a mutation that dropped a component from
  // the document passed — a guard that reads a different value than the one it
  // guards. The mutation probe is what found it.
  const written = document.components;
  const refs = new Set([rootComponent["bom-ref"], ...written.map((entry) => entry["bom-ref"])]);
  if (refs.size !== written.length + 1) {
    structuralFailures.push("two components share a bom-ref");
  }
  if (document.bomFormat !== "CycloneDX") structuralFailures.push("bomFormat is not CycloneDX");
  if (document.specVersion !== "1.5") {
    structuralFailures.push(`specVersion is ${document.specVersion}, not the 1.5 this file claims`);
  }
  if (!Number.isInteger(document.version) || document.version < 1) {
    structuralFailures.push("the document has no integer version");
  }
  for (const component of [document.metadata.component, ...written]) {
    if (typeof component.type !== "string" || typeof component.name !== "string") {
      structuralFailures.push(`a component has no type or name: ${JSON.stringify(component)}`);
    }
  }
  for (const dependency of document.dependencies) {
    if (!refs.has(dependency.ref)) {
      structuralFailures.push(
        `a dependency edge refs ${dependency.ref}, which no component defines`,
      );
    }
    for (const target of dependency.dependsOn) {
      if (!refs.has(target)) {
        structuralFailures.push(
          `${dependency.ref} depends on ${target}, which no component defines`,
        );
      }
      if (target === dependency.ref) {
        structuralFailures.push(`${dependency.ref} depends on itself`);
      }
    }
  }
  // Every component is reachable: a component no edge names is either a walk
  // that found something the graph does not admit to, or the root.
  const reachable = new Set(document.dependencies.flatMap((edge) => edge.dependsOn));
  for (const component of written) {
    if (!reachable.has(component["bom-ref"])) {
      structuralFailures.push(`${component["bom-ref"]} is listed but nothing depends on it`);
    }
  }
  if (written.length === 0) {
    // The closure is never empty for a package with dependencies, and an empty
    // component list is what a walk that silently resolved nothing produces.
    structuralFailures.push("the document lists no components at all");
  }
}

if (structuralFailures.length > 0) {
  console.error("The bill of materials is not shaped the way this generator says it is:");
  for (const failure of structuralFailures) console.error(`  ${failure}`);
  process.exit(2);
}

// ------------------------------------------------------------------- the write

const missingFacts = [];
if (entries.some((entry) => integrityHash(entry.integrity) === undefined)) {
  missingFacts.push(
    `no SHA-512 in the lockfile for ${entries
      .filter((entry) => integrityHash(entry.integrity) === undefined)
      .map((entry) => entry.name)
      .join(", ")}`,
  );
}
if (entries.some((entry) => entry.license === null)) {
  missingFacts.push(
    `no licence in the lockfile for ${entries
      .filter((entry) => entry.license === null)
      .map((entry) => entry.name)
      .join(", ")}`,
  );
}

const result = await emitGeneratedFile({ relative: OUTPUT, contents, check: values.check });

if (values.check) {
  process.exit(finishCheck([result], { label: "bill of materials" }));
}

console.log(
  `wrote ${OUTPUT} (${components.length} component(s), ${entries.filter((entry) => entry.direct).length} direct)`,
);

// Said rather than omitted: a component without hashes or a licence is a fact
// this generator could not read, which is not the same as a package that has
// neither.
for (const fact of missingFacts) console.warn(`warning: ${fact}`);

if (optionalHolders.length > 0) {
  console.warn(
    `warning: ${optionalHolders.length} package(s) declare platform-conditional optional dependencies, ` +
      `which this closure does not follow: ${optionalHolders.join(", ")}`,
  );
}

// -------------------------------------------------- the tool, asked and compared

/**
 * Ask `npm sbom` the same question and say where the answers differ.
 *
 * Never fatal and never silent. The tool may not exist, may not support
 * `--sbom-format`, or may print a message instead of a document while exiting 0,
 * so the output is parsed before it is believed — the exit status is not evidence
 * that a bill of materials was produced.
 */
const compareAgainstNpm = () => {
  let stdout;
  try {
    stdout = execFileSync(
      "npm",
      ["sbom", "--sbom-format", "cyclonedx", "--omit", "dev", "--package-lock-only"],
      { cwd: repositoryPath("."), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    console.log(
      `       npm sbom could not be run here (${error instanceof Error ? error.message.split("\n")[0] : String(error)}), ` +
        "so this run says nothing about how the two compare.",
    );
    return;
  }

  let theirs;
  try {
    theirs = JSON.parse(stdout);
  } catch {
    console.log(
      "       npm sbom printed something that is not a CycloneDX document; not compared.",
    );
    return;
  }
  if (theirs.bomFormat !== "CycloneDX" || !Array.isArray(theirs.components)) {
    console.log("       npm sbom printed no components; not compared.");
    return;
  }

  const ours = new Set(components.map((component) => component["bom-ref"]));
  const names = (list) =>
    new Set(list.map((component) => `${component.name}@${component.version}`));
  const theirsNames = names(theirs.components);
  const onlyHere = [...ours].filter((name) => !theirsNames.has(name)).sort();
  const onlyThere = [...theirsNames].filter((name) => !ours.has(name)).sort();

  if (onlyHere.length === 0 && onlyThere.length === 0) {
    console.log(`       npm sbom agrees on all ${ours.size} component(s).`);
    return;
  }
  console.log(
    `       npm sbom disagrees: ${theirs.components.length} component(s) there against ${components.length} here.`,
  );
  if (onlyHere.length > 0) console.log(`         shipped but absent there: ${onlyHere.join(", ")}`);
  if (onlyThere.length > 0)
    console.log(`         listed there but not shipped: ${onlyThere.join(", ")}`);
};

compareAgainstNpm();
