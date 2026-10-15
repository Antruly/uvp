#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "./lib/paths.mjs";
import { runExtractionSelfCheck, runKeySpans } from "./lib/runKeySpans.mjs";

/**
 * Fail when a workflow or composite action reaches for a third-party action by a
 * mutable reference.
 *
 * `uses: actions/checkout@v4` names a tag, and a tag is a pointer its owner can
 * move. Pinning the same line to `@11d5960a…` names one commit, and that is the
 * difference between "this workflow runs the code that was reviewed" and "this
 * workflow runs whatever `v4` is on the day the job starts". The pin only holds
 * if nothing quietly goes back to a tag, which is what this checks.
 *
 * ## What is required, and why a version comment is part of it
 *
 * A `uses:` value is one of three things:
 *
 *   - `./path` — an action in this repository, referenced by a path. There is no
 *     remote to pin.
 *   - `docker://image` — an image, pinned the way images are pinned, by digest.
 *   - `owner/repo[/subpath]@ref` — a third-party action, which must be pinned to a
 *     40-hex commit SHA.
 *
 * A SHA pin must also carry a comment naming the release it corresponds to, as
 * `# v4.4.0`. The SHA is what enforces; the comment is what a reader can check
 * and what keeps the pin maintainable — a bot updating a pin rewrites both
 * halves, and a bare SHA tells a reviewer nothing about what moved. This is the
 * convention Dependabot writes and updates, which is why `.github/dependabot.yml`
 * is part of this change rather than a later one: a pin nothing maintains is a
 * pin that goes stale, and a stale pin is a known-vulnerable action with a
 * comment claiming it is a release.
 *
 * One action may be pinned at exactly one SHA across the repository. Two
 * spellings of `actions/checkout` at two SHAs is what hand-pinning produces, and
 * it means two jobs run different code while both look pinned.
 *
 * ## The mini-parse, and why it is not a YAML dependency
 *
 * `uses:` is a single-line scalar everywhere here, including in the composite
 * actions, so reading it is a line at a time. The one thing a line at a time gets
 * wrong is a line of *shell text* that reads like workflow syntax, and that is
 * not hypothetical: `verify-reporters.mjs`'s own fixture contains a `run:` block
 * holding a line that starts with `run:`. So the lines of every `run:` scalar are
 * masked out first, using the same extraction both checks share
 * (`lib/runKeySpans.mjs`) rather than a second copy of the block rules.
 *
 * What this does not do is read a `uses:` key whose value is on the following
 * line: that form is reported as unreadable and **fails**, rather than being read
 * as a step with no action in it. A check that silently reads fewer references
 * than exist is worse than no check, and the same reasoning is why a run with no
 * YAML files at all fails instead of passing over nothing.
 *
 * Two things this reads that are not references, both named so a reader knows the
 * shape of the blind spot rather than discovering it: an action's *input* named
 * `uses` (under `with:`), and a reference built from an expression
 * (`uses: ${{ … }}`). Neither exists here — every file under `.github/` parses to
 * fifty `uses:` keys and this scan reports fifty — and both would be reported
 * rather than missed, which is the failure direction to prefer.
 *
 * `ruleSelfCheck()` and `pinSelfCheck()` below run on every invocation, and the
 * shared extraction runs its own. The failure mode of a check like this is not
 * being wrong on the day it is written; it is a rule that stops matching after an
 * edit, and a scan that then finds nothing to complain about.
 *
 * Environment: none. Exit status 1 when a reference is not pinned.
 */

/** A commit SHA, as git spells it. */
const SHA = /^[0-9a-f]{40}$/u;
/** An image digest. */
const DIGEST = /@sha256:[0-9a-f]{64}$/u;
/** The version a pin's comment must name. */
const VERSION_COMMENT = /v?\d+(?:\.\d+)+/u;

const USES_KEY = /^(?<indent>[ \t]*)(?:-[ \t]+)?uses:[ \t]?(?<rest>.*)$/u;
const YAML_FILE = /\.ya?ml$/u;

/**
 * What a `uses:` value is, as one of a closed set of answers.
 *
 * Returning a code rather than a boolean is what makes the self-check below able
 * to say *which* verdict a case got instead of only that it differed — the
 * distinction between "was read as unpinned" and "was read as a local path" is
 * the whole content of a regression here.
 */
const classify = (value, comment) => {
  if (value.startsWith("./")) return "local";
  if (value.startsWith("docker://")) return DIGEST.test(value) ? "digest" : "digestless";
  const at = value.lastIndexOf("@");
  if (at === -1) return "movable";
  if (!SHA.test(value.slice(at + 1))) return "movable";
  return VERSION_COMMENT.test(comment) ? "pinned" : "uncommented";
};

/**
 * The rule, against values rather than against the repository.
 *
 * Each case is a `uses:` line this repository writes or could plausibly be edited
 * into, with the verdict the scan must reach for it. The `digestless` and
 * `uncommented` cases are the two that a "does it contain a SHA?" check would
 * wave through, which is why they are the ones worth pinning down.
 */
const RULE_CASES = [
  ["./.github/actions/npm-cache", "", "local"],
  ["./some/path/action", "# anything at all", "local"],
  ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "# v4.4.0", "pinned"],
  ["actions/checkout@v4", "", "movable"],
  ["actions/checkout@main", "", "movable"],
  ["actions/checkout", "", "movable"],
  ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "", "uncommented"],
  ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "# pinned", "uncommented"],
  [
    "actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830",
    "# v4.3.0 (same SHA as actions/cache)",
    "pinned",
  ],
  ["docker://alpine@sha256:" + "0".repeat(64), "", "digest"],
  ["docker://alpine:3.20", "", "digestless"],
];

const ruleSelfCheck = () => {
  const wrong = [];
  for (const [value, comment, expected] of RULE_CASES) {
    const actual = classify(value, comment);
    if (actual !== expected) {
      wrong.push(
        `${JSON.stringify(value)}${comment === "" ? "" : ` ${JSON.stringify(comment)}`}\n` +
          `      expected ${expected}, got ${actual}`,
      );
    }
  }
  if (wrong.length > 0) {
    console.error(
      "The pin rule no longer decides these references the way this file says it does:\n" +
        wrong.map((line) => `  ${line}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
};

const pinSelfCheck = () => {
  const cases = [
    // One action, one SHA: the shape a repository in good order has.
    [
      [
        ["a.yml", "actions/checkout@1111111111111111111111111111111111111111"],
        ["b.yml", "actions/checkout@1111111111111111111111111111111111111111"],
      ],
      [],
    ],
    // The same repository at two SHAs. Named against the action, not the file,
    // because which of the two files is the mistake is not knowable from here.
    [
      [
        ["a.yml", "actions/checkout@1111111111111111111111111111111111111111"],
        ["b.yml", "actions/checkout@2222222222222222222222222222222222222222"],
      ],
      ["actions/checkout"],
    ],
    // A subpath is its own action: `actions/cache` and `actions/cache/restore`
    // are separate steps that happen to live in one repository, and holding them
    // to one SHA would forbid a release that moved only one of them.
    [
      [
        ["a.yml", "actions/cache@1111111111111111111111111111111111111111"],
        ["b.yml", "actions/cache/restore@2222222222222222222222222222222222222222"],
      ],
      [],
    ],
  ];
  const wrong = [];
  for (const [entries, expected] of cases) {
    const actual = conflictingActions(entries);
    if (actual.join(",") !== expected.join(",")) {
      wrong.push(
        `expected [${expected.join(", ")}], got [${actual.join(", ")}] for ` +
          entries.map(([file, value]) => `${file}:${value}`).join(" | "),
      );
    }
  }
  if (wrong.length > 0) {
    console.error(
      "The one-action-one-SHA rule no longer decides these cases the way this file says " +
        "it does:\n" +
        wrong.map((line) => `  ${line}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
};

/**
 * The actions pinned at more than one SHA, from `[file, value]` pairs.
 *
 * The key is everything before the last `@`, so `actions/cache` and
 * `actions/cache/restore` are different actions rather than one action spelled
 * two ways.
 */
function conflictingActions(entries) {
  const seen = new Map();
  for (const [file, value] of entries) {
    const at = value.lastIndexOf("@");
    if (at === -1) continue;
    const action = value.slice(0, at);
    const ref = value.slice(at + 1);
    if (!SHA.test(ref)) continue;
    if (!seen.has(action)) seen.set(action, new Map());
    if (!seen.get(action).has(ref)) seen.get(action).set(ref, []);
    seen.get(action).get(ref).push(file);
  }
  return [...seen.entries()]
    .filter(([, refs]) => refs.size > 1)
    .map(([action]) => action)
    .sort();
}

/**
 * Every `uses:` in one file: its value, its trailing comment, and its line.
 *
 * Lines inside a `run:` scalar are skipped before anything is matched, because
 * that is shell text and a `uses:` in it is a string a script prints or greps for
 * — not a reference to an action. Reading it as one would be a false alarm rather
 * than a miss, but a check that cries wolf about a line it was never about is a
 * check people learn to route around with `--no-verify`.
 */
const usesRefs = (text) => {
  const shellLines = new Set(runKeySpans(text).flatMap((span) => span.bodyLines));
  const refs = [];
  text.split("\n").forEach((line, index) => {
    if (shellLines.has(index + 1)) return;
    const match = USES_KEY.exec(line);
    if (match === null) return;
    const rest = match.groups.rest.trim();
    if (rest === "") {
      refs.push({ line: index + 1, value: "", comment: "" });
      return;
    }
    const hash = rest.indexOf("#");
    const value = (hash === -1 ? rest : rest.slice(0, hash)).trim();
    refs.push({ line: index + 1, value, comment: hash === -1 ? "" : rest.slice(hash + 1).trim() });
  });
  return refs;
};

/** Every `.yml`/`.yaml` directly inside one directory. */
const yamlFilesIn = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && YAML_FILE.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
};

/**
 * The files under `.github/` that a job can reach a `uses:` through.
 *
 * A directory that cannot be listed throws rather than contributing nothing: a
 * scan that read fewer files than exist must not look like a scan that read them
 * all.
 */
const githubFiles = async () => {
  const actionsRoot = path.join(REPO_ROOT, ".github", "actions");
  const found = await yamlFilesIn(path.join(REPO_ROOT, ".github", "workflows"));
  for (const entry of await readdir(actionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    found.push(...(await yamlFilesIn(path.join(actionsRoot, entry.name))));
  }
  return found.sort();
};

const relative = (file) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

const REMEDIES = {
  movable:
    "Pin it to a commit SHA with the release it names: " +
    "`owner/repo@<40-hex-sha> # vX.Y.Z`. `gh api repos/owner/repo/git/ref/tags/v4` " +
    "resolves the tag to the commit — the SHA is verified that way, never guessed.",
  uncommented:
    "Add the release this SHA is, as a trailing comment: `…@<sha> # vX.Y.Z`. Without it a " +
    "reader cannot tell what the commit is, and the update that moves the pin has no number " +
    "to rewrite — Dependabot rewrites that comment only when it is there to rewrite.",
  digestless: "Pin the image by digest: `docker://image@sha256:<64 hex>`.",
};

const main = async () => {
  ruleSelfCheck();
  pinSelfCheck();
  runExtractionSelfCheck();

  const problems = [];
  const remedies = new Set();

  let files;
  try {
    files = await githubFiles();
  } catch (error) {
    console.error(`Cannot list the workflows and actions under .github/: ${error.message}\n`);
    process.exit(1);
  }
  if (files.length === 0) {
    // Not a pass: a scan that read nothing has established nothing.
    console.error("No workflow or action file was found under .github/; nothing was checked.\n");
    process.exit(1);
  }

  // Every reference whose ref is a commit SHA, kept for the one-action-one-SHA
  // check below — including one that is missing its version comment, because a
  // SHA that disagrees with a commented SHA elsewhere is the same drift.
  const shaPins = [];
  let thirdParty = 0;
  let local = 0;
  for (const file of files) {
    for (const ref of usesRefs(await readFile(file, "utf8"))) {
      const where = `${relative(file)}:${String(ref.line)}`;
      if (ref.value === "") {
        // The one form the line-at-a-time read does not cover. Reported rather
        // than skipped, because a `uses:` nobody read is an action nobody
        // checked, and this check's whole output is the claim that they were.
        problems.push(
          `${where} has a \`uses:\` value this check cannot read — it starts on the line ` +
            "below the key — so whether that action is pinned is unknown. Put the value on " +
            "the `uses:` line.",
        );
        continue;
      }
      const verdict = classify(ref.value, ref.comment);
      if (verdict === "local") {
        local += 1;
        continue;
      }
      thirdParty += 1;
      if (verdict === "pinned" || verdict === "uncommented") {
        shaPins.push([relative(file), ref.value]);
      }
      if (verdict === "digest" || verdict === "pinned") continue;
      problems.push(`${where} uses ${ref.value}, which is not a pinned commit.`);
      remedies.add(verdict);
    }
  }

  for (const action of conflictingActions(shaPins)) {
    problems.push(
      `${action} is pinned at more than one SHA across .github/, so two jobs run different ` +
        "code while both read as pinned.",
    );
  }

  if (problems.length > 0) {
    console.error("A GitHub Actions reference is not pinned to an immutable commit.\n");
    for (const problem of problems) console.error(`  ${problem}\n`);
    for (const verdict of remedies) console.error(`${REMEDIES[verdict]}\n`);
    process.exit(1);
  }

  console.log(
    `action pins: ${String(thirdParty)} third-party \`uses:\` reference(s) and ` +
      `${String(local)} local one(s) across ${String(files.length)} file(s) under .github/ — ` +
      "every third-party reference is at one commit SHA, with the release it is named beside it",
  );
};

await main();
