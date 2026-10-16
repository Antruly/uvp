/**
 * Mutation testing.
 *
 * Mutation testing answers a question coverage cannot: does the suite notice
 * when the code is wrong? uvp's evidence model has a specific failure mode that
 * a coverage number actively hides — a fallback that turns "I could not look"
 * into a confident yes or a no still executes every line, so it is fully covered
 * and wrong. Mutation is the check that catches it.
 *
 * Scope is deliberate. Mutating the adapter layer would mostly measure the host:
 * a mutant that changes a CMake flag produces a build failure, not a test
 * failure, and the run costs minutes per mutant. The targets below are the pure
 * decision logic — assertions over a real exchange, the feature assessment that
 * decides what a libuvcpp build provides, and the coverage algebra — where a
 * surviving mutant is a genuine gap and the whole group runs in about two
 * seconds — its size moves with the suite, so it is dated in `docs/testing.md`
 * rather than repeated here.
 *
 * **The runner is `command`, and that is a deliberate trade.** The `vitest`
 * runner plans every non-static mutant against the tests that covered it, and
 * vitest 5 cannot match the ids it plans with — core hands it `file#suite test`,
 * vitest matches `" > "` — so those mutants ran zero tests and were reported
 * `Survived`: 934 of 1294 in the sweep that found this, with all 199 kills
 * static. The correct repair is one separator in two copies of the dependency's
 * own helper, and applying it here would mean this repository carrying a patched
 * dependency and the machinery to keep the patch applied, which is a
 * supply-chain decision rather than a footnote to a CI bug.
 *
 * So the sweep runs the whole mutation group for every mutant and grades it by
 * exit code alone: a mutant is killed exactly when the `node scripts/run-tests.mjs
 * mutation` command exits non-zero, which is the standard criterion and the
 * `unran.length === 0` condition `scripts/ci/mutation-summary.mjs` requires. What
 * that costs is the per-test attribution, which the summary does not use, and
 * time — 1.9 s per mutant on an 18-core workstation, which projected to about 41
 * minutes and measured at **51 minutes 53 seconds** in CI on the smaller runner,
 * against the job's 90-minute limit. If a faster sweep is ever worth buying, the
 * way to buy it is the patched dependency, and that decision has not been taken.
 *
 * Two consequences of the runner change are visible elsewhere. The `vitest`
 * runner package and the TypeScript checker package were only ever referenced
 * from this file's `plugins` list, so both are gone from `package.json` rather
 * than carried unused. And `knip.json` carries `@stryker-mutator/command-runner`
 * in `ignoreDependencies`: knip's Stryker plugin reads `testRunner` as
 * `@stryker-mutator/<value>-runner`, which is right for a published runner and
 * wrong for `command`, a runner built into core that has no package to install.
 */
const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "command",
  commandRunner: {
    // The suite's own entry point, scoped to the mutation group by
    // `scripts/lib/test-projects.mjs`. `scripts/run-tests.mjs` resolves the
    // Vitest entry point and starts it through the Node already running, which
    // is what keeps this line working on a host with no `node_modules/.bin`.
    command: "node scripts/run-tests.mjs mutation",
  },
  // The TypeScript checker would be the right check — it refuses a mutant that
  // does not compile, which is a survivor that measures nothing. It cannot run
  // here: TypeScript 7.0.2's JavaScript API is `version` and `versionMajorMinor`
  // alone, so the checker's tsconfig and program plumbing has nothing to call.
  // The suite fails on a type error already.
  checkers: [],
  // Core rewrites the sandbox's tsconfig through `ts.parseConfigFileTextToJson`,
  // for the same missing API, and it does that whenever this path names a file
  // the sandbox holds. It therefore names a file that is deliberately not in the
  // repository — renaming it to `tsconfig.json` crashes the run before the first
  // mutant, which is what the committed configuration did.
  tsconfigFile: "tsconfig.json.absent",
  // Seventy, about three points under the measured baseline: the first full
  // sweep reported 73.15% over 1281 mutants, and this lane's noise — a flaky
  // kill, a mutant that times out instead of dying, the difference between this
  // host and the CI runner — is smaller than that. It is a floor, not a target,
  // and it gates a weekly run rather than a merge, which is what the old
  // "no threshold" reasoning was actually about: a gate that stands between a
  // person and `main` invites mutating the score instead of the tests, while a
  // weekly run that trips the floor produces a failed workflow and a report to
  // read, which is what the lane is for. Expected to move: it is one
  // measurement, and it is re-derived once several weekly numbers exist, and
  // again from the first sweep under a runner that attributes per test (#41),
  // since the `command` runner's exit-code grading makes today's score an upper
  // bound (#42). The sweep is a canary and never a per-PR gate — see
  // docs/testing.md#mutation-testing.
  thresholds: { break: 70 },
  ignorePatterns: ["/coverage/**", "/.cache/**", "/tests/toolchain/workspaces/**"],
  concurrency: 2,
  timeoutMS: 30000,
  reporters: ["clear-text", "progress", "html", "json"],
  jsonReporter: { fileName: "reports/mutation/uvp.json" },
  htmlReporter: { fileName: "reports/mutation/uvp.html" },
  mutate: [
    // The assertion algebra: every operator here decides whether a service is
    // reported as behaving correctly. An inverted comparison is the single most
    // consequential mutation in the project.
    "src/application/assertions.ts",
    // The feature assessment: decides whether a requested module was found,
    // absent, or could not be determined. The three-way split is the point, and
    // a mutant that collapses it must not survive.
    "src/application/ToolchainProvider.ts",
    // The coverage and evidence algebra.
    "src/application/evidenceHelpers.ts",
    // The bundle comparison: pure decisions over two parsed reports, where the
    // mutations that matter are the ones that turn "I could not compare these"
    // into a yes or a no. `bundleFile.ts` is deliberately absent: it reads a file,
    // so most of its mutants are decided by the conformance lane rather than by
    // the `domain` and `services` projects the mutation group covers, and a score
    // that counted them would be measuring the group's scope rather than the
    // tests.
    "src/application/bundleDiff.ts",
    // Evidence and unknown semantics.
    "src/domain/evidence.ts",
    "src/domain/unknown.ts",
    "src/domain/errors.ts",
    // Manifest reading, where a malformed input must degrade to "unknown"
    // rather than to a wrong answer.
    "src/application/workspaceManifest.ts",
  ],
};

export default config;
