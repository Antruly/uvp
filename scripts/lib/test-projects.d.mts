/**
 * Types for `test-projects.mjs`.
 *
 * The module is JavaScript because CI reads it with plain Node, and the files it
 * describes are TypeScript because the test runner compiles them. This
 * declaration is what lets `vitest.config.ts` import it without either side
 * giving up its own language.
 */

export interface TestProject {
  /** The Vitest project name, which is also the lane name CI selects on. */
  readonly name: string;
  /** `source` runs against `src/`; `built` requires a compiled `dist/`. */
  readonly group: "source" | "built";
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

export declare const SOURCE_TEST_PROJECTS: readonly TestProject[];
export declare const BUILT_TEST_PROJECTS: readonly TestProject[];
export declare const ALL_TEST_PROJECTS: readonly TestProject[];
/** Project names that require a compiled `dist/` before they can run. */
export declare const BUILT_PROJECT_NAMES: readonly string[];
/** Project names that run against source only. */
export declare const SOURCE_PROJECT_NAMES: readonly string[];
