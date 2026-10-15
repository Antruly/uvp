#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { globToRegExp } from "./lib/globs.mjs";
import { REPO_ROOT } from "./lib/paths.mjs";

/**
 * Fail when a docs page holds `{{` that Vue will read as an interpolation.
 *
 * The docs are VitePress pages, so their markdown is compiled to a Vue render
 * function and their braces are code. Measured on 2026-10-16 by building one page
 * per form (`vitepress` 1.6.4), because the failure modes are not all the same
 * and not all of them are visible:
 *
 *   - `` `{{ name }}` `` in inline code renders as `Inline code: .` — the braces
 *     **and the text between them** are gone, silently.
 *   - `` `${{ name }}` `` renders as `Inline code: $ .` — the same, minus the `$`.
 *   - `` `${{ name() }}` `` throws `_ctx.name is not a function`, which fails the
 *     page's whole render; VitePress logs it and **exits 0**.
 *   - Inside a ``` or ```` fence it is the literal `{{ name }}`: fences are
 *     wrapped in `v-pre` for you.
 *   - Inside `<span v-pre>` … `</span>` it is literal too.
 *   - Inside a four-space **indented** block it is gone, silently: an indented
 *     block is not a fence and gets no `v-pre`. That is why this is a check and
 *     not a note in a style guide — the form that looks most like a code block is
 *     one of the ways to lose the text.
 *   - A lone `}}` is left alone, in code or in prose. So this looks for `{{` and
 *     says nothing about a closing pair, because flagging one would be a false
 *     positive.
 *   - An unclosed `{{` is a build error — `Interpolation end sign was not found`,
 *     exit 1 — so the silent cases are all ones with a matched pair.
 *
 * The third form is why this cannot be left to the build: `docs/roadmap.md` wrote
 * the workflow's own `${{ !cancelled() }}` in an inline code span, VitePress
 * logged the TypeError and exited 0, and the published roadmap page was a shell
 * with no content in it — 16 KB against 73 KB for `testing.html` — while every
 * job in CI stayed green. A reader following the link from the row above it got a
 * blank page.
 *
 * ## What is scanned, and what the scope is asked of
 *
 * Every markdown page under `docs/`, except the ones VitePress does not build:
 * `srcExclude` is read from `docs/.vitepress/config.ts` rather than restated
 * here, because a list copied out of a config is a list that drifts from it
 * (`readme/**` is excluded today, which is what keeps the Chinese README — a
 * GitHub page that no Vue renders — out of the scan). A config that cannot be
 * imported is a failure, not a scan of everything: the check cannot then tell a
 * page from a file that is not one, and guessing would be the check lying about
 * its own coverage.
 *
 * The glob dialect is `scripts/lib/globs.mjs`, ours rather than VitePress's. The
 * two agree on `readme/**`; a pattern this matcher cannot interpret fails the
 * run, so the direction of a disagreement is a failure to look rather than a
 * quiet exclusion of a real page.
 *
 * ## Limits
 *
 * A fence is taken to be one whose delimiter starts within three spaces of the
 * line start, per CommonMark; a fence nested inside a list item and indented
 * further than that would be read as prose and its braces would fail this check.
 * That is a false positive, and the message says so. A Vue render error from any
 * cause other than interpolation — a component reference, a bad `v-if` — is not
 * covered here and is not covered anywhere else either: the build logs it and
 * still exits 0. This checks the one cause that has been observed.
 */

const DOCS_DIR = path.join(REPO_ROOT, "docs");
const CONFIG = path.join(DOCS_DIR, ".vitepress", "config.ts");

/** Directories under `docs/` that hold no pages. `.vitepress` is the config. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".vitepress"]);

/**
 * A fenced block's delimiter, or `undefined`.
 *
 * CommonMark allows up to three spaces of indentation; four make an indented code
 * block instead, which VitePress does not escape, so the distinction is
 * load-bearing rather than tidiness.
 */
const fenceDelimiter = (line) => {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  return match === null ? undefined : { char: match[1][0], length: match[1].length };
};

/**
 * Every `{{` on one line that no `v-pre` element encloses.
 *
 * Two things are tracked at once, because they are not the same thing and only
 * one of them decides what protects a brace:
 *
 *   - **Inline code spans**, as CommonMark reads them: a run of N backticks opens
 *     one and a run of exactly N closes it. A tag written *inside* a span is not
 *     an element at all — markdown-it escapes it, and it renders as the text
 *     `<span v-pre>` while protecting nothing. This is not hypothetical: the first
 *     version of this check read the raw line and accepted
 *     `` `<span v-pre>`${{ a() }}`</span>` ``, in which the leading backtick makes
 *     the opening tag the *contents of a code span*, so the interpolation was
 *     compiled and the page threw. The scanner had the hole the documentation
 *     beside it warned about, and only authoring that documentation found it.
 *   - **`v-pre` elements** opened by tags outside a code span, tracked as a stack
 *     on the line: markdown prose opens and closes one in a line, and a rule that
 *     followed one across lines would have to model block structure this check
 *     does not own.
 *
 * A brace inside a code span is still a violation — measured: `` `{{ name }}` ``
 * renders as nothing — so the code-span state decides only whether a *tag* counts.
 */
const bracesOn = (line) => {
  const found = [];
  const open = [];
  let index = 0;
  let codeSpan = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    const ticks = /^`+/u.exec(rest);
    if (ticks !== null) {
      // A run of exactly the opening length closes the span; any other length is
      // literal backticks inside it.
      if (codeSpan === 0) codeSpan = ticks[0].length;
      else if (ticks[0].length === codeSpan) codeSpan = 0;
      index += ticks[0].length;
      continue;
    }
    if (rest.startsWith("{{")) {
      if (open.length === 0) found.push(index);
      index += 2;
      continue;
    }
    if (codeSpan === 0) {
      const opened = /^<([A-Za-z][\w.-]*) v-pre\s*>/u.exec(rest);
      if (opened !== null) {
        open.push(opened[1]);
        index += opened[0].length;
        continue;
      }
      const closed = /^<\/([A-Za-z][\w.-]*)>/u.exec(rest);
      if (closed !== null) {
        const at = open.lastIndexOf(closed[1]);
        if (at !== -1) open.length = at;
        index += closed[0].length;
        continue;
      }
    }
    index += 1;
  }
  return found;
};

/** Every `{{` outside a fence and outside a `v-pre` element, with its line. */
const scan = (text) => {
  const findings = [];
  let fence;
  text.split("\n").forEach((line, index) => {
    const delimiter = fenceDelimiter(line);
    if (delimiter !== undefined) {
      // A delimiter inside an open fence closes it, provided it is the same
      // character and at least as long. Fence lines hold no prose, so neither
      // case is scanned.
      if (fence === undefined) fence = delimiter;
      else if (delimiter.char === fence.char && delimiter.length >= fence.length) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    // One finding per line, because the line is what a reader has to fix.
    if (bracesOn(line).length > 0) findings.push({ line: index + 1, text: line.trim() });
  });
  return findings;
};

/**
 * The rule's own controls.
 *
 * Each case is what the measurements in the header produced, so the rule is pinned
 * to observed behaviour rather than to a reading of the documentation — and the
 * cases that pass are here beside the ones that must fail, because a scanner that
 * reported nothing at all would satisfy the failing half. Several of the passing
 * cases exist only to hold a mechanism down: the fence, a `v-pre` span that stops
 * at its own closing tag, a tag inside a code span, an escaped tag.
 */
const FIXTURES = [
  { name: "inline code with braces", text: "Inline `{{ name }}` here.", findings: 1 },
  { name: "inline code, dollar form", text: "Inline `${{ name }}` here.", findings: 1 },
  { name: "inline code calling a name", text: "Inline `${{ name() }}` here.", findings: 1 },
  {
    name: "an indented block, which is not a fence",
    text: "Text:\n\n    {{ name }}\n",
    findings: 1,
  },
  { name: "an interpolation with no closing sign", text: "Inline `{{ name` here.", findings: 1 },
  { name: "prose without braces", text: "No braces here.", findings: 0 },
  {
    name: "a lone closing brace, which Vue leaves alone",
    text: "Inline `total }}` here.",
    findings: 0,
  },
  { name: "inside a fence", text: "Text:\n\n```\n{{ name }}\n```\n", findings: 0 },
  { name: "inside a four-backtick fence", text: "````\n{{ name }}\n````\n", findings: 0 },
  { name: "inside a tilde fence", text: "~~~\n{{ name }}\n~~~\n", findings: 0 },
  { name: "inside a `v-pre` span", text: "Here: <span v-pre>`{{ name }}`</span>.", findings: 0 },
  {
    name: "a `v-pre` span does not cover the rest of the line",
    text: "Here: <span v-pre>`{{ a }}`</span> and <span>not here `{{ b }}`</span>.",
    findings: 1,
  },
  {
    // The shape this check itself shipped with: the backtick before the tag makes
    // the tag the contents of a code span, so markdown-it escapes it and Vue
    // compiles the interpolation anyway. `v-pre` on the line is not enough.
    name: "a tag inside a code span protects nothing",
    text: "Own `<span v-pre>`{{ a() }}`</span>` here.",
    findings: 1,
  },
  {
    name: "an escaped tag is not an element either",
    text: "Own &lt;span v-pre&gt;`{{ a() }}`&lt;/span&gt; here.",
    findings: 1,
  },
  {
    name: "backticks inside a span do not end it early",
    text: "Here: <span v-pre>`` `{{ a }}` ``</span>.",
    findings: 0,
  },
];

const checkFixtures = () => {
  const wrong = [];
  for (const fixture of FIXTURES) {
    const found = scan(fixture.text).length;
    if (found !== fixture.findings) {
      wrong.push(
        `  ${fixture.name}: expected ${String(fixture.findings)} finding(s), got ${String(found)}`,
      );
    }
  }
  if (wrong.length > 0) {
    console.error("The rule itself is not behaving as measured:\n");
    console.error(wrong.join("\n"));
    process.exit(2);
  }
};

const collect = async (directory, found = []) => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await collect(path.join(directory, entry.name), found);
    } else if (entry.name.endsWith(".md")) {
      found.push(path.join(directory, entry.name));
    }
  }
  return found;
};

/** The pages VitePress builds: every markdown file the config does not exclude. */
const pagesOf = async () => {
  let excluded;
  try {
    const { default: config } = await import(pathToFileURL(CONFIG).href);
    excluded = config.srcExclude ?? [];
  } catch (error) {
    console.error(
      `Cannot read ${path.relative(REPO_ROOT, CONFIG)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "This check asks that config which files are pages. Without the answer a page and a file",
    );
    console.error("VitePress never builds are the same thing, and either reading is a guess.");
    process.exit(2);
  }
  const patterns = excluded.map((pattern) => {
    try {
      return globToRegExp(pattern);
    } catch (error) {
      console.error(`Cannot interpret the srcExclude pattern '${pattern}': ${String(error)}`);
      console.error("Excluding nothing is a failure here: an unread policy is not an absent one.");
      process.exit(2);
    }
  });

  const all = (await collect(DOCS_DIR)).sort();
  const pages = all.filter((file) => {
    const relative = path.relative(DOCS_DIR, file).split(path.sep).join("/");
    return !patterns.some((pattern) => pattern.test(relative));
  });
  return { pages, skipped: all.length - pages.length };
};

checkFixtures();

const { pages, skipped } = await pagesOf();

const failures = [];
for (const page of pages) {
  const findings = scan(await readFile(page, "utf8"));
  if (findings.length === 0) continue;
  failures.push(
    [
      `${path.relative(REPO_ROOT, page).split(path.sep).join("/")}:`,
      ...findings.map((finding) => `  ${String(finding.line)}: ${finding.text}`),
    ].join("\n"),
  );
}

if (failures.length > 0) {
  console.error("A docs page would not render the text it is written as.\n");
  for (const failure of failures) console.error(`${failure}\n`);
  console.error(
    [
      "Vue reads `{{ … }}` as an interpolation, and the docs are VitePress pages, so this is code",
      "rather than prose. What a reader gets depends on the expression: `{{ name }}` renders as",
      "nothing and takes its own text with it, `{{ name() }}` fails the page's whole render —",
      "which VitePress logs and then exits 0 on, publishing an empty page.",
      "",
      "One of these says what you mean:",
      "  - wrap it:  <span v-pre>`${{ !cancelled() }}`</span>",
      "  - fence it: a ``` block is wrapped in `v-pre` for you. An *indented* block is not, so",
      "    indenting it is not a way out of this",
      "  - or write the sentence without braces",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `docs interpolation: ${String(pages.length)} page(s) scanned, ${String(skipped)} skipped by srcExclude — no unescaped braces in a page`,
);
