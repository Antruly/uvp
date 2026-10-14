import { realpathSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

import { BUILT_TEST_PROJECTS, SOURCE_TEST_PROJECTS } from "./scripts/lib/test-projects.mjs";

/**
 * The test surface.
 *
 * Two axes matter here, and they are independent.
 *
 * The first is **depth**: a source project proves a module's semantics, a
 * composition project proves the wiring, and a built project proves that a real
 * CLI invocation or MCP session works. Those are not interchangeable. A build
 * workflow that passes with an injected toolchain establishes the boundary, not
 * that a compiler on this host behaves as expected — so the lanes that need a
 * real libuvcpp live apart from the ones that do not, and skip with a named
 * reason rather than passing when the substrate is missing.
 *
 * The second is **isolation**. Projects whose modules own no process-global
 * state share a module graph; projects that open sockets, spawn processes, or
 * read the clock get their own. The rule of thumb: if a file's result can depend
 * on what another file did first, it needs the isolation.
 */

// A symlinked temporary directory (`/tmp` on macOS) produces two different
// strings for the same path, and a test that compares a resolved path with an
// unresolved one fails for a reason that has nothing to do with the code.
const CANONICAL_TEMPORARY_DIRECTORY = realpathSync(tmpdir());

const COVERAGE_ENABLED = process.argv.some((argument) => argument.startsWith("--coverage"));
const COVERAGE_SHARD = process.argv.some((argument) => argument.startsWith("--shard="));

// Real builds, real sockets, and real process supervision contend for the same
// cores. Keep the runner bounded rather than letting Vitest size itself to the
// host and then time out under its own load.
const MAX_TEST_WORKERS = Math.min(4, availableParallelism());

const TEST_PROJECTS = [...SOURCE_TEST_PROJECTS, ...BUILT_TEST_PROJECTS];

const PROJECT_POLICIES = {
  domain: {
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Domain modules are pure and own no process-global state, so per-file
    // module isolation costs startup time without protecting a seam.
    isolate: false,
  },
  services: {
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    isolate: false,
  },
  adapters: { pool: "forks" as const, maxWorkers: MAX_TEST_WORKERS },
  composition: {
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    isolate: false,
  },
  conformance: {
    pool: "threads" as const,
    maxWorkers: MAX_TEST_WORKERS,
    isolate: false,
  },
  boundary: { pool: "forks" as const, maxWorkers: MAX_TEST_WORKERS },
  "cli-boundary": {
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    isolate: false,
    // Long-lived workers should collect temporary command and schema
    // allocations before their heaps compete with the CLI child processes.
    execArgv: ["--max-old-space-size=384"],
  },
  "mcp-boundary": {
    pool: "forks" as const,
    maxWorkers: MAX_TEST_WORKERS,
    // Each file drives one `uvp mcp` child over real stdio and owns nothing
    // process-global itself, so the module graph is immutable across files — but
    // the children are not, and a forked worker keeps their stdio and signals out
    // of the runner's own thread pool.
    isolate: false,
  },
  toolchain: {
    pool: "forks" as const,
    maxWorkers: 1,
    // This lane compiles real C++ with a real CMake, and concurrent builds
    // compete for the same compiler cache and the same disk. Serial is faster
    // here, not slower.
    fileParallelism: false,
  },
  acceptance: { pool: "forks" as const, maxWorkers: MAX_TEST_WORKERS },
  // Supervises real child processes and signals them, so files must not share a
  // module graph: a `SIGTERM` handler installed by one file would still be
  // installed when the next one runs.
  "process-boundary": { pool: "forks" as const, maxWorkers: 1, fileParallelism: false },
  "process-global": { pool: "forks" as const, maxWorkers: MAX_TEST_WORKERS },
};

const ZERO_COVERAGE_THRESHOLDS = {
  statements: 0,
  branches: 0,
  functions: 0,
  lines: 0,
  "src/domain/**": { statements: 0, branches: 0, functions: 0, lines: 0 },
  "src/contracts/**": { statements: 0, branches: 0, functions: 0, lines: 0 },
};

const projects = TEST_PROJECTS.map((project) => {
  const policy = PROJECT_POLICIES[project.name as keyof typeof PROJECT_POLICIES];
  if (!policy) throw new Error(`Missing test runner policy for ${project.name}`);
  return {
    extends: true as const,
    test: {
      name: project.name,
      include: [...project.include],
      ...(project.exclude ? { exclude: [...project.exclude] } : {}),
      ...policy,
    },
  };
});

export default defineConfig({
  test: {
    env: { TMPDIR: CANONICAL_TEMPORARY_DIRECTORY },
    maxWorkers: MAX_TEST_WORKERS,
    projects,
    retry: 0,
    reporters: ["default"],
    // A real CMake configure plus compile is slow on a cold cache and fast on a
    // warm one. The deadline is set for the cold case; the lane that actually
    // builds is serial and few.
    testTimeout: COVERAGE_ENABLED ? 90_000 : 45_000,
    hookTimeout: 45_000,
    coverage: {
      enabled: false,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `uvp-vitest-coverage-${String(process.pid)}`),
      include: ["src/**"],
      // Domain and contracts carry the semantics everything else is built on and
      // are cheap to test exhaustively. The adapters talk to real compilers and
      // sockets, where a coverage number measures the host more than the code.
      thresholds: COVERAGE_SHARD
        ? ZERO_COVERAGE_THRESHOLDS
        : {
            statements: 65,
            branches: 60,
            functions: 60,
            lines: 68,
            "src/domain/**": {
              statements: 80,
              branches: 75,
              functions: 75,
              lines: 80,
            },
            "src/contracts/**": {
              statements: 85,
              branches: 80,
              functions: 80,
              lines: 85,
            },
          },
      reporter: ["text", "text-summary"],
    },
  },
});
