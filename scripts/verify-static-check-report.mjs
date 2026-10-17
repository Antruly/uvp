#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Fail when the duplication summary stops stating only what it read.
 *
 * `scripts/ci/static-check-report.mjs` prints the number CI records for a jscpd
 * run. Two of its inputs used to be defaults dressed as observations
 * ([#88](https://github.com/Antruly/uvp/issues/88)):
 *
 * - **The threshold.** It read `statistics.threshold`, a field jscpd's report
 *   does not have — the totals carry `percentage`, `clones` and `sources`, and
 *   nothing else about the policy. The summary therefore printed the fallback
 *   3.5 whatever `.jscpd.json` said, and computed its exit code against it too.
 * - **A report without totals.** `statistics.total ?? {}` made an unreadable
 *   report print `0.00%`, `0 clone(s) across 0 file(s)` and "No duplicates above
 *   the threshold", exit 0. The script's own header calls a missing report "the
 *   one wrong answer"; a present-but-unreadable one was getting the same one.
 *
 * So these cases are the readings the summary can produce, each against a
 * fixture whose answer is known by construction. The threshold cases use the same
 * report twice with two configs: only a summary that reads the config can print a
 * different number and exit differently for the same input.
 *
 * What this does not establish: it is a producer golden, not the CI job. It pins
 * the script's reading of a report, not jscpd's production of one — a real report
 * that stopped carrying its totals is exactly the case the script now refuses,
 * and the refusal is what this file holds in place.
 *
 * Environment: `GITHUB_STEP_SUMMARY` is set to the empty string for every case,
 * which the script treats as unset, so a run from CI cannot append these fixtures
 * to the real job summary. Exit status 1 when any case disagrees with this file.
 */

const SUMMARY = path.join(REPO_ROOT, "scripts", "ci", "static-check-report.mjs");
const FILE_UNDER_TEST = "scripts/ci/static-check-report.mjs";

/** Totals shaped like the report this repository's `npm run jscpd` writes. */
const TOTALS = {
  clones: 85,
  duplicatedLines: 1_130,
  duplicatedTokens: 5_775,
  lines: 50_859,
  newClones: 0,
  newDuplicatedLines: 0,
  percentage: 2.221_828_978_155_292_2,
  percentageTokens: 2.350_599_555_522_993,
  sources: 150,
  tokens: 245_682,
};

/** One clone, with only the fields the summary prints. */
const duplicate = (lines, first, second) => ({
  format: "typescript",
  lines,
  tokens: 60,
  firstFile: { name: first, start: 12 },
  secondFile: { name: second, start: 40 },
});

const report = (overrides) => ({ duplicates: [], statistics: { total: TOTALS }, ...overrides });

const CASES = [
  {
    name: "a report at 2.22% under the configured 3.5% threshold",
    report: report({
      duplicates: [duplicate(9, "src/application/a.ts", "src/application/b.ts")],
    }),
    config: { threshold: 3.5 },
    status: 0,
    stdout: {
      includes: [
        "## Duplication: 2.22% (threshold 3.5%)",
        "85 clone(s) across 150 file(s).",
        "| 9 | `src/application/a.ts:12` | `src/application/b.ts:40` |",
      ],
      excludes: ["more."],
    },
  },
  {
    name: "the same report under a 2% threshold, which the run exceeded",
    report: report(),
    config: { threshold: 2 },
    status: 1,
    stdout: {
      includes: ["## Duplication: 2.22% (threshold 2%)"],
      excludes: ["threshold 3.5"],
    },
  },
  {
    name: "a report with no totals at all",
    report: {},
    config: { threshold: 3.5 },
    status: 1,
    stderr: { includes: ["carries no readable percentage, clones, sources"] },
    stdout: { includes: [], excludes: ["0.00%", "No duplicates", "0 clone(s)"] },
  },
  {
    name: "a report whose percentage is not a number",
    report: report({ statistics: { total: { ...TOTALS, percentage: "n/a" } } }),
    config: { threshold: 3.5 },
    status: 1,
    stderr: { includes: ["carries no readable percentage"] },
    stdout: { excludes: ["NaN", "No duplicates"] },
  },
  {
    name: "a config with no numeric threshold",
    report: report(),
    config: { report: "json" },
    status: 1,
    stderr: { includes: ['does not name a numeric "threshold"'] },
    stdout: { excludes: ["Duplication"] },
  },
  {
    name: "a report that is not there",
    missingReport: true,
    config: { threshold: 3.5 },
    status: 1,
    stderr: { includes: ["No jscpd report at", "A missing report is not a clean result."] },
    stdout: { excludes: ["Duplication"] },
  },
  {
    name: "a report whose total names clones but carries no list of them",
    report: report({ duplicates: undefined }),
    config: { threshold: 3.5 },
    status: 1,
    stderr: { includes: ["names 85 clone(s) but carries no duplicates list"] },
    stdout: { excludes: ["No duplicates above the threshold", "0.00%"] },
  },
  {
    name: "a report with no duplicates",
    report: report({ statistics: { total: { ...TOTALS, clones: 0, percentage: 0 } } }),
    config: { threshold: 3.5 },
    status: 0,
    stdout: {
      includes: ["## Duplication: 0.00% (threshold 3.5%)", "No duplicates above the threshold."],
    },
  },
  {
    name: "a report kind the script does not know",
    report: report(),
    config: { threshold: 3.5 },
    reportKind: "knip",
    status: 2,
    stderr: { includes: ['Unknown report "knip"'] },
  },
];

/**
 * Run the summary with one case's fixtures.
 *
 * `--path` and `--config` both point into a fresh directory, so no case can read
 * another's files or the repository's own `.jscpd.json`.
 */
const run = async (directory, one) => {
  const reportPath = path.join(directory, "report.json");
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(one.config), "utf8");
  if (one.missingReport !== true) {
    await writeFile(reportPath, JSON.stringify(one.report), "utf8");
  }
  const result = spawnSync(
    process.execPath,
    [SUMMARY, "--report", one.reportKind ?? "jscpd", "--path", reportPath, "--config", configPath],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const check = (name, actual, expected, field, failures) => {
  for (const text of expected.includes ?? []) {
    if (!actual.includes(text)) {
      failures.push(`${name}: ${field} does not include ${JSON.stringify(text)}\n${actual}`);
    }
  }
  for (const text of expected.excludes ?? []) {
    if (actual.includes(text)) {
      failures.push(`${name}: ${field} includes ${JSON.stringify(text)}\n${actual}`);
    }
  }
};

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uvp-static-check-report-"));
  const failures = [];
  const readings = [];
  try {
    for (const [index, one] of CASES.entries()) {
      // One directory per case: a case that omits its report must not read the
      // one the previous case wrote.
      const directory = path.join(root, String(index));
      await mkdir(directory);
      const observed = await run(directory, one);
      if (observed.status !== one.status) {
        failures.push(
          `${one.name}: exited ${String(observed.status)}, expected ${String(one.status)}\n` +
            `${observed.stdout}${observed.stderr}`,
        );
      }
      check(one.name, observed.stdout, one.stdout ?? {}, "stdout", failures);
      check(one.name, observed.stderr, one.stderr ?? {}, "stderr", failures);
      readings.push(one.name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`The duplication summary disagrees with ${FILE_UNDER_TEST}:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }
  console.log(
    `static-check report: ${String(CASES.length)} case(s) read as ${FILE_UNDER_TEST} says.`,
  );
  for (const reading of readings) console.log(`  - ${reading}`);
};

await main();
