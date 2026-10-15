#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { importCompiled, REPO_ROOT } from "./lib/paths.mjs";

/**
 * Fail when a fact stated in the documentation no longer matches the code.
 *
 * Prose is not generated, so it drifts, and documentation that contradicts the
 * code is worse than documentation that is missing — a reader trusts it. This
 * checks the facts that are cheap to check mechanically and painful to get wrong:
 * counts, identifiers, and version numbers that appear in several pages and are
 * defined in exactly one place.
 *
 * Deliberately narrow. A checker that tries to validate prose produces false
 * failures, and a check that cries wolf gets disabled.
 */

const failures = [];
const notes = [];

const read = (relative) => readFile(path.join(REPO_ROOT, relative), "utf8");

const manifest = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("package-lock.json"));

const { TOOL_CONTRACTS } = await importCompiled("contracts/toolContracts.js");
const { TEMPLATE_IDS, LIBUVCPP_BASELINE } = await importCompiled("application/templates.js");
const { UVP_FEATURES } = await importCompiled("domain/features.js");
const { FEATURE_REQUIREMENTS } = await importCompiled("application/ToolchainProvider.js");

const toolNames = TOOL_CONTRACTS.map((contract) => contract.name);

/** Assert that `text` contains `needle`, reporting the file when it does not. */
const requireIn = (text, needle, { file, why }) => {
  if (!text.includes(needle)) {
    failures.push(`${file}: expected to mention ${JSON.stringify(needle)} — ${why}`);
  }
};

/**
 * The tool count and every tool name appear in the README's table, the MCP
 * contracts page, and the CLI page. All three are checked against the contracts,
 * which is the only place either is defined.
 */
const README_PAGES = ["README.md", "docs/readme/README_zh.md"];
const DOC_PAGES_WITH_TOOLS = [...README_PAGES, "docs/mcp-contracts.md"];

for (const file of DOC_PAGES_WITH_TOOLS) {
  const text = await read(file);
  for (const name of toolNames) {
    requireIn(text, name, { file, why: "every tool must be documented" });
  }
}

/**
 * Identifiers are not translated.
 *
 * The Chinese README is a translation of the English one, and what survives
 * translation is exactly the part a reader copies into a shell: tool names,
 * template ids, feature names, the libuvcpp floor. A rename that lands in one
 * README and not the other leaves a reader running a command that does not
 * exist, and it is the one kind of drift between two translations that is
 * checkable without reading Chinese. The tool *count* is checked in the English
 * README only — the translation gives that number as prose about the templates.
 */
for (const file of README_PAGES) {
  const text = await read(file);
  for (const template of TEMPLATE_IDS) {
    requireIn(text, template, { file, why: "every template must be listed" });
  }
  for (const feature of UVP_FEATURES) {
    requireIn(text, feature, { file, why: "every feature must be listed" });
  }
  requireIn(text, LIBUVCPP_BASELINE, { file, why: "the libuvcpp baseline must be stated" });
}

{
  const readme = await read("README.md");
  requireIn(readme, String(TOOL_CONTRACTS.length), {
    file: "README.md",
    why: `the README states the tool count, which is currently ${TOOL_CONTRACTS.length}`,
  });
}

/**
 * A status claim names the lane that backs it.
 *
 * The Current status section is the summary a new user reads first, and it has
 * gone stale here before: the CLI and the MCP server were built and verified by
 * boundary lanes while the section still listed both as "in progress", which is
 * how a reader ends up not trying the thing that already works.
 *
 * Prose about status is not checkable — "in progress" means whatever the
 * sentence around it means, and a checker that guessed at it would produce the
 * false failures this file exists to avoid. So it checks the part that is
 * mechanical: the section names the file that would fail if the claim stopped
 * being true, and that file is there. Move or rename a lane and the docs gate
 * fails, instead of the README going on to assert something nothing checks.
 */
const STATUS_EVIDENCE = [
  "tests/boundary/cli/cliContract.test.ts",
  "tests/boundary/mcp/mcpSurface.test.ts",
  // The one surface whose lane needs a C++ build the repository does not ship.
  // It belongs here for the same reason as the other two: the sentence claims
  // the native stack reaches a generated service, and this is the file that
  // would fail if that stopped being true — on a host that has the probe, and
  // by skipping (with the reason in the output) on one that does not.
  "tests/toolchain/nativeProbe.test.ts",
];

for (const file of README_PAGES) {
  const text = await read(file);
  for (const evidence of STATUS_EVIDENCE) {
    requireIn(text, evidence, {
      file,
      why: "the status section names the lane that verifies the surface it calls built",
    });
  }
}

for (const evidence of STATUS_EVIDENCE) {
  if (!existsSync(path.join(REPO_ROOT, evidence))) {
    failures.push(
      `${evidence} is named in both READMEs as the evidence for a status claim, and is not there.`,
    );
  }
}

/**
 * The feature page's table is the one place a reader checks a switch name before
 * typing it, so every CMake option and macro has to appear there.
 */
{
  const file = "docs/libuvcpp-features.md";
  const text = await read(file);
  for (const feature of UVP_FEATURES) {
    const requirement = FEATURE_REQUIREMENTS[feature];
    requireIn(text, feature, { file, why: "every feature needs a row" });
    for (const option of requirement.cmakeOptions) {
      requireIn(text, option, { file, why: `${feature} is enabled by ${option}` });
    }
    for (const symbol of requirement.configSymbols) {
      requireIn(text, symbol, { file, why: `${feature} is reported by ${symbol}` });
    }
  }
  if (FEATURE_REQUIREMENTS.grpc.cmakeOptions.length !== 0) {
    notes.push(
      "libuvcpp now has a CMake switch for grpc — update docs/libuvcpp-features.md, " +
        "the grpc entry in FEATURE_REQUIREMENTS, and CONTRIBUTING.md's feature-mapping note.",
    );
  }
}

/**
 * A count stated as a total has to be the total.
 *
 * The template count has drifted twice into prose that said "five" after the
 * sixth template landed — once in the MCP page and once in the testing page, in
 * both cases in a sentence about *all* of them, where the wrong number is a claim
 * about coverage rather than a typo. The identifier checks above cannot see it:
 * every template id was still listed.
 *
 * `one template` is deliberately not matched. It is how the docs say "exactly one
 * of them does this" — of the six templates, one has a store — and that is a
 * statement about a subset, not a miscount. A count of two or more is read as a
 * statement about the whole set, because that is what it has meant every time it
 * was wrong. A sentence that really does mean a subset should name the templates
 * instead, which is what the failure message asks for.
 *
 * The Chinese page is checked in the same shape, with its own numerals: it states
 * the count as 六个模板, and the two pages disagreeing about how many templates
 * there are is the drift this file exists to catch.
 */
const COUNT_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const CHINESE_NUMERALS = { 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const COUNT_PATTERN = new RegExp(
  `\\b(\\d+|${COUNT_WORDS.join("|")})\\s+(?:web-app |web |app |generated )?templates\\b`,
  "giu",
);
const CHINESE_COUNT_PATTERN = /(\d+|[两三四五六七八九十])\s*个模板/gu;

/** The count a phrase states, or `NaN` when this file cannot read it. */
const statedCount = (stated) => {
  const digits = Number.parseInt(stated, 10);
  if (!Number.isNaN(digits)) return digits;
  const index = COUNT_WORDS.indexOf(stated.toLowerCase());
  return index === -1 ? (CHINESE_NUMERALS[stated] ?? Number.NaN) : index + 2;
};

/** Every page that states how many templates there are, in either language. */
const PAGES_STATING_TEMPLATE_COUNTS = [
  ...DOC_PAGES_WITH_TOOLS,
  "docs/testing.md",
  "docs/libuvcpp-features.md",
  "docs/roadmap.md",
  "docs/tool-design.md",
  "docs/architecture.md",
  "CONTRIBUTING.md",
];

for (const file of PAGES_STATING_TEMPLATE_COUNTS) {
  const text = await read(file);
  for (const match of [...text.matchAll(COUNT_PATTERN), ...text.matchAll(CHINESE_COUNT_PATTERN)]) {
    if (statedCount(match[1]) !== TEMPLATE_IDS.length) {
      failures.push(
        `${file}: says "${match[0].trim()}", and there are ${TEMPLATE_IDS.length} templates. ` +
          `If the sentence means a subset, name which ones.`,
      );
    }
  }
}

/** Every documented feature must exist in the vocabulary, and the reverse. */
{
  const file = "docs/libuvcpp-features.md";
  const text = await read(file);
  const rowPattern = /^\| `([a-z0-9]+)` \|/gmu;
  for (const match of text.matchAll(rowPattern)) {
    if (!UVP_FEATURES.includes(match[1])) {
      failures.push(`${file}: documents feature "${match[1]}", which is not in UVP_FEATURES.`);
    }
  }
}

/**
 * A command the documentation tells a reader to run has to exist.
 *
 * This repository renames its scripts as the task behind them changes —
 * `mcp-catalog:generate` became `artifacts:tool-catalog`, `metadata:generate`
 * became part of `docs:generate` — and the prose naming the old ones stayed
 * behind in three files. Six commands were dead: a reader following
 * `CONTRIBUTING.md` was told to run `npm run metadata:generate` and got
 * `Missing script`, with a page around it that was otherwise correct and gave no
 * hint it had gone stale. Nothing here noticed, because every other check reads
 * a file and this one reads an instruction.
 *
 * Every markdown page in the repository is scanned, in both languages and with
 * no list of pages to maintain: the six were spread across three files and a
 * curated list is the thing that would have missed them. The pattern is the
 * command as a reader types it, so a page may describe a script freely in prose
 * and only `npm run <name>` is held to existing. A page quoting some *other*
 * project's `package.json` is not a case this has met; if one appears, the fix
 * is to say whose script it is, because as written it asks the reader to run it
 * here.
 *
 * Flags between `run` and the name are stepped over rather than captured: `npm
 * run --silent lint` names `lint`, and a pattern that stopped at the first word
 * after `run` would report a script called `--silent` that no page ever meant.
 * A name begins with a letter, a digit or an underscore, which is what keeps
 * that reading from being a guess.
 */
const SCRIPT_REFERENCE = /\bnpm run (?:(?:--?[a-zA-Z0-9-]+)\s+)*([a-zA-Z0-9_][a-zA-Z0-9:_-]*)/gu;

/** The names a page tells a reader to run, in the order they appear. */
const scriptReferences = (text) => [...text.matchAll(SCRIPT_REFERENCE)].map((match) => match[1]);

/**
 * The pages that are in the repository, asked of git rather than walked.
 *
 * A walk reads files that are not in the repository at all. `dev.md` is a
 * scratch file under `.gitignore`, and a gate that fails on a page nobody
 * committed is the false failure this file's own doctrine is written against.
 * A walk would also have to reimplement the ignore rules to know the difference,
 * and approximating that format is how a check comes to disagree with the thing
 * it is describing.
 *
 * `git ls-files` answering with nothing is not a pass, and neither is git
 * refusing to answer: no pages finds nothing wrong, which is the one reading
 * that must never arrive by accident. Both are failures here.
 */
const trackedPages = () => {
  let listed;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "*.md"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    console.error(
      `Cannot ask git which markdown pages are in the repository: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Without an answer this check would scan nothing and report nothing wrong.");
    process.exit(2);
  }
  const found = listed
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => path.join(REPO_ROOT, entry))
    .sort();
  if (found.length === 0) {
    console.error("git listed no markdown pages, which cannot be right for this repository.");
    process.exit(2);
  }
  return found;
};

const knownScripts = new Set(Object.keys(manifest.scripts ?? {}));
const pages = trackedPages();

for (const page of pages) {
  const relative = path.relative(REPO_ROOT, page).split(path.sep).join("/");
  const text = await readFile(page, "utf8");
  for (const name of scriptReferences(text)) {
    if (!knownScripts.has(name)) {
      failures.push(
        `${relative}: tells a reader to run \`npm run ${name}\`, ` +
          `and package.json defines no such script.`,
      );
    }
  }
}

/**
 * The notices file's distributed-dependency table is what `npm install` pulls in.
 *
 * It is the page a user reads to answer "what does installing this bring with
 * it", and it had drifted by two rows: `incur` and `pino` were still listed as
 * distributed dependencies long after they left `package.json` and the tree — a
 * reader auditing the package for a library they care about was reading a list
 * that named code no longer there, and, just as bad, was not reading the two
 * dependencies they would actually get.
 *
 * Only this table is checked. The development table groups several packages into
 * one cell (`vitest`, `@vitest/coverage-v8`) and shortens scoped ones, so it
 * cannot be read mechanically without guessing — and a check that guesses
 * reports failures a reader has to adjudicate. The table here has exactly one
 * package per row, which is what makes comparison honest.
 *
 * Names are compared with `package.json`, versions are not compared at all (they
 * are pinned there and resolved in the lockfile, and the table does not restate
 * them), and the licence column is compared with the lockfile entry npm resolved
 * for that package — `node_modules/<name>`, which is where a direct dependency
 * lands. Read from the lockfile rather than from the registry or from memory:
 * the file the version is resolved from is the file the licence belongs to, and
 * that column was wrong in two of three rows, which is most of what this page
 * exists to state.
 *
 * Direct dependencies, not the closure: that is what the table claims, and what
 * a reader gets beyond it is in the generated `licenses/npm-dependencies.json`.
 */
const DEPENDENCY_SECTION = /^## Distributed npm dependencies$/mu;
const DEPENDENCY_ROW = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gmu;

/** The dependency rows of that section, or `null` when the section is not there. */
const dependencyRows = (text) => {
  const section = text.split(DEPENDENCY_SECTION)[1]?.split(/^## /mu)[0];
  if (section === undefined) return null;
  return [...section.matchAll(DEPENDENCY_ROW)].map((match) => ({
    name: match[1],
    license: match[2],
  }));
};

/**
 * Both extraction rules, run against text whose answer is known.
 *
 * The two checks below fail *open* when their pattern stops matching: no rows
 * and no references is the same reading as nothing wrong, and the gate would go
 * green while checking nothing. That is the failure this repository has already
 * had once — a VitePress page that rendered empty while the build exited 0 — so
 * the rule is measured here rather than assumed, and a rule that can no longer
 * see what it is written to see stops the check instead of passing it.
 */
{
  const wrong = [];
  const expectFound = (what, found, wanted) => {
    const shown = JSON.stringify(found);
    if (shown !== JSON.stringify(wanted))
      wrong.push(`  ${what}: expected ${JSON.stringify(wanted)}, got ${shown}`);
  };

  expectFound(
    "a command in a code span, and one with arguments",
    scriptReferences(
      "Use `npm run test:local -- src/a.test.ts` here.\nAnd npm run docs:check next.",
    ),
    ["test:local", "docs:check"],
  );
  expectFound(
    // `pnpm run lint` is another package manager's script and a bare `npm run`
    // names nothing, so the only reference here is the last line's `lint`.
    "another package manager, a bare `npm run`, and a flag before the name",
    scriptReferences("pnpm run lint\nnpm run\nnpm run --silent lint"),
    ["lint"],
  );
  expectFound(
    "the table, without its header, separator or the sections around it",
    dependencyRows(
      [
        "## Distributed npm dependencies",
        "",
        "| Package | License | Used for |",
        "| ------- | ------- | -------- |",
        "| `a` | MIT | Something |",
        "| `@scope/b` | Apache-2.0 | Something else |",
        "",
        "## Development dependencies",
        "",
        "| `c` | MIT | Not this table |",
      ].join("\n"),
    ),
    [
      { name: "a", license: "MIT" },
      { name: "@scope/b", license: "Apache-2.0" },
    ],
  );
  expectFound("a file with no such section", dependencyRows("## Something else\n"), null);

  if (wrong.length > 0) {
    console.error("The rules this check applies are not behaving as measured:\n");
    console.error(wrong.join("\n"));
    console.error("\nFix the pattern before trusting anything below it.");
    process.exit(2);
  }
}

{
  const file = "THIRD_PARTY_NOTICES.md";
  const rows = dependencyRows(await read(file));
  if (rows === null) {
    failures.push(
      `${file}: no "## Distributed npm dependencies" section, so there is nothing ` +
        `to compare with package.json. An inventory that cannot be found is not an absent one.`,
    );
  } else {
    const listed = new Set(rows.map((row) => row.name));
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const name of declared) {
      if (!listed.has(name)) {
        failures.push(
          `${file}: the distributed-dependency table does not list \`${name}\`, ` +
            `which package.json declares as a runtime dependency.`,
        );
      }
    }
    for (const name of listed) {
      if (!declared.has(name)) {
        failures.push(
          `${file}: the distributed-dependency table lists \`${name}\` as a runtime ` +
            `dependency, and package.json does not declare it.`,
        );
      }
    }
    for (const row of rows) {
      const resolved = lock.packages?.[`node_modules/${row.name}`];
      if (resolved === undefined) {
        notes.push(
          `${file}: \`${row.name}\` has no lockfile entry, so its licence cell ` +
            `("${row.license}") was not checked.`,
        );
        continue;
      }
      const recorded = resolved.license;
      if (recorded === undefined) {
        notes.push(
          `${file}: the lockfile records no licence for \`${row.name}\`, so its cell ` +
            `("${row.license}") was not checked.`,
        );
        continue;
      }
      if (recorded.toLowerCase() !== row.license.toLowerCase()) {
        failures.push(
          `${file}: says \`${row.name}\` is ${row.license}, and the lockfile records ` +
            `${recorded} for the version it resolves.`,
        );
      }
    }
  }
}

if (notes.length > 0) {
  console.log("Doc facts — notes:");
  for (const note of notes) console.log(`  ${note}`);
}

if (failures.length > 0) {
  console.error(`Doc facts: ${failures.length} mismatch(es) between documentation and source.\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("\nFix the documentation, or the source if the documentation is right.");
  process.exit(1);
}

console.log(
  `doc facts: ${toolNames.length} tools, ${TEMPLATE_IDS.length} templates, ` +
    `${UVP_FEATURES.length} features, libuvcpp ${LIBUVCPP_BASELINE}, ` +
    `${knownScripts.size} scripts across ${pages.length} pages, ` +
    `${Object.keys(manifest.dependencies ?? {}).length} runtime dependencies — all consistent.`,
);
