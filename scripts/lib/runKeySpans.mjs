/**
 * Which lines of a workflow a `run:` scalar occupies, and what it says.
 *
 * Two repository checks need this and neither owns it. `verify-reporters.mjs`
 * asks what each `run:` *command* is, to look for reporter flags in it;
 * `verify-actions.mjs` asks which lines are *shell text rather than workflow
 * syntax*, so that a `uses:`-looking line inside a shell script is not read as a
 * reference to an action. Those are two questions about one interpretation, and
 * the interpretation is the subtle part — where a block ends, and what a block's
 * content cannot be mistaken for — so it lives here rather than being written out
 * twice and drifting.
 *
 * ## The forms, and why this is not a YAML parser
 *
 * Reading `run:` scalars needs a YAML parser, and the repository has none. What is
 * needed here is narrower than YAML: the value of each `run:` key, in the forms a
 * step is written in — a single-line scalar, a `|` or `>` block whose lines are
 * indented past the key, and a plain scalar whose value starts on the line below
 * the key. A block's lines are consumed as they are collected, so a line inside a
 * shell script that happens to read `run:` cannot be mistaken for a step.
 *
 * A form none of those cover — a quoted scalar that runs past its line — leaves an
 * empty command, which callers **fail on** rather than skipping. That matters
 * because the natural bug here is the quiet one: an unrecognised form read as "a
 * step with nothing to check" is a flag nobody looked at, and a check that
 * silently looks at less than it says is worse than no check.
 *
 * `runExtractionSelfCheck()` runs on every invocation of either caller. The
 * failure mode of an extraction like this is not being wrong on the day it is
 * written; it is a rule that stops matching after an edit, and a scan that then
 * finds nothing wrong.
 */

const STEP_KEY = /^(?<indent>[ \t]*)(?:-[ \t]+)?run:[ \t]?(?<rest>.*)$/u;
const BLOCK_SCALAR = /^[|>][+\-\d]*$/u;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Every `run:` in one workflow or action file, with the lines it occupies.
 *
 * `keyLine` and `bodyLines` are 1-based. `bodyLines` is what a caller masks out
 * when it is looking for workflow syntax rather than shell text. Blank lines do
 * not end a block: a shell command may contain them, and the only reliable
 * terminator is a line indented less than the key. For the plain-scalar form the
 * lines are folded with spaces, which is what YAML does with them; for a block
 * they are kept as written. Neither difference can hide a flag, which is never
 * the line break and never the indentation.
 */
export const runKeySpans = (text) => {
  const lines = text.split("\n");
  const spans = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = STEP_KEY.exec(lines[index]);
    if (match === null) continue;

    const keyIndent = match[0].indexOf("run:");
    const rest = match.groups.rest.trim();
    const block = BLOCK_SCALAR.test(rest);

    if (block || rest === "") {
      const body = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (line.trim() === "") continue;
        if (indentOf(line) <= keyIndent) break;
        body.push(block ? line : line.trim());
      }
      spans.push({
        keyLine: index + 1,
        bodyLines: Array.from({ length: cursor - index - 1 }, (_, offset) => index + 2 + offset),
        command: body.join(block ? "\n" : " "),
      });
      index = cursor - 1;
      continue;
    }

    // YAML reads a leading quote as the start of a quoted scalar, and one of
    // those can run past the line. An unbalanced quote here is therefore a
    // command whose remainder this file cannot see.
    const quote = rest[0];
    const unreadable = (quote === '"' || quote === "'") && !rest.endsWith(quote);
    spans.push({ keyLine: index + 1, bodyLines: [], command: unreadable ? "" : rest });
  }
  return spans;
};

/** The same, as `{ line, command }` — the shape a caller searching a command wants. */
export const runSteps = (text) =>
  runKeySpans(text).map((span) => ({ line: span.keyLine, command: span.command }));

/**
 * A file to extract from, and the commands it must yield, trimmed.
 *
 * The case worth having is the third: a shell script whose *content* opens a line
 * with `run:`. If the scan re-entered a block it had already collected, it would
 * count another step here — and in a real workflow that is how a flag gets
 * attributed to the wrong command, which is the only way a check like this fails
 * quietly. The fourth is where a block ends: at the first line indented less than
 * its key, which is the line after it. The fifth and sixth are the forms a step
 * takes besides `|` — a folded `>-` block, which is a block like any other, and a
 * single-line scalar, which follows one. The seventh is the plain scalar, whose
 * value begins on the line below the key. The eighth is a quoted scalar that runs
 * past its line: it must come back empty, because both callers fail on an empty
 * command and that is what keeps a truncated read from looking like a read.
 */
const EXTRACTION_FIXTURE = [
  "      - run: npm ci",
  "      - name: Run the source tests",
  "        run: |",
  "          npm run test:fast -- --reporter=default",
  "            --reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  "      - name: A shell script that is not a step",
  "        run: |",
  "          cat <<'EOF' > /tmp/x",
  "          run: echo hi",
  "          EOF",
  "      - name: A block that ends early",
  "        run: |",
  "          npm run test:built",
  "      - run: >-",
  "          npm run lint",
  "      - run: npm run docs:build",
  "      - name: A value on the line below the key",
  "        run:",
  "          npm run test:toolchain -- --reporter=blob",
  "            --reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  "      - name: A scalar that runs past its line",
  '        run: "npm run test:built',
  '          --reporter=blob"',
].join("\n");

const EXTRACTION_EXPECTED = [
  "npm ci",
  [
    "npm run test:fast -- --reporter=default",
    "--reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  ],
  ["cat <<'EOF' > /tmp/x", "run: echo hi", "EOF"],
  "npm run test:built",
  "npm run lint",
  "npm run docs:build",
  "npm run test:toolchain -- --reporter=blob --reporter=./scripts/lib/vitest-skipped-reporter.mjs",
  "",
].map((command) => [command].flat().join("\n"));

/**
 * The lines the fixture's steps must report as their own.
 *
 * The callers mask these, so a fixture that reads the right commands while
 * naming the wrong lines would leave a real defect behind the self-check.
 */
const EXTRACTION_BODY_LINES = [[], [4, 5], [8, 9, 10], [13], [15], [], [19, 20], []];

/** Exit 1 unless the fixture above reads back exactly as this file says it does. */
export const runExtractionSelfCheck = () => {
  const spans = runKeySpans(EXTRACTION_FIXTURE);
  const commands = spans.map((span) =>
    span.command
      .split("\n")
      .map((line) => line.trim())
      .join("\n"),
  );
  const bodies = spans.map((span) => span.bodyLines);
  const sameCommands =
    commands.length === EXTRACTION_EXPECTED.length &&
    commands.every((command, index) => command === EXTRACTION_EXPECTED[index]);
  const sameBodies =
    bodies.length === EXTRACTION_BODY_LINES.length &&
    bodies.every(
      (lines, index) =>
        lines.length === EXTRACTION_BODY_LINES[index].length &&
        lines.every((line, offset) => line === EXTRACTION_BODY_LINES[index][offset]),
    );
  if (sameCommands && sameBodies) return;

  const detail = sameCommands
    ? "the same commands, but not the same lines"
    : commands.length === EXTRACTION_EXPECTED.length
      ? "the same number of steps, but not the same commands"
      : `${String(EXTRACTION_EXPECTED.length)} step(s) expected, ${String(commands.length)} read`;
  // Both lists, because "expected 8, got 8" is the shape a reader cannot act on
  // and the difference is always in one line of one of them.
  console.error(
    `The \`run:\` extraction no longer reads this file's own fixture: ${detail}\n` +
      "  read commands:\n" +
      commands.map((command) => `    ${JSON.stringify(command)}`).join("\n") +
      "\n  expected commands:\n" +
      EXTRACTION_EXPECTED.map((command) => `    ${JSON.stringify(command)}`).join("\n") +
      "\n  read body lines:\n" +
      bodies.map((lines) => `    [${lines.join(", ")}]`).join("\n") +
      "\n  expected body lines:\n" +
      EXTRACTION_BODY_LINES.map((lines) => `    [${lines.join(", ")}]`).join("\n") +
      "\n",
  );
  process.exit(1);
};
