/**
 * Mutation testing.
 *
 * Mutation testing answers a question coverage cannot: does the suite notice
 * when the code is wrong? uvp's evidence model has a specific failure mode that
 * a coverage number actively hides — a fallback that turns "I could not look"
 * into a confident yes or no still executes every line, so it is fully covered
 * and wrong. Mutation is the check that catches it.
 *
 * Scope is deliberate. Mutating the adapter layer would mostly measure the host:
 * a mutant that changes a CMake flag produces a build failure, not a test
 * failure, and the run costs minutes per mutant. The targets below are the pure
 * decision logic — assertions over a real exchange, the feature assessment that
 * decides what a libuvcpp build provides, and the coverage algebra — where a
 * surviving mutant is a genuine gap and the suite runs in milliseconds.
 */
const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/typescript-checker", "@stryker-mutator/vitest-runner"],
  vitest: {
    configFile: "vitest.config.ts",
    project: "services",
    related: true,
  },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  typescriptChecker: {
    // Accurate type checking per mutant roughly doubles the run for a
    // compile-heavy project, and the suite already fails on a type error.
    prioritizePerformanceOverAccuracy: true,
  },
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
    // the `services` suite this runner is scoped to, and a score that counted
    // them would be measuring the runner's scope rather than the tests.
    "src/application/bundleDiff.ts",
    // Evidence and unknown semantics.
    "src/domain/evidence.ts",
    "src/domain/unknown.ts",
    "src/domain/errors.ts",
    "src/domain/result.ts",
    // Manifest reading, where a malformed input must degrade to "unknown"
    // rather than to a wrong answer.
    "src/application/workspaceManifest.ts",
  ],
};

export default config;
