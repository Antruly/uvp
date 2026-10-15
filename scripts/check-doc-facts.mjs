#!/usr/bin/env node
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
    `${UVP_FEATURES.length} features, libuvcpp ${LIBUVCPP_BASELINE} — all consistent.`,
);
