#!/usr/bin/env node
/**
 * Decide which verification lanes a change selects.
 *
 * The rule this file exists to enforce: **a lane is selected by what a change
 * can break, not by which files it happens to touch.** A README edit does not
 * need the C++ toolchain lane; a change to the feature-to-CMake mapping does,
 * because a wrong switch name builds a library without the module and the
 * failure surfaces only when a generated project is compiled.
 *
 * Outputs are written to `GITHUB_OUTPUT` when present, and printed otherwise so
 * the script can be run by hand while diagnosing a plan.
 *
 * Environment:
 *   BASE_SHA, HEAD_SHA   the range to classify
 *   CI_FULL              "true" to select every lane regardless of the diff
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * The lanes a matching change selects.
 *
 * **Every rule that matches contributes its lanes**, rather than the first match
 * winning. That is the whole reason the shape is `lanes` and not `lane`: a file
 * that can break two things has to be able to select two lanes, and under a
 * first-match-wins table it could not. The table was one until this was written,
 * and the effect was not a smaller diff — it was that every `toolchain` entry
 * below was unreachable, because `src/application/templates.ts` is matched by
 * `src/` and `tests/toolchain/` by `tests/` first. The real-libuvcpp lane, the
 * one that compiles a generated project, was therefore never selected by a
 * change to the template that generates it. A rule a reader can see and a plan
 * that ignores it is worse than no rule.
 *
 * The default, when nothing matches, is `code`: a file this table has never
 * heard of is more likely to be TypeScript than to be documented prose, and the
 * cost of the wrong guess is one extra lane rather than a silent gap.
 */
const LANE_RULES = [
  // The ordinary source, and the reason a rule's lanes are a list: the entries
  // below that also match `src/` files contribute their own lane alongside this
  // one rather than replacing it.
  { lanes: ["code"], test: (path) => path.startsWith("src/") },
  {
    // The generated C++ and the mapping behind it. These select the real
    // toolchain lane as well as `code`, because the only proof that a template
    // works is compiling and running it — and the TypeScript that emits it still
    // has to typecheck.
    lanes: ["toolchain"],
    test: (path) => path === "src/application/templates.ts",
  },
  { lanes: ["toolchain"], test: (path) => path === "src/application/ToolchainProvider.ts" },
  { lanes: ["toolchain"], test: (path) => path.startsWith("src/toolchains/") },
  { lanes: ["code"], test: (path) => path.startsWith("tests/") },
  { lanes: ["toolchain"], test: (path) => path.startsWith("tests/toolchain/") },
  {
    // The probe's own C++. It is compiled by hand and never by the Node test
    // run, so without this rule an edit to an exchange handler selects only the
    // `code` lane — which lints TypeScript and would report a clean pass about a
    // file it never read. The lanes that can catch a broken probe are the ones
    // that build it and run it against a generated service.
    lanes: ["toolchain"],
    test: (path) => path.startsWith("native/"),
  },
  { lanes: ["code"], test: (path) => path.startsWith("scripts/") },
  {
    // This script configures and compiles the probe, so a wrong libuvcpp option
    // here is a probe that does not build — and the `code` lane cannot see that,
    // since it never runs a compiler.
    lanes: ["toolchain"],
    test: (path) => path === "scripts/build-native-probe.mjs",
  },
  {
    // The packaged entry point is both: `code` because it is a file this
    // repository's own checks read, and `package` because the packed tarball is
    // what `package-e2e` installs and speaks MCP to.
    lanes: ["package"],
    test: (path) => path.startsWith("scripts/uvp.mjs"),
  },
  { lanes: ["package"], test: (path) => path.startsWith("server.json") },
  {
    lanes: ["code"],
    test: (path) =>
      [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "tsconfig.build.json",
        "vitest.config.ts",
        "turbo.json",
        "knip.json",
        ".oxlintrc.json",
        ".oxfmtrc.json",
        ".jscpd.json",
      ].includes(path),
  },
  { lanes: ["docs"], test: (path) => path.startsWith("docs/") },
  { lanes: ["docs"], test: (path) => path.startsWith("README") },
  { lanes: ["docs"], test: (path) => path.startsWith(".agents/skills/") },
  { lanes: ["workflows"], test: (path) => path.startsWith(".github/") },
];

const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const changedFiles = (base, head) => {
  if (!base || /^0+$/u.test(base)) {
    // No usable base — a new branch's first push, or a force-push whose ancestor
    // is gone. Classify as everything rather than as nothing: an unknown diff is
    // not an empty one.
    return undefined;
  }
  try {
    const output = run("git", ["diff", "--name-only", `${base}...${head}`]);
    return output.length === 0 ? [] : output.split("\n");
  } catch {
    return undefined;
  }
};

const classify = (files) => {
  const lanes = new Set();
  for (const file of files) {
    const normalized = file.replace(/^\.\//u, "");
    const matched = LANE_RULES.filter((candidate) => candidate.test(normalized));
    // No `.find`, and no default per rule: every match counts, and a file no
    // rule knows is `code`.
    if (matched.length === 0) lanes.add("code");
    for (const rule of matched) for (const lane of rule.lanes) lanes.add(lane);
  }
  return lanes;
};

/**
 * What the table above is supposed to do, checked against the table itself.
 *
 * The bug this exists for is the one that is invisible from a single run: a rule
 * that reads correctly and never fires, because a broader rule above it took the
 * file. Nothing in a plan's own output would say so — the lanes it printed would
 * look deliberate, and the lane that was missing is the one nobody asked for.
 * So the expectations are named here as paths, and a rule that stops being
 * reachable fails the plan rather than quietly narrowing the verification.
 *
 * These are claims about *selection*, not about what a lane does; the lanes
 * themselves are `ci.yml`'s business.
 */
const EXPECTED_LANES = [
  ["src/application/templates.ts", ["code", "toolchain"]],
  ["src/application/ToolchainProvider.ts", ["code", "toolchain"]],
  ["src/toolchains/native/NativeProbeRunner.ts", ["code", "toolchain"]],
  ["tests/toolchain/realToolchain.test.ts", ["code", "toolchain"]],
  ["native/uvcpp-probe/http3_exchange.cpp", ["toolchain"]],
  ["scripts/build-native-probe.mjs", ["code", "toolchain"]],
  ["scripts/uvp.mjs", ["code", "package"]],
  ["src/application/WebService.ts", ["code"]],
  ["docs/testing.md", ["docs"]],
  ["README.md", ["docs"]],
  [".github/workflows/ci.yml", ["workflows"]],
  ["LICENSE", ["code"]],
];

const checkTable = () => {
  const wrong = [];
  for (const [path, expected] of EXPECTED_LANES) {
    const actual = [...classify([path])].sort();
    if (actual.join(",") !== [...expected].sort().join(",")) {
      wrong.push(`${path}: expected ${expected.join("+")}, got ${actual.join("+") || "(none)"}`);
    }
  }
  if (wrong.length > 0) {
    process.stderr.write(
      `plan: LANE_RULES no longer selects what this file says it does:\n${wrong.map((line) => `  ${line}`).join("\n")}\n`,
    );
    process.exit(1);
  }
};

const main = () => {
  checkTable();
  const base = process.env["BASE_SHA"] ?? "";
  const head = process.env["HEAD_SHA"] ?? "HEAD";
  const forced = process.env["CI_FULL"] === "true";

  const files = forced ? undefined : changedFiles(base, head);
  const undetermined = files === undefined;

  const lanes = undetermined
    ? new Set(["code", "toolchain", "package", "docs", "workflows"])
    : classify(files);

  // The documentation lane depends on the tool catalog, which is generated from
  // the contracts. A contract change therefore selects it even when no file
  // under `docs/` moved.
  if (lanes.has("code")) lanes.add("docs");

  const outputs = {
    code: String(lanes.has("code")),
    docs: String(lanes.has("docs")),
    workflows: String(lanes.has("workflows")),
    package: String(lanes.has("package")),
    toolchain: String(lanes.has("toolchain")),
    // A full qualification runs every lane even when the diff is narrow, so that
    // a scheduled run exercises the C++ path on a quiet week.
    tier: forced || undetermined ? "full" : "fast",
    file_count: String(files?.length ?? -1),
  };

  const summary = [
    `plan: ${String(files?.length ?? "unknown")} changed file(s), tier=${outputs.tier}`,
    `lanes: ${[...lanes].sort().join(", ") || "(none)"}`,
    ...(undetermined ? ["no usable base revision; every lane selected rather than none"] : []),
  ];
  process.stderr.write(`${summary.join("\n")}\n`);

  const outputFile = process.env["GITHUB_OUTPUT"];
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (outputFile) appendFileSync(outputFile, `${body}\n`);
  else process.stdout.write(`${body}\n`);
};

main();
