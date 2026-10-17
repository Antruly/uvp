#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { repositoryPath } from "./lib/generated-file.mjs";

/**
 * Fail when the files that carry the release version disagree, or when the tag
 * being published names a different version than the tree declares.
 *
 * A publish is the one operation that cannot be undone: an npm version is
 * immutable, and the tarball's version is a fact about the tarball. So the check
 * has to establish, before the upload, that one version is the answer everywhere
 * it is written — not that each file is individually plausible.
 *
 * What is already covered elsewhere, and therefore not repeated here:
 *
 *   - `package.json` ↔ `server.json packages[0].version` and the package
 *     identifier: `npm run metadata:check`.
 *   - `package.json` ↔ every version in `sbom.cdx.json`: `npm run sbom:check`.
 *   - The generated `PACKAGE_VERSION`: `npm run metadata:check`.
 *
 * What is not covered anywhere else is the rest of the release record: the
 * top-level `server.json` version, the release-please manifest, the two compound
 * strings in the SBOM that a JSON-path rewrite cannot touch, and — only at
 * publish time — the tag itself. This script exists for those, and it re-states
 * the covered ones on the same pass so that a publish is decided by one command
 * whose whole input is the tagged tree.
 *
 * Exit status: 0 when everything agrees; 1 when something disagrees (the message
 * names the file and both values); 2 when a file could not be read or parsed, so
 * the answer is "could not check" rather than a verdict.
 */

/** The tag release-please creates: no `v` prefix (`include-v-in-tag: false`). */
const TAG_PATTERN =
  /^uvp-agents-(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;

/**
 * The version, and the name, exactly as `package.json` declares them.
 *
 * `name` is here because the SBOM's compound references carry it: an SBOM for a
 * package that was renamed would otherwise agree about the version and point at
 * a component nobody can install.
 */
const referenceOf = ({ name, version }) => ({
  version,
  bomRef: `${name}@${version}`,
  purl: `pkg:npm/${name}@${version}`,
});

/**
 * Every place the release version is written, compared against `package.json`.
 *
 * The labels are the messages: a failure says which file disagreed, in the
 * reader's terms, rather than which object property was read.
 */
export const evaluateReleaseVersion = ({ name, version, sources, tag }) => {
  const failures = [];
  if (typeof name !== "string" || typeof version !== "string" || version === "") {
    return {
      version,
      failures: [
        "`package.json` has no usable `name` and `version`, so there is nothing to compare.",
      ],
    };
  }

  for (const [label, actual, wanted] of sources) {
    if (actual !== wanted) {
      failures.push(
        `${label} is ${JSON.stringify(actual)}, but package.json is ${JSON.stringify(wanted)}.`,
      );
    }
  }

  if (tag !== undefined) {
    const match = TAG_PATTERN.exec(tag);
    if (match === null) {
      failures.push(
        `The tag ${JSON.stringify(tag)} is not of the form uvp-agents-<version>. ` +
          "release-please creates tags without a `v` prefix (`include-v-in-tag: false`).",
      );
    } else if (match.groups?.version !== version) {
      failures.push(
        `The tag ${JSON.stringify(tag)} names version ${JSON.stringify(match.groups?.version)}, ` +
          `but package.json is ${JSON.stringify(version)}. The tag and the tree have to agree before anything is published.`,
      );
    }
  }

  return { version, failures };
};

/**
 * The rule, against values rather than against the repository.
 *
 * Run on every invocation, for the reason `verify-actions.mjs` gives: the failure
 * mode of a check like this is not being wrong on the day it was written; it is
 * a rule that stops matching after an edit and a run that then finds nothing to
 * complain about.
 */
const sourcesFor = (version, overrides = {}) => {
  const wanted = referenceOf({ name: "uvp-agents", version });
  const expected = {
    "`server.json` version": version,
    "`server.json` packages[0].version": version,
    "`.release-please-manifest.json`": version,
    "`sbom.cdx.json` component version": version,
    "`sbom.cdx.json` bom-ref": wanted.bomRef,
    "`sbom.cdx.json` purl": wanted.purl,
    "`sbom.cdx.json` tool version": version,
  };
  // An override changes what the file says, never what it should say — a case
  // that moved both would pass for the wrong reason.
  return Object.entries(expected).map(([label, value]) => [
    label,
    overrides[label] ?? value,
    value,
  ]);
};

const SELF_CHECK_CASES = [
  {
    describe: "every source agrees and the tag names the same version",
    version: "0.2.0",
    tag: "uvp-agents-0.2.0",
    failures: 0,
  },
  {
    describe: "the tag names another version",
    version: "0.2.0",
    tag: "uvp-agents-0.1.0",
    failures: 1,
  },
  { describe: "the tag carries a v prefix", version: "0.2.0", tag: "v0.2.0", failures: 1 },
  { describe: "no tag at all", version: "0.2.0", tag: undefined, failures: 0 },
  {
    describe: "server.json's top-level version lags",
    version: "0.2.0",
    tag: undefined,
    failures: 1,
    overrides: { "`server.json` version": "0.1.0" },
  },
  {
    describe: "the release-please manifest lags",
    version: "0.2.0",
    tag: undefined,
    failures: 1,
    overrides: { "`.release-please-manifest.json`": "0.1.0" },
  },
  {
    describe: "the SBOM's bom-ref still names the old version",
    version: "0.2.0",
    tag: undefined,
    failures: 1,
    overrides: { "`sbom.cdx.json` bom-ref": "uvp-agents@0.1.0" },
  },
  {
    describe: "a pre-release tag is a version, not an error",
    version: "0.2.0-rc.1",
    tag: "uvp-agents-0.2.0-rc.1",
    failures: 0,
  },
];

const selfCheck = () => {
  const wrong = [];
  for (const testCase of SELF_CHECK_CASES) {
    const { failures } = evaluateReleaseVersion({
      name: "uvp-agents",
      version: testCase.version,
      sources: sourcesFor(testCase.version, testCase.overrides),
      tag: testCase.tag,
    });
    if (failures.length !== testCase.failures) {
      wrong.push(
        `  ${testCase.describe}: expected ${String(testCase.failures)} failure(s), got ${String(failures.length)}` +
          (failures.length === 0 ? "" : `\n    ${failures.join("\n    ")}`),
      );
    }
  }
  if (wrong.length > 0) {
    console.error(
      "verify-release-version: the rule no longer decides these cases as this file says:",
    );
    console.error(wrong.join("\n"));
    process.exit(1);
  }
};

const readJson = async (relative) => {
  let text;
  try {
    text = await readFile(repositoryPath(relative), "utf8");
  } catch (error) {
    console.error(
      `verify-release-version: could not read ${relative} (${error.code ?? error.message}).`,
    );
    console.error(
      "Nothing was published and nothing was compared; this is not a verdict about the version.",
    );
    process.exit(2);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`verify-release-version: could not parse ${relative} (${error.message}).`);
    process.exit(2);
  }
};

const readSources = async () => {
  const packageJson = await readJson("package.json");
  const serverJson = await readJson("server.json");
  const manifest = await readJson(".release-please-manifest.json");
  const sbom = await readJson("sbom.cdx.json");

  const version = packageJson.version;
  const sources = [
    ["`server.json` version", serverJson.version, version],
    ["`server.json` packages[0].version", serverJson.packages?.[0]?.version, version],
    ["`.release-please-manifest.json`", manifest["."], version],
    ["`sbom.cdx.json` component version", sbom.metadata?.component?.version, version],
    [
      "`sbom.cdx.json` bom-ref",
      sbom.metadata?.component?.["bom-ref"],
      `${packageJson.name}@${version}`,
    ],
    [
      "`sbom.cdx.json` purl",
      sbom.metadata?.component?.purl,
      `pkg:npm/${packageJson.name}@${version}`,
    ],
    ["`sbom.cdx.json` tool version", sbom.metadata?.tools?.[0]?.version, version],
  ];
  return { name: packageJson.name, version, sources };
};

const main = async () => {
  selfCheck();

  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: node scripts/verify-release-version.mjs [--tag <tag>]

Checks the version in package.json, server.json, .release-please-manifest.json and
sbom.cdx.json. With --tag, also checks that the tag names that version.
Exit 0 when they agree, 1 when they disagree, 2 when a file could not be read.`);
    return;
  }

  const { name, version, sources } = await readSources();
  const { failures } = evaluateReleaseVersion({ name, version, sources, tag: values.tag });

  if (failures.length > 0) {
    console.error(
      `verify-release-version: ${String(failures.length)} disagreement(s) at version ${version}:`,
    );
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  const tagSuffix = values.tag === undefined ? "" : `, and tag ${values.tag} names it`;
  console.log(`release version: ${version} agrees across every file that carries it${tagSuffix}.`);
};

await main();
