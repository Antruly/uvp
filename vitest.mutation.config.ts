import { defineConfig } from "vitest/config";
import type { TestProjectConfiguration, TestProjectInlineConfiguration } from "vitest/config";

import suite from "./vitest.config.js";

/**
 * The test surface a mutation run needs, which is smaller than the suite's.
 *
 * Stryker mutates the pure decision modules — the assertion algebra, the
 * feature assessment, the coverage and evidence algebra, the bundle comparison,
 * the manifest reader — and their tests live in two projects: `services`
 * (`src/application/**`) and `domain` (`src/{contracts,domain}/**`). The other
 * projects are the ones that build real C++ and open real sockets. A mutant in a
 * pure module does not change what they decide, and running them once per mutant
 * would turn a sweep measured in milliseconds per mutant into one measured in
 * minutes, which is the cost the runner's scope note is about.
 *
 * Until Stryker 10 the runner took that scope as a project name
 * (`vitest: { project: "services" }`); 10.0.0 removed the option and takes a
 * config file instead, so the scope is expressed here. The config it named was
 * invalid from the import onward — `additionalProperties: false` rejects
 * `project` — which is why `stryker run` could not start at all.
 *
 * The projects are filtered out of the suite's own config rather than restated.
 * `scripts/lib/test-projects.mjs` is what decides which files are in `domain`
 * and which are in `services`, and a second copy of those globs here is how a
 * mutation run and the lane it is measuring stop asking the same question.
 * Inheriting also inherits the runner policy — the pools, the worker bound, the
 * canonical `TMPDIR` — so a mutant meets the suite's conditions rather than a
 * second set of them.
 */

/** The projects a mutated file's tests can be in, by the suite's own names. */
const MUTATED_SURFACE: ReadonlySet<string> = new Set(["domain", "services"]);

// A project may be written inline, named by path, or deferred behind a promise
// or a function; only the inline form carries a name here to read, and the suite
// writes its projects that way. Narrowing is what lets the filter below ask the
// suite's own project list rather than a list restated beside it.
const isInlineProject = (
  project: TestProjectConfiguration,
): project is TestProjectInlineConfiguration =>
  typeof project === "object" && project !== null && "test" in project;

// `test.name` is either the name or a `{ label }` object that carries it. The
// suite writes the first; reading both is what keeps this file honest about the
// type instead of casting past it.
const projectName = (test: TestProjectInlineConfiguration["test"]): string | undefined => {
  const name = test?.name;
  return typeof name === "string" ? name : name?.label;
};

const projects = (suite.test?.projects ?? []).filter((project) => {
  if (!isInlineProject(project)) return false;
  const name = projectName(project.test);
  return name !== undefined && MUTATED_SURFACE.has(name);
});

// A mutation run that selects nothing would report every mutant as surviving,
// which reads exactly like a suite that notices nothing. Say so instead.
if (projects.length !== MUTATED_SURFACE.size) {
  throw new Error(
    `vitest.mutation.config.ts found ${String(projects.length)} of the ${String(MUTATED_SURFACE.size)} projects it mutates. ` +
      "The name it could not find is the scope this file is: see scripts/lib/test-projects.mjs.",
  );
}

export default defineConfig({
  test: {
    ...suite.test,
    projects,
    // Stryker measures per-test coverage itself, and Stryker sets its own
    // `coverage.enabled: false` over this config anyway. Stated here so the
    // file does not read as though a threshold were in play.
    coverage: { ...suite.test?.coverage, enabled: false },
    // The suite's second reporter names every skipped test and its reason,
    // once per lane. Under Stryker the suite runs once per mutant, so that
    // summary would be printed a hundred times and read by nobody: the mutant
    // report is what a reader of this run needs.
    reporters: ["default"],
  },
});
