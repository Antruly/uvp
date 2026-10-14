/**
 * The Vitest project split.
 *
 * Source projects run against `src/` directly and are grouped by the depth of
 * the boundary they touch. Built projects run against compiled entrypoints in
 * `dist/` and therefore require `npm run compile` first; they are the lanes that
 * actually prove a CLI invocation or an MCP session works.
 *
 * Kept in a plain `.mjs` file rather than inside `vitest.config.ts` so that CI
 * tooling can read the same list the test runner uses. A lane that exists in one
 * place and not the other is how a suite silently stops running.
 */

export const SOURCE_TEST_PROJECTS = [
  {
    name: "domain",
    group: "source",
    include: ["src/{contracts,domain}/**/*.test.ts"],
  },
  {
    name: "services",
    group: "source",
    include: ["src/application/**/*.test.ts"],
  },
  {
    name: "adapters",
    group: "source",
    include: ["src/toolchains/**/*.test.ts", "src/*.test.ts"],
  },
  {
    name: "composition",
    group: "source",
    include: ["tests/composition/**/*.test.ts"],
  },
  {
    name: "conformance",
    group: "source",
    include: ["tests/conformance/**/*.test.ts"],
  },
];

export const BUILT_TEST_PROJECTS = [
  {
    name: "boundary",
    group: "built",
    include: ["tests/boundary/**/*.test.ts"],
    exclude: [
      "tests/boundary/cli/**/*.test.ts",
      "tests/boundary/mcp/**/*.test.ts",
      "tests/boundary/process/**/*.test.ts",
    ],
  },
  {
    name: "cli-boundary",
    group: "built",
    include: ["tests/boundary/cli/**/*.test.ts"],
  },
  {
    name: "process-boundary",
    group: "built",
    include: ["tests/boundary/process/**/*.test.ts"],
  },
  {
    name: "mcp-boundary",
    group: "built",
    include: ["tests/boundary/mcp/**/*.test.ts"],
  },
  {
    name: "toolchain",
    group: "built",
    include: ["tests/toolchain/**/*.test.ts"],
  },
  {
    name: "acceptance",
    group: "built",
    include: ["tests/acceptance/**/*.test.ts"],
  },
  {
    name: "process-global",
    group: "built",
    include: ["tests/process-global/**/*.test.ts"],
  },
];

/** Every project name, for the discovery verifier and CI's lane selection. */
export const ALL_TEST_PROJECTS = [...SOURCE_TEST_PROJECTS, ...BUILT_TEST_PROJECTS];

/** Project names that require a compiled `dist/` before they can run. */
export const BUILT_PROJECT_NAMES = BUILT_TEST_PROJECTS.map((project) => project.name);

/** Project names that run against source only. */
export const SOURCE_PROJECT_NAMES = SOURCE_TEST_PROJECTS.map((project) => project.name);
