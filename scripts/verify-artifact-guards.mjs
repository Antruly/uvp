#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "./lib/paths.mjs";
import { runExtractionSelfCheck } from "./lib/runKeySpans.mjs";
// `Unreadable` is defined where workflow lines are read, and reused here for a
// condition that cannot be read: both mean "this check could not look", which is
// the state that has to be reported rather than answered.
import { Unreadable, readWorkflow } from "./lib/workflowScan.mjs";

/**
 * Fail when a lane reads an artifact the same change may not have built.
 *
 * ## The defect this exists for, because it was observed rather than imagined
 *
 * `ci.yml`'s `test` job runs whenever the run is not cancelled, rather than only
 * when the `code` lane is selected, so that a shard that failed still produces a
 * merged report and the coverage artifact. Its steps, though, downloaded
 * `uvp-test-runtime` — which the `build` job uploads only when `code` or
 * `package` is selected. So a commit touching nothing but `docs/` selected the
 * `docs` lane, correctly skipped `build`, `test-source` and `test-shard`, and
 * then failed in `test` on an artifact that was never uploaded. `CI required`
 * reported a red run for a documentation-only change, and the guard that job does
 * have (`CODE_REQUIRED`) sits *below* the download, so it never ran.
 *
 * Nothing caught it before the push. `actionlint` validates workflow syntax and
 * expressions; it does not know that one job's step reads what another job's
 * condition decides to write. The plan decides lanes; the workflow decides what a
 * lane does; nothing compared the two. This compares them.
 *
 * ## The rule
 *
 * For every step that reads an artifact, **the condition gating that step must be
 * true whenever the condition gating the job that uploads the artifact is true** —
 * the reader's condition implies the writer's. A reader narrower than its writer
 * is fine and is the ordinary case (`test-shard` runs on `code` while `build` runs
 * on `code || package`). A reader *wider* than its writer is the defect.
 *
 * The comparison is exact rather than textual, which matters in both directions:
 * a rule that merely wanted `code` to appear in the reader's condition would
 * reject the correct `code ⇒ code || package`, and a rule that wanted the
 * conditions to be equal would reject it too. So each `if:` is parsed and
 * evaluated over every assignment of the outputs it mentions.
 *
 * A step's effective condition is its job's **and** its own, since a step narrows
 * its job rather than replacing it; `effectiveCondition` carries that, and the
 * first version of this file got it wrong in a way only mutation testing found.
 *
 * ## Anchoring on downloads
 *
 * An artifact enters a lane through `actions/download-artifact`, so that is where
 * this looks. A `run:` step that then consumes what was downloaded is **not** a
 * second anchor, and the gap is real rather than hypothetical: the step that merges
 * the downloaded shard reports is guarded on `code` as well, and removing that guard
 * is a change this check does not fail on — the merge would run with nothing to
 * merge. Deciding it textually would mean telling a step that consumes an artifact
 * from one that only reports on the run, and no rule here can; the guard stays by
 * hand and the boundary is stated rather than left for a reader to infer.
 *
 * ## Fail-closed, and never by accident
 *
 * An `if:` whose value is on the following line, an expression using anything
 * beyond `||`, `&&`, `!`, parentheses, `==`/`!=` against `'true'`/`'false'`, and
 * `always()`/`cancelled()` — each is reported as unreadable and **fails**, rather
 * than being read as a condition this file cannot judge. So is a line the scan
 * cannot read at all: a `uses:` with no value, or the shape that was found here, a
 * list item where a step should be. And `EXPECTED_CONSUMERS` names the reads that
 * exist today, so a scanner that quietly stops recognising a step fails instead of
 * going green over less than it promises — which is also what fails an empty scan,
 * since "nothing to complain about" and "read nothing" are the same output.
 *
 * ## What is deliberately not parsed
 *
 * The scan records every `if:` in the file, but parses only the ones that can
 * affect a verdict: each job's, and each artifact step's. Nothing else enters the
 * comparison, so an expression elsewhere that this parser could not read is not a
 * gap in the answer — and parsing it anyway would make the check refuse to run on
 * workflows holding conditions it has no business judging. The first of those is
 * real: `steps.openssl-cache.outputs.cache-hit != 'true'` guards an OpenSSL build
 * step in the `toolchain` job, and a comparison against a step output is not a
 * lane. The same choice means a trailing ` # …` comment on one of the parsed `if:`
 * lines reads as unreadable rather than being stripped: a `#` inside a quoted value
 * is legal YAML, so stripping on sight is how a value gets silently truncated. The
 * failure is loud and one word long to fix, which is the right side to be wrong on.
 *
 * Environment: none. Exit status 1 when a reader is wider than its writer, or when
 * something cannot be read.
 */

/**
 * A parsed condition, and the outputs it mentions.
 *
 * `evaluate` takes an object of the outputs' boolean values. Grammar, in
 * precedence order: `||`, then `&&`, then `!`, then parentheses, a call, or a
 * comparison against a quoted boolean. Anything else is `Unreadable`.
 */
const parseCondition = (raw, where) => {
  const text = raw
    .replace(/\$\{\{/gu, " ")
    .replace(/\}\}/gu, " ")
    .trim();
  if (text === "") throw new Unreadable(`${where}: the condition is empty`);

  const names = new Set();
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && /\s/u.test(text[at])) at += 1;
  };
  const reading = () => text.slice(at);

  const or = () => {
    let left = and();
    for (;;) {
      skipSpace();
      if (!reading().startsWith("||")) return left;
      at += 2;
      const right = and();
      const [l, r] = [left, right];
      left = (values) => l(values) || r(values);
    }
  };

  const and = () => {
    let left = unary();
    for (;;) {
      skipSpace();
      if (!reading().startsWith("&&")) return left;
      at += 2;
      const right = unary();
      const [l, r] = [left, right];
      left = (values) => l(values) && r(values);
    }
  };

  const unary = () => {
    skipSpace();
    if (reading().startsWith("!")) {
      at += 1;
      const inner = unary();
      return (values) => !inner(values);
    }
    return primary();
  };

  const primary = () => {
    skipSpace();
    if (reading().startsWith("(")) {
      at += 1;
      const inner = or();
      skipSpace();
      if (!reading().startsWith(")")) throw new Unreadable(`${where}: unbalanced "("`);
      at += 1;
      return inner;
    }
    for (const [call, answer] of [
      ["always()", true],
      ["cancelled()", false],
    ]) {
      if (reading().startsWith(call)) {
        at += call.length;
        return () => answer;
      }
    }
    const output = /^needs\.changes\.outputs\.(?<name>[A-Za-z_][A-Za-z0-9_]*)/u.exec(reading());
    if (output === null) {
      throw new Unreadable(`${where}: cannot read the condition "${text}" at "${reading()}"`);
    }
    at += output[0].length;
    const name = output.groups.name;
    skipSpace();
    const operator = /^(?<op>==|!=)/u.exec(reading());
    if (operator === null) {
      throw new Unreadable(`${where}: expected == or != after outputs.${name}`);
    }
    at += operator[0].length;
    skipSpace();
    const quote = text[at];
    if (quote !== "'" && quote !== '"') {
      throw new Unreadable(`${where}: expected a quoted literal after outputs.${name}`);
    }
    const end = text.indexOf(quote, at + 1);
    if (end === -1) throw new Unreadable(`${where}: the literal after outputs.${name} is unclosed`);
    const literal = text.slice(at + 1, end);
    if (literal !== "true" && literal !== "false") {
      throw new Unreadable(`${where}: outputs.${name} is compared against "${literal}"`);
    }
    at = end + 1;
    names.add(name);
    const wanted = (operator.groups.op === "==") === (literal === "true");
    return (values) => values[name] === wanted;
  };

  const evaluate = or();
  skipSpace();
  if (at !== text.length) {
    throw new Unreadable(`${where}: cannot read the condition "${text}" at "${reading()}"`);
  }
  return { evaluate, names: [...names], text };
};

/** The condition that is always true, for a job or step with no `if:`. */
const ALWAYS = { evaluate: () => true, names: [], text: "(no condition)" };

/**
 * Every assignment of the given outputs, as an array of `{name: boolean}`.
 *
 * The count is bounded because this is enumerated rather than reasoned about: a
 * condition mentioning more outputs than the bound is reported instead of being
 * quietly judged on a subset. The plan emits seven today (`code`, `docs`,
 * `workflows`, `package`, `toolchain`, `tier`, `file_count`), and no condition
 * reads more than two, so the bound is headroom rather than a fit.
 */
const ASSIGNMENT_LIMIT = 12;
const assignmentsOver = (names) => {
  if (names.length > ASSIGNMENT_LIMIT) {
    throw new Unreadable(
      `a condition mentions ${String(names.length)} outputs, more than this check enumerates ` +
        `(${String(ASSIGNMENT_LIMIT)})`,
    );
  }
  const rows = [];
  for (let bits = 0; bits < 1 << names.length; bits += 1) {
    const row = {};
    names.forEach((name, index) => {
      row[name] = (bits & (1 << index)) !== 0;
    });
    rows.push(row);
  }
  return rows;
};

/** The assignment that makes `reader` true and `writer` false, or undefined. */
const counterexample = (reader, writer) => {
  const names = [...new Set([...reader.names, ...writer.names])];
  for (const values of assignmentsOver(names)) {
    if (reader.evaluate(values) && !writer.evaluate(values)) return values;
  }
  return undefined;
};

/** `<name> false, <name2> true`, for a message naming what the lane would see. */
const describe = (values) =>
  Object.entries(values)
    .map(([name, value]) => `${name} ${String(value)}`)
    .join(", ");

/** The condition on an `if:` field, or the always-true one when there is none. */
const conditionOf = (field) => {
  if (field === undefined) return ALWAYS;
  field.parsed ??= parseCondition(field.text, field.where);
  return field.parsed;
};

/**
 * What has to be true for a step to run: its job's condition **and** its own.
 *
 * A step does not override its job's `if:` — a job that does not run has no steps
 * that do — so the two are conjoined rather than one of them winning. Reading only
 * the step's condition is not a small error: an artifact whose upload step carries
 * `if: ${{ !cancelled() }}` inside a job gated on `code` looks exactly as wide as
 * the reader that follows it, and every violation of that shape goes unnoticed.
 * `test-source` uploads `vitest-report-source` that way, which is how this was
 * found: removing the guard from the step that reads it did not fail the check.
 */
const effectiveCondition = (record) => {
  const job = conditionOf(record.job.ifField);
  const own = conditionOf(record.ifField);
  if (record.ifField === undefined) return job;
  if (record.job.ifField === undefined) return own;
  return {
    names: [...new Set([...job.names, ...own.names])],
    text: `${job.text} && ${own.text}`,
    evaluate: (values) => job.evaluate(values) && own.evaluate(values),
  };
};

/** Artifact names matching a `pattern:`, where `*` is the only wildcard used here. */
const matches = (pattern, name) => {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\\\*/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
};

/**
 * The reads that exist today, as `[job, what the step names]`.
 *
 * The failure this guards against is a scanner that stops recognising a step and
 * then reports a clean workflow: the output of a check that read nothing is
 * identical to the output of a check that found nothing wrong.
 */
const EXPECTED_CONSUMERS = [
  ["test-shard", "uvp-test-runtime"],
  ["test", "uvp-test-runtime"],
  ["test", "vitest-report-*"],
  ["package-e2e", "uvp-test-runtime"],
];

const checkExpectedConsumers = (jobs) => {
  const missing = [];
  for (const [jobName, spec] of EXPECTED_CONSUMERS) {
    const job = jobs.get(jobName);
    const found =
      job !== undefined &&
      job.downloads.some(
        (download) => download.with.name === spec || download.with.pattern === spec,
      );
    if (!found) missing.push(`${jobName} no longer downloads ${spec}`);
  }
  return missing;
};

/**
 * What the reader of an artifact must be selected by, for the artifacts it reads.
 *
 * A download names one artifact, a `pattern:` names the set it matches, and
 * neither means every artifact in the run — which is the action's own behaviour,
 * so it is read that way rather than treated as unreadable.
 */
const readsOf = (download, producers) => {
  if (download.with.name !== undefined) {
    return producers.has(download.with.name) ? [download.with.name] : [];
  }
  if (download.with.pattern !== undefined) {
    return [...producers.keys()].filter((name) => matches(download.with.pattern, name));
  }
  return [...producers.keys()];
};

/**
 * What one download step says, as violations plus the pair it was checked as.
 *
 * A pair is counted when the artifact has a writer in another job; an artifact a
 * job uploads and reads itself is its own business, since nothing about another
 * job's selection decides whether it exists.
 */
const checkDownload = (job, download, producers, violations) => {
  const where = `${job.name} → "${download.step}"`;
  const artifactNames = readsOf(download, producers);
  if (artifactNames.length === 0) {
    const spec = download.with.name ?? download.with.pattern ?? "(everything)";
    violations.push(`${where}: reads ${spec}, which no job in this workflow uploads`);
    return 0;
  }

  let pairs = 0;
  const reader = effectiveCondition(download);
  for (const artifact of artifactNames) {
    const writers = (producers.get(artifact) ?? []).filter((each) => each.job !== job);
    if (writers.length === 0) continue;
    pairs += 1;
    for (const writer of writers) {
      const example = counterexample(reader, writer.condition);
      if (example === undefined) continue;
      violations.push(
        `${where}: reads ${artifact}, uploaded by ${writer.job.name} ` +
          `(${writer.condition.text}), but this step runs when (${reader.text}) — ` +
          `the change ${describe(example)} selects this step and skips ${writer.job.name}`,
      );
    }
  }
  return pairs;
};

const findViolations = (jobs) => {
  // The writer side is resolved once, here, because an upload's condition is its
  // own `if:` when it has one and its job's otherwise — and the job's may be read
  // after the step that carries the upload.
  const producers = new Map();
  for (const job of jobs.values()) {
    for (const upload of job.uploads) {
      const owners = producers.get(upload.name) ?? [];
      owners.push({ job, condition: effectiveCondition(upload) });
      producers.set(upload.name, owners);
    }
  }

  const violations = [];
  let checked = 0;
  let reads = 0;
  for (const job of jobs.values()) {
    for (const download of job.downloads) {
      reads += 1;
      checked += checkDownload(job, download, producers, violations);
    }
  }
  return { violations, checked, artifacts: producers.size, reads };
};

/**
 * The implication table, checked against the expressions this check will parse.
 *
 * The failure mode of a checker like this is not being wrong on the day it is
 * written; it is a parser that stops meaning what it meant, after which every
 * condition it reads looks consistent. So the verdicts are named here, including
 * the one this check was written for, and a parser that disagrees fails rather
 * than going green.
 */
const IMPLICATION_FIXTURE = [
  // The reader is the writer: always fine.
  ["needs.changes.outputs.code == 'true'", "needs.changes.outputs.code == 'true'", true],
  // Narrower than the writer, which is the ordinary and correct case.
  [
    "needs.changes.outputs.code == 'true'",
    "needs.changes.outputs.code == 'true' || needs.changes.outputs.package == 'true'",
    true,
  ],
  // Wider than the writer: the defect, as it was written.
  ["${{ !cancelled() }}", "needs.changes.outputs.code == 'true'", false],
  ["always()", "needs.changes.outputs.code == 'true'", false],
  // No condition at all means the step runs on every run, which is the widest a
  // reader can be — not the narrowest.
  ["", "needs.changes.outputs.code == 'true'", false],
  ["needs.changes.outputs.code == 'true'", "", true],
  // Neither implies the other.
  [
    "needs.changes.outputs.package == 'true'",
    "needs.changes.outputs.code == 'true' || needs.changes.outputs.package == 'true'",
    true,
  ],
  [
    "needs.changes.outputs.code == 'true' || needs.changes.outputs.package == 'true'",
    "needs.changes.outputs.code == 'true'",
    false,
  ],
  ["needs.changes.outputs.code != 'true'", "needs.changes.outputs.code == 'true'", false],
  ["needs.changes.outputs.code == 'false'", "needs.changes.outputs.code == 'true'", false],
  // Parentheses and `&&`, which no condition here uses yet and the parser takes.
  // This one does **not** imply `package`: `code` and `docs` together satisfy it
  // with `package` false, which is the reason a text-level rule cannot answer
  // this question and the enumeration is worth having.
  [
    "(needs.changes.outputs.code == 'true' || needs.changes.outputs.package == 'true') && needs.changes.outputs.docs == 'true'",
    "needs.changes.outputs.package == 'true'",
    false,
  ],
  ["!needs.changes.outputs.code == 'true'", "needs.changes.outputs.code == 'true'", false],
];

/** The forms that must be refused rather than judged. */
const UNREADABLE_FIXTURE = [
  "secrets.SOMETHING == 'true'",
  "contains(github.event.head_commit.message, 'x')",
  "needs.changes.outputs.tier == '3'",
  "needs.changes.outputs.code",
  "needs.changes.outputs.code == 'true' ||",
  "(needs.changes.outputs.code == 'true'",
];

const parserSelfCheck = () => {
  const problems = [];
  // An empty condition is "this always runs", which is what a job or step with no
  // `if:` means — the same fallback `findViolations` applies.
  const conditionOf = (text) => (text === "" ? ALWAYS : parseCondition(text, "fixture"));
  for (const [readerText, writerText, expected] of IMPLICATION_FIXTURE) {
    try {
      const reader = conditionOf(readerText);
      const writer = conditionOf(writerText);
      const actual = counterexample(reader, writer) === undefined;
      if (actual !== expected) {
        problems.push(
          `"${readerText}" ⇒ "${writerText}": expected ${String(expected)}, read ${String(actual)}`,
        );
      }
    } catch (error) {
      problems.push(`"${readerText}" ⇒ "${writerText}": ${error.message}`);
    }
  }
  for (const text of UNREADABLE_FIXTURE) {
    try {
      parseCondition(text, "fixture");
      problems.push(`"${text}" was read, and this file says it cannot be`);
    } catch (error) {
      if (!(error instanceof Unreadable)) problems.push(`"${text}": ${error.message}`);
    }
  }
  return problems;
};

/**
 * The scanner, against a workflow written to hold every shape it reads.
 *
 * Three jobs, one uploading and one downloading with a step-level guard, one whose
 * `needs:` list is indented exactly like a step, plus a shell script containing a
 * line that reads like a step — the case that makes a line-based scan wrong when
 * `run:` bodies are not masked. The jobs are ordered so the `needs:` job is read
 * *after* the downloading one, since a list item mistaken for a step only shows up
 * once there is a step to mistake it for.
 */
const SCAN_FIXTURE = [
  "jobs:",
  "  build:",
  "    if: needs.changes.outputs.code == 'true' || needs.changes.outputs.package == 'true'",
  "    steps:",
  "      - run: npm ci",
  "      - name: Upload",
  "        if: ${{ !cancelled() }}",
  "        uses: actions/upload-artifact@abc # v4.6.2",
  "        with:",
  "          name: the-runtime",
  "          path: .",
  "  test:",
  "    if: ${{ !cancelled() }}",
  "    steps:",
  "      - name: Read it",
  "        if: needs.changes.outputs.code == 'true'",
  "        uses: actions/download-artifact@abc # v4.3.0",
  "        with:",
  "          name: the-runtime",
  "          path: .",
  "      - name: A shell script that is not a step",
  "        run: |",
  "          uses: actions/download-artifact@abc",
  "          with:",
  "            name: not-really",
  "  required:",
  "    if: ${{ !cancelled() }}",
  "    needs:",
  "      - build",
  "      - test",
  "    steps:",
  "      - run: exit 0",
].join("\n");

const checkUploadedArtifact = (build) => {
  const problems = [];
  if (build?.uploads.length !== 1 || build.uploads[0]?.name !== "the-runtime") {
    problems.push("the fixture's upload was not read as one artifact named `the-runtime`");
  }
  if (build?.ifField?.text === undefined) {
    problems.push("the fixture's job-level guard was not read");
  }
  return problems;
};

const checkDownloadedArtifact = (test) => {
  const problems = [];
  const download = test?.downloads[0];
  if (test?.downloads.length !== 1) {
    problems.push(
      `the fixture's download count is ${String(test?.downloads?.length)} rather than 1`,
    );
  }
  if (download?.with.name !== "the-runtime") {
    problems.push("the fixture's download did not read the `with:` block");
  }
  if (download?.ifField?.text !== "needs.changes.outputs.code == 'true'") {
    problems.push("the fixture's step-level guard was not read");
  }
  return problems;
};

/**
 * `needs:`' items are indented like steps and are not steps. Read as steps they
 * would be `build` and `test` — names that exist — so nothing else in this file
 * would notice; the count is what notices.
 */
const checkNeedsList = (required) => {
  const problems = [];
  const stepCount = required?.steps?.length;
  if (stepCount !== 1) {
    problems.push(
      `the fixture read ${String(stepCount)} step(s) in the job that has a \`needs:\` list`,
    );
  }
  if (required?.downloads.length !== 0 || required?.uploads.length !== 0) {
    problems.push("the fixture read an artifact step out of the `needs:` list");
  }
  return problems;
};

/**
 * The download is guarded on `code` while the upload's job runs on
 * `code || package`, which is the direction this check must accept. If the
 * fixture's own shapes stop resolving, every real workflow would be read as
 * consistent for the same reason.
 */
const checkFixtureVerdict = (build, test) => {
  if (build === undefined || test === undefined) return [];
  const verdict = counterexample(
    effectiveCondition(test.downloads[0]),
    effectiveCondition(build.uploads[0]),
  );
  if (verdict === undefined) return [];
  return [`the fixture's correct pair was judged a violation: ${describe(verdict)}`];
};

/**
 * A step's `if:` narrows its job's, and does not replace it. The fixture's upload
 * carries `if: ${{ !cancelled() }}` inside a job gated on `code || package`, so a
 * reader that took the step's condition for the whole answer would call that
 * artifact unconditional — and an artifact that looks unconditional can never be
 * too narrow for the step that reads it, which is every violation there is.
 */
const checkConjunction = (build) => {
  const upload = build?.uploads[0];
  if (upload === undefined) return [];
  const effective = effectiveCondition(upload);
  if (!effective.evaluate({ code: false, package: false })) return [];
  return [
    "the fixture's artifact was read as uploaded by a change that selects neither `code` nor `package`",
  ];
};

const scanSelfCheck = () => {
  let jobs;
  try {
    jobs = readWorkflow(SCAN_FIXTURE, "fixture");
  } catch (error) {
    return [`the fixture no longer scans: ${error.message}`];
  }
  return [
    ...checkUploadedArtifact(jobs.get("build")),
    ...checkDownloadedArtifact(jobs.get("test")),
    ...checkNeedsList(jobs.get("required")),
    ...checkFixtureVerdict(jobs.get("build"), jobs.get("test")),
    ...checkConjunction(jobs.get("build")),
    ...(jobs.size === 3 ? [] : [`the fixture read ${String(jobs.size)} job(s) rather than 3`]),
  ];
};

const main = async () => {
  runExtractionSelfCheck();

  const problems = [...parserSelfCheck(), ...scanSelfCheck()];
  if (problems.length > 0) {
    console.error(
      "The artifact guard check no longer reads what this file says it does:\n" +
        problems.map((problem) => `  ${problem}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }

  const file = path.join(REPO_ROOT, ".github/workflows/ci.yml");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    console.error(`Cannot read .github/workflows/ci.yml: ${error.message}`);
    process.exit(1);
  }

  let jobs;
  try {
    jobs = readWorkflow(text, ".github/workflows/ci.yml");
  } catch (error) {
    console.error(`artifact guards: ${error.message}`);
    process.exit(1);
  }

  const missing = checkExpectedConsumers(jobs);
  if (missing.length > 0) {
    console.error(
      "artifact guards: a read this check exists to watch is no longer recognised:\n" +
        missing.map((line) => `  ${line}`).join("\n") +
        "\n  Either the workflow changed or this scanner stopped reading it; both need a look.\n",
    );
    process.exit(1);
  }

  let result;
  try {
    result = findViolations(jobs);
  } catch (error) {
    console.error(`artifact guards: ${error.message}`);
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(
      "artifact guards: a step reads an artifact the same change may not upload:\n" +
        result.violations.map((violation) => `  ${violation}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }

  // No separate "found no reads at all" branch: the expected-consumers list above
  // already fails on a workflow whose reads stopped being recognised, and a second
  // guard for a case the first one covers is a branch nothing can reach.

  console.log(
    `artifact guards: ${String(result.checked)} read(s) checked over ${String(result.artifacts)} ` +
      `uploaded artifact name(s), from ${String(result.reads)} download step(s) — every reader ` +
      "is gated no wider than the job that uploads it",
  );
};

await main();
