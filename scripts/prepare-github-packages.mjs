#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { npmPurl } from "./lib/npmPurl.mjs";
import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Turn the canonical tree into the scoped package GitHub Packages can accept.
 *
 * GitHub Packages only stores scoped npm packages, and its package names and
 * scopes must be lowercase. The canonical package is `uvp-agents`, published to
 * registry.npmjs.org; this script derives `@antruly/uvp-agents` from it so the
 * same build can be uploaded a second time, without renaming the project or
 * moving the MCP registry entry.
 *
 * ## What changes, and what deliberately does not
 *
 * Changed in the working tree, immediately before `npm pack`:
 *
 *   - `package.json#name` — the scoped name, because that is the name the
 *     registry and the tarball's own manifest are about.
 *   - `package.json#publishConfig.registry` — GitHub Packages, so a publish of
 *     this tree cannot silently go to npmjs.
 *   - `package-lock.json`'s root name — kept in step with the manifest so a
 *     later `npm ls` on this tree does not report a package under a name it no
 *     longer has. The lockfile is not shipped.
 *   - `sbom.cdx.json` — regenerated, because its root component names and
 *     references the package. Shipping an SBOM for `uvp-agents` inside a
 *     tarball installed as `@antruly/uvp-agents` would describe something the
 *     user does not have.
 *
 * Left canonical on purpose:
 *
 *   - `server.json` and the MCP registry entry keep pointing at
 *     `uvp-agents@registry.npmjs.org`. The registry is the auth-free install,
 *     and the mirror is a distribution convenience rather than a second
 *     identity.
 *   - `src/generatedPackageMetadata.ts` and therefore `dist` keep the canonical
 *     name. `uvp --version` prints `uvp-agents <version>` from the mirror, and
 *     `uvp mcp setup` recommends the canonical install — which is the one that
 *     works without a GitHub token.
 *
 * The workflow records those two survivors in its summary, so a reader of the
 * mirror knows which name it will see at runtime.
 *
 * ## Fail-closed inputs
 *
 * The canonical tree is validated before anything is rewritten: `server.json`
 * must already agree with `package.json`, and the committed SBOM must describe
 * that package. A tree that already disagrees is not a tree to derive a second
 * identity from — it is one to repair with `npm run docs:generate` first.
 *
 * ## Operating on another checkout (`--root`)
 *
 * A release tag created before this helper existed cannot carry it, and a tag
 * cannot be moved. `--root` lets the workflow stage this helper from a named
 * commit on `main` and run it against the tag's checkout without adding a file
 * to that tree. Every input and output is resolved under `--root`; the helper's
 * own location is used only to import its modules. When `--root` is omitted the
 * helper operates on its own checkout, which is the normal release path.
 *
 * The bootstrap does not change what is published: the tarball's code still
 * comes from the tag. Only the helper that derives the mirror comes from a newer
 * commit, and it is not part of `files[]`.
 *
 * Exit status: 0 when the tree was rewritten, 1 when the request or the canonical
 * tree is invalid, 2 when a file could not be read or the SBOM could not be
 * regenerated (so the answer is "could not prepare", not a verdict).
 */

/** The one registry this script can prepare for. */
const REGISTRY = "https://npm.pkg.github.com";

/** GitHub's rule: package names and scopes use lowercase letters. */
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/** npm's limit for a package name, scope included. */
const MAX_NAME_LENGTH = 214;

/**
 * The scoped name, or the reason there isn't one.
 *
 * Returning a verdict rather than throwing keeps the self-check able to exercise
 * the rejected cases, and it makes "the caller passed an uppercase scope" a
 * message instead of a stack trace.
 */
const scopedNameFor = ({ name, scope }) => {
  if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope)) {
    return {
      ok: false,
      reason: `scope ${JSON.stringify(scope)} must be lowercase letters, digits, and hyphens`,
    };
  }
  if (typeof name !== "string" || name.startsWith("@")) {
    return {
      ok: false,
      reason: `package.json#name ${JSON.stringify(name)} is already scoped; this script derives a scope from an unscoped name`,
    };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: `package.json#name ${JSON.stringify(name)} must be lowercase letters, digits, dots, underscores, and hyphens`,
    };
  }
  const scoped = `@${scope}/${name}`;
  if (scoped.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      reason: `${scoped} is longer than npm's ${MAX_NAME_LENGTH}-character limit`,
    };
  }
  return { ok: true, scoped };
};

/**
 * The rule, against values whose answers are known before the tree is read.
 *
 * Run on every invocation for the reason the repository's other checks give: a
 * rule that has stopped matching reads exactly like a rule that found nothing
 * wrong. The rejected cases are the interesting half — an uppercase scope would
 * otherwise be accepted here and rejected by the registry after the tarball was
 * built.
 */
const SELF_CHECK_CASES = [
  {
    describe: "an unscoped name and a lowercase scope",
    input: { name: "uvp-agents", scope: "antruly" },
    scoped: "@antruly/uvp-agents",
  },
  {
    describe: "an uppercase scope",
    input: { name: "uvp-agents", scope: "Antruly" },
    reason: "must be lowercase",
  },
  {
    describe: "an uppercase package name",
    input: { name: "UVP-Agents", scope: "antruly" },
    reason: "must be lowercase",
  },
  {
    describe: "an already scoped name",
    input: { name: "@antruly/uvp-agents", scope: "antruly" },
    reason: "already scoped",
  },
  {
    describe: "an empty scope",
    input: { name: "uvp-agents", scope: "" },
    reason: "must be lowercase",
  },
  {
    describe: "a scope carrying a slash",
    input: { name: "uvp-agents", scope: "antruly/evil" },
    reason: "must be lowercase",
  },
  {
    describe: "dots and underscores in the name",
    input: { name: "uvp.agents_next", scope: "antruly" },
    scoped: "@antruly/uvp.agents_next",
  },
  {
    describe: "a name whose scoped form is too long",
    input: { name: "a".repeat(MAX_NAME_LENGTH), scope: "antruly" },
    reason: "longer than npm's",
  },
];

const selfCheck = () => {
  const wrong = [];
  for (const testCase of SELF_CHECK_CASES) {
    const verdict = scopedNameFor(testCase.input);
    if (testCase.scoped !== undefined) {
      if (verdict.ok !== true || verdict.scoped !== testCase.scoped) {
        wrong.push(
          `${testCase.describe}: expected ${JSON.stringify(testCase.scoped)}, got ` +
            JSON.stringify(verdict.ok ? verdict.scoped : verdict.reason),
        );
      }
      continue;
    }
    if (verdict.ok !== false || !verdict.reason.includes(testCase.reason)) {
      wrong.push(
        `${testCase.describe}: expected a rejection mentioning ${JSON.stringify(testCase.reason)}, got ` +
          JSON.stringify(verdict.ok ? verdict.scoped : verdict.reason),
      );
    }
  }
  if (wrong.length > 0) {
    console.error("The scoped-name rule no longer decides these cases as this file says:");
    for (const line of wrong) console.error(`  ${line}`);
    process.exit(1);
  }
};

const fail = (message, code) => {
  console.error(`prepare-github-packages: ${message}`);
  process.exit(code);
};

/** Read and parse one file under `root`, or exit 2 saying it could not. */
const readJson = async (root, relative) => {
  let text;
  try {
    text = await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    fail(`could not read ${relative} under ${root} (${error.code ?? error.message}).`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`could not parse ${relative} under ${root} (${error.message}).`, 2);
  }
};

const writeJson = async (root, relative, value) => {
  try {
    await writeFile(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    fail(`could not write ${relative} under ${root} (${error.code ?? error.message}).`, 2);
  }
};

/**
 * Refuse to derive a mirror from a tree whose canonical identity already
 * disagrees with itself.
 *
 * This is the one direction that matters before a rename: after it, the SBOM and
 * the manifest are about the mirror, and a mistake in the inputs would be
 * published under a name nothing else knows.
 */
const requireCanonicalIdentity = ({ packageJson, serverJson, sbom }) => {
  const { name, version } = packageJson;
  const entry = serverJson.packages?.[0];
  const component = sbom.metadata?.component;
  const discrepancies = [];

  if (typeof version !== "string" || version === "") {
    discrepancies.push("package.json has no version");
  }

  // Every other fact is one line of the same shape: what the file says, and
  // what package.json says it should say. A table keeps the failure message
  // naming the field rather than the branch that happened to run.
  const agreements = [
    ["server.json version", serverJson.version, version],
    ["server.json packages[0].version", entry?.version, version],
    ["server.json packages[0].identifier", entry?.identifier, name],
    ["sbom.cdx.json component name", component?.name, name],
    ["sbom.cdx.json component version", component?.version, version],
    ["sbom.cdx.json bom-ref", component?.["bom-ref"], `${name}@${version}`],
    ["sbom.cdx.json purl", component?.purl, npmPurl(name, version)],
  ];
  for (const [label, actual, wanted] of agreements) {
    if (actual !== wanted) {
      discrepancies.push(
        `${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
      );
    }
  }

  if (discrepancies.length > 0) {
    for (const line of discrepancies) console.error(`  ${line}`);
    fail(
      "the canonical tree disagrees with itself; run `npm run docs:generate` and release from a consistent tag",
      1,
    );
  }
};

/** Rewrite both manifests, keeping their package name in step. */
const applyMirrorIdentity = async ({ root, packageJson, packageLock, scoped }) => {
  packageJson.name = scoped;
  packageJson.publishConfig = {
    ...packageJson.publishConfig,
    registry: REGISTRY,
  };
  await writeJson(root, "package.json", packageJson);

  // The lockfile's root entry names the package too. It is not shipped, but a
  // tree whose two manifests disagree about the package's own name is the kind
  // of inconsistency a later tool would have to guess about.
  if (packageLock.packages?.[""] !== undefined) {
    packageLock.packages[""].name = scoped;
  }
  if (typeof packageLock.name === "string") {
    packageLock.name = scoped;
  }
  await writeJson(root, "package-lock.json", packageLock);
};

/** Regenerate the SBOM, whose root component names the package. */
const regenerateSbom = (root) => {
  // The SBOM generator is the owner of the document's spelling; deriving it
  // here rather than editing the JSON keeps one implementation of purl and
  // bom-ref. It comes from the same root as the manifests, so a bootstrap run
  // uses the tag's generator even when this helper came from a newer commit.
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/sbom.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
  } catch (error) {
    fail(`the SBOM generator under ${root} failed (${error.status ?? error.message}).`, 2);
  }
};

/** The regenerated document must describe the mirror, not the canonical tree. */
const assertMirrorSbom = async ({ root, scoped, version }) => {
  const mirrored = await readJson(root, "sbom.cdx.json");
  const component = mirrored.metadata?.component;
  const purl = npmPurl(scoped, version);
  const agreements = [
    ["name", component?.name, scoped],
    ["bom-ref", component?.["bom-ref"], `${scoped}@${version}`],
    ["purl", component?.purl, purl],
  ];
  const mismatches = agreements
    .filter(([, actual, wanted]) => actual !== wanted)
    .map(
      ([label, actual, wanted]) =>
        `${label} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
    );
  if (mismatches.length > 0) {
    for (const line of mismatches) console.error(`  ${line}`);
    fail("the regenerated SBOM does not describe the mirror; nothing was published.", 2);
  }
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      scope: { type: "string" },
      root: { type: "string" },
      "self-check": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  selfCheck();

  if (values.help) {
    console.log(`Usage: node scripts/prepare-github-packages.mjs --scope <scope> [--root <dir>] [--self-check]

Rewrites the checkout for a GitHub Packages publish:
  package.json#name                 -> @<scope>/<name>
  package.json#publishConfig.registry -> ${REGISTRY}
  package-lock.json root name       -> @<scope>/<name>
  sbom.cdx.json                     -> regenerated for @<scope>/<name>

server.json, src/generatedPackageMetadata.ts and dist keep the canonical name.
--root <dir>  operate on another checkout (default: this helper's checkout);
              every input and output is resolved there.
--self-check  run the scoped-name rule against its known cases and exit.`);
    return;
  }
  if (values["self-check"]) return;

  if (values.scope === undefined) {
    fail("--scope is required (for this repository: --scope antruly).", 2);
  }

  const root = path.resolve(values.root ?? REPO_ROOT);

  const packageJson = await readJson(root, "package.json");
  const packageLock = await readJson(root, "package-lock.json");
  const serverJson = await readJson(root, "server.json");
  const sbom = await readJson(root, "sbom.cdx.json");

  const verdict = scopedNameFor({ name: packageJson.name, scope: values.scope });
  if (!verdict.ok) {
    fail(`${verdict.reason}.`, 2);
  }
  const scoped = verdict.scoped;
  const canonicalName = packageJson.name;

  requireCanonicalIdentity({ packageJson, serverJson, sbom });
  await applyMirrorIdentity({ root, packageJson, packageLock, scoped });
  regenerateSbom(root);
  await assertMirrorSbom({ root, scoped, version: packageJson.version });

  console.log(
    `prepared ${scoped}@${packageJson.version} in ${root} for ${REGISTRY} ` +
      `(server.json and dist keep ${JSON.stringify(canonicalName)} as the canonical identity)`,
  );
};

await main();
