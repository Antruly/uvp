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
 * surviving mutant is a genuine gap and the suite runs in milliseconds.
 *
 * **This configuration does not currently produce a measurement.** The
 * `vitest` runner plans every non-static mutant against the tests that covered
 * it, and vitest 5 cannot match the ids it plans with, so those mutants run
 * zero tests and are reported `Survived`. `scripts/ci/mutation-summary.mjs`
 * fails on a report of that shape rather than printing a score over it, and
 * docs/testing.md, "The score is not a measurement yet", carries the measurements
 * and the alternatives. Nothing here should be read as a working lane until that
 * section says otherwise.
 */
const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/typescript-checker", "@stryker-mutator/vitest-runner"],
  vitest: {
    // The scope is a config file rather than a project name: Stryker 10 dropped
    // `vitest.project`, and with it the config this repository had been carrying
    // since the import, which is why the sweep could not start at all.
    // `vitest.mutation.config.ts` names the two projects whose tests exercise
    // the files below, taken from the suite's own project list.
    configFile: "vitest.mutation.config.ts",
    // A mutant re-runs only the tests that covered it, which is what keeps a
    // sweep over nine modules affordable.
    related: true,
  },
  // The TypeScript checker is installed and would be the right check — it
  // refuses a mutant that does not compile, which is a survivor that measures
  // nothing. It cannot run here: TypeScript 7.0.2's JavaScript API is `version`
  // and `versionMajorMinor` alone, so the checker's tsconfig and program
  // plumbing has nothing to call. The suite fails on a type error already.
  checkers: [],
  // Core rewrites the sandbox's tsconfig through `ts.parseConfigFileTextToJson`,
  // for the same missing API, and it does that whenever this path names a file
  // the sandbox holds. It therefore names a file that is deliberately not in the
  // repository — renaming it to `tsconfig.json` crashes the run before the first
  // mutant, which is what the committed configuration did.
  tsconfigFile: "tsconfig.json.absent",
  typescriptChecker: {
    // Accurate type checking per mutant roughly doubles the run for a
    // compile-heavy project, and the suite already fails on a type error.
    prioritizePerformanceOverAccuracy: true,
  },
  // What the per-test plan would use if vitest 5 could honour it. The runner
  // returns its own coverage from the dry run regardless of this setting, so
  // "off" does not avoid the broken plan either — see docs/testing.md.
  coverageAnalysis: "perTest",
  // No break threshold. A mutation score is a signal to investigate, and a gate
  // that fails a build on a score invites mutating the score instead of the
  // tests. The mutations that survive are what get read.
  thresholds: { break: null },
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
    // the `domain` and `services` projects this runner is scoped to, and a score
    // that counted them would be measuring the runner's scope rather than the
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
