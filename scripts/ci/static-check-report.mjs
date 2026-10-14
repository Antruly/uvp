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
 * nothing would read as "no problems found", which is the one wrong answer.
 */

const REPORTS = {
  jscpd: ".cache/static-checks/jscpd/jscpd-report.json",
};

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    path: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help || values.report === undefined) {
  console.log(`Usage: node scripts/ci/static-check-report.mjs --report <${Object.keys(REPORTS).join("|")}>

Writes a markdown summary to stdout and to GITHUB_STEP_SUMMARY when set.`);
  process.exit(values.help ? 0 : 2);
}

const file = values.path ?? REPORTS[values.report];
if (file === undefined) {
  console.error(`Unknown report "${values.report}". Known: ${Object.keys(REPORTS).join(", ")}`);
  process.exit(2);
}

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
  const statistics = report.statistics?.total ?? {};
  const percentage = Number(statistics.percentage ?? 0);
  const clones = Number(statistics.clones ?? 0);
  const threshold = Number(statistics.threshold ?? 3.5);
  failed = percentage > threshold;

  lines.push(`## Duplication: ${percentage.toFixed(2)}% (threshold ${threshold}%)`, "");
  lines.push(`${clones} clone(s) across ${statistics.sources ?? 0} file(s).`, "");

  const duplicates = (report.duplicates ?? []).slice(0, 20);
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
