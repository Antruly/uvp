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

const location = (mutant) => {
  const file = mutant.sourceFile?.replace(/^.*\/src\//u, "src/") ?? "(unknown file)";
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

  const mutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
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
