#!/usr/bin/env node
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
const DOC_PAGES_WITH_TOOLS = ["README.md", "docs/mcp-contracts.md"];

for (const file of DOC_PAGES_WITH_TOOLS) {
  const text = await read(file);
  for (const name of toolNames) {
    requireIn(text, name, { file, why: "every tool must be documented" });
  }
}

{
  const readme = await read("README.md");
  requireIn(readme, String(TOOL_CONTRACTS.length), {
    file: "README.md",
    why: `the README states the tool count, which is currently ${TOOL_CONTRACTS.length}`,
  });
  for (const template of TEMPLATE_IDS) {
    requireIn(readme, template, { file: "README.md", why: "every template must be listed" });
  }
  for (const feature of UVP_FEATURES) {
    requireIn(readme, feature, { file: "README.md", why: "every feature must be listed" });
  }
  requireIn(readme, LIBUVCPP_BASELINE, {
    file: "README.md",
    why: "the libuvcpp baseline must be stated",
  });
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
