#!/usr/bin/env node
/**
 * Which of a sweep's survivors a type-checked tree could hold at all.
 *
 * `stryker.config.mjs` runs with `checkers: []`, so a mutant that does not compile
 * is still run and still reported — as a survivor, when the group happens to pass
 * anyway. Stryker's own TypeScript checker is what would have discarded it before
 * it counted, and it cannot run here: TypeScript 7.0.2 exposes `version` and
 * `versionMajorMinor` and nothing else, so the checker's tsconfig and program
 * plumbing has nothing to call. This file is that check done the slow way, one
 * mutant at a time: apply a survivor's own replacement text to the span its own
 * report records, run the project's own `tsc --noEmit`, and keep the verdict.
 *
 * **"Does not compile" is not "not a gap", so this segments the read queue rather
 * than shrinking it.** The mutation group runs `src/` through Vitest, which strips
 * types instead of checking them, so a mutant the type system refuses still runs
 * and can still be caught by a test — [#54](https://github.com/Antruly/uvp/issues/54)
 * found a survivor that does exactly that, a `Buffer` coercing through
 * `JSON.parse`. What the compile axis separates is damage the type system already
 * prevents from damage only a *new input* would catch, and only the second is a
 * missing assertion in the sense the sweep grades. That second question was
 * answered for one file with a hand-built input matrix and does not generalize;
 * this file does not guess at it.
 *
 * The tree is mutated in place, because `tsc --noEmit` needs the project the file
 * belongs to. The report's own embedded `source` is the authority for the restore
 * — never a copy taken when the run started, which is how a probe silently reverts
 * a refactor — the file is restored in a `finally`, a signal restores it too, and
 * every file is compared against the report's source again at the end. That same
 * source is what each location is validated against: a span that names no place in
 * it is `undetermined`, not a mutation applied to a program nobody described.
 *
 * Usage: `node scripts/mutation-survivor-kinds.mjs [report]`
 *
 * - `MUTATION_REPORT` names the report, defaulting to `reports/mutation/uvp.json`.
 * - `MUTATION_TYPECHECK` overrides the compiler command, space-separated. The
 *   golden in `scripts/verify-mutation-survivor-kinds.mjs` uses it so a
 *   classification can be checked without compiling anything.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const REPORT = process.argv[2] ?? process.env["MUTATION_REPORT"] ?? "reports/mutation/uvp.json";

/**
 * Which statuses are survivors, taken from the tool that scores the report.
 *
 * `mutation-testing-metrics@3.8.4` — the package behind Stryker's own reported
 * score — computes `totalUndetected = survived + noCoverage`, so a mutant no test
 * even reached is undetected in exactly the way a survivor is. The first full
 * sweep has no `NoCoverage` mutant, so today the two sets are the same 344; the
 * set is still the metrics package's, because a classification that silently
 * stopped covering a mutant the score counts would be the disagreement this
 * repository already fixed once in `scripts/ci/mutation-summary.mjs`.
 */
const SURVIVING_STATUSES = new Set(["Survived", "NoCoverage"]);

/** Character offsets of each 1-based line start in `source`. */
const lineStarts = (source) => {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
};

// Stryker's locations are 1-based on both axes and `end` is exclusive, so the
// mutated span is `[start, end)` in characters.
const offset = (starts, position) => starts[position.line - 1] + (position.column - 1);

/**
 * The character span a mutant names, or the reason it names nothing applicable.
 *
 * The report is a file like any other and a location is arithmetic until it is
 * checked: `starts[line - 1]` is `undefined` past the last line, and `slice` turns
 * the resulting `NaN` into `""` or the whole source — a program nobody described,
 * classified by the compiler's answer about it. A mutant that does not fit is
 * `undetermined`, the same third state this file keeps for a command that failed
 * without naming a diagnostic.
 */
const spanOf = (source, starts, mutant) => {
  const { start, end } = mutant.location ?? {};
  const named = [start, end].every(
    (position) =>
      Number.isInteger(position?.line) &&
      position.line >= 1 &&
      Number.isInteger(position?.column) &&
      position.column >= 1,
  );
  if (!named) {
    return { problem: "the report names no complete 1-based location" };
  }
  if (typeof mutant.replacement !== "string") {
    return { problem: "the report names no replacement text" };
  }
  const at = (position) => (position.line > starts.length ? undefined : offset(starts, position));
  const from = at(start);
  const to = at(end);
  if (from === undefined || to === undefined) {
    return {
      problem:
        `the location ${String(start.line)}:${String(start.column)}–` +
        `${String(end.line)}:${String(end.column)} is past the source's last line`,
    };
  }
  if (to > source.length) {
    return { problem: "the location ends past the end of the source" };
  }
  if (to < from) {
    return { problem: "the location ends before it starts" };
  }
  return { from, to };
};

/** The source with one mutant's replacement applied to the span it reports. */
const mutated = (source, { from, to }, replacement) =>
  source.slice(0, from) + replacement + source.slice(to);

/**
 * The project's own compiler, resolved from the package that owns it rather than
 * from a second TypeScript on `PATH`: the verdicts are only meaningful as this
 * tree's typecheck.
 */
const compilerCommand = () => {
  const override = process.env["MUTATION_TYPECHECK"];
  if (override !== undefined) return override.split(" ").filter((part) => part !== "");
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("typescript/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin.tsc;
    return [process.execPath, join(dirname(packagePath), bin), "--noEmit"];
  } catch (cause) {
    process.stderr.write(`Could not resolve this project's typescript: ${String(cause)}\n`);
    process.exit(1);
  }
};

/**
 * One typecheck, as a verdict.
 *
 * Three states, because two would report a probe that could not run as a
 * finding: `compiles`, a diagnostic code when the compiler named one, and
 * `undetermined` when the command failed without naming one — a crash, a timeout,
 * a compiler that is not there. A mutant the compiler refused and a mutant the
 * compiler never saw are not the same answer.
 */
const typecheck = (command) => {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0) return { verdict: "compiles" };
  const codes = [
    ...new Set([...output.matchAll(/error (TS\d+)/gu)].map((match) => match[1])),
  ].sort();
  if (codes.length > 0) return { verdict: codes.join("+"), diagnostic: true };
  const detail = output.trim().split("\n")[0] ?? "";
  return {
    verdict: "undetermined",
    reason:
      `the typecheck exited ${String(result.status ?? "by signal")} without a TS diagnostic` +
      (detail === "" ? "" : `: ${detail}`),
  };
};

/** One column of the table, over one file's survivors or over all of them. */
const count = (mutants, verdict) => mutants.filter((mutant) => mutant.verdict === verdict).length;

const main = () => {
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch (cause) {
    // A report that could not be read is reported, not treated as a clean sweep.
    process.stderr.write(`Could not read ${REPORT}: ${String(cause)}\n`);
    process.exit(1);
  }

  const command = compilerCommand();
  const shown = command.map((part) =>
    part.includes("/") ? part.replace(/^.*\/node_modules\//u, "") : part,
  );

  // The baseline decides whether "does not compile" means anything at all: if the
  // untouched tree does not typecheck, every mutant's verdict would be about the
  // tree rather than about the mutation, so the run refuses instead of classifying.
  const baseline = typecheck(command);
  if (baseline.verdict !== "compiles") {
    process.stderr.write(
      `The pristine tree does not typecheck (${baseline.verdict}), so no mutant's ` +
        "verdict would be about the mutation. Nothing was classified.\n",
    );
    process.exit(1);
  }

  // A crash or a Ctrl-C must not leave the tree mutated. The report's source is
  // the backup, so the restore needs nothing that a signal could take away.
  let pending;
  const restorePending = () => {
    if (pending !== undefined) writeFileSync(pending.file, pending.source, "utf8");
    pending = undefined;
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      restorePending();
      process.exit(130);
    });
  }

  const files = [];
  let restoreFailed = false;

  for (const [file, entry] of Object.entries(report.files ?? {})) {
    const source = entry.source;
    let onDisk;
    try {
      onDisk = readFileSync(file, "utf8");
    } catch {
      onDisk = undefined;
    }
    if (source === undefined || onDisk === undefined) {
      files.push({ file, undetermined: "the report carries no source for it", mutants: [] });
      continue;
    }
    if (onDisk !== source) {
      // The locations belong to the source the report embedded. Classifying
      // against a different file would report a verdict for a tree that never
      // existed, so these survivors stay undetermined with the reason.
      files.push({
        file,
        undetermined: "the file on disk is not the source the report recorded",
        mutants: [],
      });
      continue;
    }

    const mutants = [];
    const starts = lineStarts(source);
    for (const mutant of entry.mutants ?? []) {
      if (!SURVIVING_STATUSES.has(mutant.status)) continue;
      const site = `${String(mutant.location?.start?.line ?? "?")}:${String(mutant.location?.start?.column ?? "?")}`;
      const span = spanOf(source, starts, mutant);
      if (span.problem !== undefined) {
        mutants.push({
          site,
          mutator: mutant.mutatorName,
          replacement: mutant.replacement,
          verdict: "undetermined",
          reason: span.problem,
        });
        continue;
      }
      pending = { file, source };
      let verdict;
      try {
        writeFileSync(file, mutated(source, span, mutant.replacement), "utf8");
        verdict = typecheck(command);
      } finally {
        restorePending();
      }
      mutants.push({
        site,
        mutator: mutant.mutatorName,
        replacement: mutant.replacement,
        ...verdict,
      });
    }

    // The restore is checked against the report's source rather than against what
    // this run believes it wrote.
    if (readFileSync(file, "utf8") !== source) {
      process.stderr.write(`Restore failed: ${file} is not the source the report recorded.\n`);
      restoreFailed = true;
    }
    files.push({ file, mutants });
  }

  const classified = files.filter((entry) => entry.undetermined === undefined);
  const survivors = classified.flatMap((entry) => entry.mutants);
  const broken = survivors.filter((mutant) => mutant.diagnostic === true);
  const unknown = survivors.filter((mutant) => mutant.verdict === "undetermined");

  const lines = [
    "# Survivor kinds",
    "",
    `Report: ${REPORT}`,
    `Typecheck: ${shown.join(" ")} — the pristine tree compiles clean.`,
    "",
    "| File | Survivors | Compile | Do not compile | Undetermined |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of files) {
    if (entry.undetermined !== undefined) {
      lines.push(`| ${entry.file} | — | — | — | not classified: ${entry.undetermined} |`);
      continue;
    }
    lines.push(
      `| ${entry.file} | ${String(entry.mutants.length)} | ${String(count(entry.mutants, "compiles"))} | ` +
        `${String(entry.mutants.filter((mutant) => mutant.diagnostic === true).length)} | ` +
        `${String(count(entry.mutants, "undetermined"))} |`,
    );
  }
  lines.push(
    `| **total** | **${String(survivors.length)}** | **${String(count(survivors, "compiles"))}** | ` +
      `**${String(broken.length)}** | **${String(unknown.length)}** |`,
    "",
  );

  if (broken.length > 0) {
    // The composition of the class, printed here rather than recounted by hand from
    // the site table below: a mutant may name two codes, so these columns overlap.
    const named = new Map();
    for (const mutant of broken) {
      for (const code of mutant.verdict.split("+")) named.set(code, (named.get(code) ?? 0) + 1);
    }
    const tallies = [...named].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    lines.push(
      `## The diagnostics named by the ${String(broken.length)} that do not compile`,
      "",
      "| Diagnostic | Survivors naming it |",
      "| --- | --- |",
      ...tallies.map(([code, total]) => `| ${code} | ${String(total)} |`),
      "",
      `A mutant can name more than one code, so these rows do not sum to ${String(broken.length)}.`,
      "",
    );
    lines.push(`## The ${String(broken.length)} survivor(s) that do not compile`, "");
    lines.push("| Site | Diagnostic | Mutation |", "| --- | --- | --- |");
    for (const mutant of classified.flatMap((entry) =>
      entry.mutants
        .filter((one) => one.diagnostic === true)
        .map((one) => ({ ...one, file: entry.file })),
    )) {
      const description = (mutant.replacement ?? mutant.mutator ?? "").replace(/\|/gu, "\\|");
      lines.push(`| ${mutant.file}:${mutant.site} | ${mutant.verdict} | \`${description}\` |`);
    }
    lines.push(
      "",
      "A mutant the compiler refuses is not a mutant the suite missed. The mutation group runs",
      "`src/` through Vitest, which strips types rather than checking them, so every one of these",
      "still ran and was still reported as a survivor — Stryker would have discarded it before",
      "the run, and the `typecheck` gate that runs this same command would have stopped it. What",
      "that does not settle is whether a new input would distinguish the mutant: the compile axis",
      "separates damage the compiler already catches from damage only an assertion can.",
    );
  }

  if (unknown.length > 0) {
    lines.push(
      "",
      `Unknown: ${String(unknown.length)} survivor(s) the typecheck did not answer for.`,
      ...unknown.map((mutant) => `- ${mutant.site}: ${mutant.reason ?? "no diagnostic"}`),
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  if (restoreFailed) process.exitCode = 1;
};

main();
