#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

/**
 * Turn a static-analysis report into a CI summary.
 *
 * The tools that produce these reports already exit non-zero on failure, so this
 * script is not a gate — it is the part that makes a failure readable. A jscpd
 * run that fails prints a count, and the count is useless without the locations.
 *
 * A missing report exits non-zero. If the analysis step did not run, saying
 * nothing would read as "no problems found", which is the one wrong answer. The
 * same rule applies to a report whose totals cannot be read: a zero printed in
 * place of an answer would read as a clean run, so it exits non-zero instead.
 *
 * The threshold is read from `.jscpd.json`, the config the run used, and not from
 * the report: jscpd's report carries no threshold, and a fallback constant would
 * be a number the summary never read.
 */

const REPORTS = {
  jscpd: ".cache/static-checks/jscpd/jscpd-report.json",
};
const DEFAULT_CONFIG = ".jscpd.json";

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    path: { type: "string" },
    config: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help || values.report === undefined) {
  console.log(`Usage: node scripts/ci/static-check-report.mjs --report <${Object.keys(REPORTS).join("|")}> [--path <report>] [--config <config>]

Writes a markdown summary to stdout and to GITHUB_STEP_SUMMARY when set.
\`--config\` defaults to ${DEFAULT_CONFIG}, the config the report was produced with.`);
  process.exit(values.help ? 0 : 2);
}

// Checked before `--path` is considered: with a path given, an unknown kind used
// to slip through and print an empty summary with exit 0, which is the same
// "nothing to report" a clean run looks like.
if (!Object.hasOwn(REPORTS, values.report)) {
  console.error(`Unknown report "${values.report}". Known: ${Object.keys(REPORTS).join(", ")}`);
  process.exit(2);
}
const file = values.path ?? REPORTS[values.report];

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The threshold the run was held to, from the config rather than the report.
 *
 * A config this script cannot read is reported like a missing report: the
 * summary's "threshold N%" and its exit code are both claims about that number,
 * and neither can be made from a guess.
 */
const thresholdOf = async (configPath) => {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (cause) {
    console.error(`Could not read ${configPath}: ${String(cause)}`);
    console.error("The threshold belongs to the config the report was produced with.");
    process.exit(1);
  }
  if (!isNumber(config.threshold)) {
    console.error(`${configPath} does not name a numeric "threshold".`);
    process.exit(1);
  }
  return config.threshold;
};

let raw;
try {
  raw = await readFile(file, "utf8");
} catch (error) {
  if (error.code === "ENOENT") {
    console.error(`No ${values.report} report at ${file}.`);
    console.error("The analysis step did not run, or it failed before writing its report.");
    console.error("A missing report is not a clean result.");
    process.exit(1);
  }
  throw error;
}

const report = JSON.parse(raw);
const lines = [];
let failed = false;

if (values.report === "jscpd") {
  const statistics = report.statistics?.total;
  const unread = ["percentage", "clones", "sources"].filter((key) => !isNumber(statistics?.[key]));
  if (unread.length > 0) {
    console.error(
      `The ${values.report} report at ${file} carries no readable ${unread.join(", ")}.`,
    );
    console.error("A report this script cannot read is not a clean result.");
    process.exit(1);
  }
  const percentage = statistics.percentage;
  const clones = statistics.clones;
  const threshold = await thresholdOf(values.config ?? DEFAULT_CONFIG);
  failed = percentage > threshold;

  lines.push(`## Duplication: ${percentage.toFixed(2)}% (threshold ${threshold}%)`, "");
  lines.push(`${clones} clone(s) across ${statistics.sources} file(s).`, "");

  // A count without a list is not "no duplicates": the totals say there are some,
  // so "No duplicates above the threshold" would contradict the line above it. An
  // empty table is that same contradiction in its other shape — jscpd writes the
  // entries its totals counted, so a report naming 85 clones and listing none is
  // not a run whose table describes its own totals. The lengths are deliberately
  // not compared: a report may list fewer entries than it counted and still be a
  // report this summary can place.
  const listed = Array.isArray(report.duplicates) ? report.duplicates : undefined;
  if (clones > 0 && (listed?.length ?? 0) === 0) {
    console.error(
      `The ${values.report} report at ${file} names ${clones} clone(s) but lists none of them.`,
    );
    console.error("A count this script cannot place is not a clean result.");
    process.exit(1);
  }
  const duplicates = (listed ?? []).slice(0, 20);
  if (duplicates.length > 0) {
    lines.push("| Lines | First | Second |", "| --- | --- | --- |");
    for (const duplicate of duplicates) {
      const first = duplicate.firstFile;
      const second = duplicate.secondFile;
      lines.push(
        `| ${duplicate.lines} | \`${first?.name}:${first?.start}\` | \`${second?.name}:${second?.start}\` |`,
      );
    }
    if ((report.duplicates?.length ?? 0) > duplicates.length) {
      lines.push("", `…and ${report.duplicates.length - duplicates.length} more.`);
    }
  } else {
    lines.push("No duplicates above the threshold.");
  }
}

const markdown = `${lines.join("\n")}\n`;
process.stdout.write(markdown);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== "") await appendFile(summary, markdown, "utf8");

process.exit(failed ? 1 : 0);
