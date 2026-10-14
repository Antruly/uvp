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

/** Path prefixes and the lanes they select. First match wins per file. */
const LANE_RULES = [
  {
    lane: "code",
    test: (path) => path.startsWith("src/"),
  },
  {
    lane: "code",
    test: (path) => path.startsWith("tests/"),
  },
  {
    lane: "code",
    test: (path) => path.startsWith("scripts/"),
  },
  {
    lane: "code",
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
  {
    // The generated C++ and the mapping behind it. These select the real
    // toolchain lane even though they are ordinary source files, because the
    // only proof that a template works is compiling and running it.
    lane: "toolchain",
    test: (path) => path === "src/application/templates.ts",
  },
  {
    lane: "toolchain",
    test: (path) => path === "src/application/ToolchainProvider.ts",
  },
  {
    lane: "toolchain",
    test: (path) => path.startsWith("src/toolchains/"),
  },
  {
    lane: "toolchain",
    test: (path) => path.startsWith("tests/toolchain/"),
  },
  {
    lane: "package",
    test: (path) => path.startsWith("scripts/uvp.mjs"),
  },
  {
    lane: "package",
    test: (path) => path.startsWith("server.json"),
  },
  {
    lane: "docs",
    test: (path) => path.startsWith("docs/"),
  },
  { lane: "docs", test: (path) => path.startsWith("README") },
  { lane: "docs", test: (path) => path.startsWith(".agents/skills/") },
  { lane: "workflows", test: (path) => path.startsWith(".github/") },
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
    const rule = LANE_RULES.find((candidate) => candidate.test(normalized));
    lanes.add(rule ? rule.lane : "code");
  }
  return lanes;
};

const main = () => {
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
