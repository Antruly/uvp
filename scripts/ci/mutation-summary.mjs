#!/usr/bin/env node
/**
 * Summarize a Stryker report into the part a human actually reads: the mutants
 * that **survived**.
 *
 * A mutation score is a number that goes up when you add assertions and down
 * when you add code, which makes it a poor target and a decent signal. What
 * matters is the list underneath it — a survivor is a place where the code can
 * be wrong and the suite will not notice, which is the same class of problem as
 * an evidence report that says `verified` without having looked.
 *
 * Prints to stdout and, when `GITHUB_STEP_SUMMARY` is set, to the job summary.
 */

import { appendFileSync, readFileSync } from "node:fs";

const REPORT = process.env["MUTATION_REPORT"] ?? "reports/mutation/uvp.json";
const SURVIVING_STATUSES = new Set(["Survived", "NoCoverage", "Timeout"]);

const readReport = () => {
  try {
    return JSON.parse(readFileSync(REPORT, "utf8"));
  } catch (cause) {
    process.stderr.write(`Could not read ${REPORT}: ${String(cause)}\n`);
    return undefined;
  }
};

// The report keys files by path and does not repeat the path on each mutant, so
// it is carried along here: a survivor list that names no file is a list nobody
// can act on.
const location = (mutant) => {
  const file = (mutant.fileName ?? "(unknown file)").replace(/^.*\/src\//u, "src/");
  const line = mutant.location?.start?.line;
  return line === undefined ? file : `${file}:${String(line)}`;
};

const main = () => {
  const report = readReport();
  if (report === undefined) {
    // A missing report is reported, not treated as a clean sweep. "I could not
    // read the result" and "nothing survived" are different findings.
    process.exitCode = 1;
    return;
  }

  const mutants = Object.entries(report.files ?? {}).flatMap(([fileName, file]) =>
    (file.mutants ?? []).map((mutant) => ({ ...mutant, fileName })),
  );

  // A mutant that was planned as a run and completed no test has no result to
  // report: Stryker reports "Survived" for a mutant it never executed, and a
  // score over a report of that shape reads exactly like a suite that notices
  // nothing while being a runner defect instead. Static mutants are exempt —
  // they are activated before the tests load, and Stryker sizes a run plan for
  // them from the whole project. The check stays now that the runner is the
  // `command` runner and every mutant reports one test: a zero here means the
  // sweep has stopped running tests again, whatever the runner is. See
  // docs/testing.md, "The runner ran no test".
  const unran = mutants.filter((mutant) => mutant.static !== true && mutant.testsCompleted === 0);
  if (unran.length > 0) {
    process.stderr.write(
      `${String(unran.length)} of ${String(mutants.length)} mutants ran zero tests. ` +
        "A score over this report would describe the runner, not the suite, so it is " +
        "reported as a failure instead of a number. Survivors are listed in the retained " +
        `report; the first few are ${unran.slice(0, 5).map(location).join(", ")}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const survivors = mutants.filter((mutant) => SURVIVING_STATUSES.has(mutant.status));
  const detected = mutants.length - survivors.length;
  const score = mutants.length === 0 ? 0 : (detected / mutants.length) * 100;

  const lines = [
    `# Mutation sweep`,
    "",
    `${String(detected)}/${String(mutants.length)} mutants detected — score ${score.toFixed(1)}%.`,
    "",
  ];

  if (survivors.length === 0) {
    lines.push("No survivors. Every mutated decision was caught by an assertion.");
  } else {
    lines.push(`## ${String(survivors.length)} survivor(s)`, "");
    lines.push("| Location | Mutation | Status |", "| --- | --- | --- |");
    for (const mutant of survivors) {
      const description = (mutant.replacement ?? mutant.mutatorName ?? "").replace(/\|/gu, "\\|");
      lines.push(`| ${location(mutant)} | \`${description}\` | ${String(mutant.status)} |`);
    }
    lines.push(
      "",
      "A survivor is a place where the code can be wrong and the suite still passes.",
      "Read each one: either an assertion is missing, or the mutation is equivalent",
      "and the mutant should be excluded with a reason.",
    );
  }

  const summary = `${lines.join("\n")}\n`;
  process.stdout.write(summary);
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) appendFileSync(summaryFile, summary);
};

main();
