/**
 * Types for `vitest-skipped-reporter.mjs`.
 *
 * Same split as `test-projects.d.mts`: the module is JavaScript so that Vitest
 * can load it as a reporter by path from a workflow step, and the config that
 * also uses it is TypeScript. This declaration is what lets `vitest.config.ts`
 * import it without either side changing language.
 *
 * The shape is deliberately the narrow part of Vitest's `Reporter` that this one
 * uses, not a copy of that interface: a copied interface drifts from the real one
 * and would claim methods this reporter does not implement.
 */

import type { TestModule } from "vitest/node";

export default class SkippedTestsReporter {
  onInit(vitest: { logger: { log(message: string): void } }): void;
  onTestRunEnd(testModules: readonly TestModule[]): void;
}
