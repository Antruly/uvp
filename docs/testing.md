# Testing

uvp's tests are organised around what they need in order to run, not around the
directory the code lives in. The distinction that does the most work is **source
tests** against **built tests**.

## Source tests

These import from `src/` directly and run with no build step.

| Project       | Covers                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| `domain`      | Evidence, unknown, errors, result algebra, identity, features                   |
| `services`    | Application workflows against fake providers                                    |
| `adapters`    | Contract schemas, CLI registration, MCP registration                            |
| `composition` | Wiring: the right provider reaches the right service                            |
| `conformance` | Rules that span files — layering, generated-file freshness, effect declarations |

`services` is the project Stryker mutates. It is where the interesting logic
lives and where a mutation is likely to be a real behavioural difference rather
than a formatting change.

## Built tests

These require `npm run compile` to have run first. They exercise the artifacts
that ship: the CLI as a process, the MCP server as a process, the packaged
tarball.

| Project            | Covers                                                       |
| ------------------ | ------------------------------------------------------------ |
| `boundary`         | Import-surface rules across built output                     |
| `cli-boundary`     | The CLI driven as a subprocess                               |
| `process-boundary` | Process supervision: start, readiness, stop, orphans         |
| `mcp-boundary`     | The MCP server over real stdio                               |
| `toolchain`        | Real CMake and real libuvcpp                                 |
| `acceptance`       | End-to-end describe → build → run → verify                   |
| `process-global`   | Tests that mutate global state, isolated so they cannot leak |

`toolchain` is serial (`maxWorkers: 1`, `fileParallelism: false`) because it
configures and compiles real CMake projects, and two of those at once on one
machine is slower and flakier than running them in sequence.

## The toolchain project

This is the one that can tell you whether uvp works, as opposed to whether its
logic is self-consistent. It **skips** when libuvcpp is not found rather than
failing: a developer without libuvcpp should get a green run with a clear skip,
not a red one they learn to ignore.

When libuvcpp _is_ present, the test:

1. runs `uvp doctor` and asserts the reported version is at or above the floor,
2. generates each of the five templates,
3. configures and compiles each one,
4. starts each one **on its own port** and waits for readiness,
5. drives a real request and asserts on the response,
6. stops it and asserts the process is gone.

Each template gets a distinct port (8090–8094 in the reference run). Sequential
probes sharing one port was the cause of a long-standing intermittent failure
that looked like a flaky server and was actually a previous test's socket still
in `TIME_WAIT`.

The verified output of that pass, against libuvcpp 1.7.0:

```
### hello-http      :8090 -> {"message":"Hello, AI"}
### rest-api        :8091 -> {"id":"1","value":"first"}
### websocket-echo  :8092 -> HTTP/1.1 101 Switching Protocols
### soap-service    :8093 -> <?xml version="1.0" encoding="utf-8"?><soap:Envelope …
### static-files    :8094 -> <!doctype html>
```

This list is the project's self-proof. If it stops being true, nothing else in
the test suite is worth much.

### Writing against real libuvcpp

`tests/toolchain/realLibuvcppWorkspace.ts` is the shared helper: it locates the
install, creates a scratch workspace under `TMPDIR`, builds it, and cleans up. It
is a `knip` entry point because it is imported only by tests that skip, so a
static analysis pass would otherwise call it dead code.

Two rules for tests in this project:

**Never write into the repository.** Scratch workspaces go under the system
temporary directory, canonicalised through `realpathSync` because on macOS
`/tmp` is a symlink and CMake reports a source-directory mismatch if you hand it
both spellings. That exact mismatch — a stale copied `build/` and a
`CMakeCache.txt` recording a different source directory — has wasted an
afternoon before.

**A skipped test says why.** `describe.skipIf(!libuvcpp)` with the reason in the
describe name. A silent skip and a passing test look identical in a summary.

## Coverage

| Scope              | Statements | Branches | Functions | Lines |
| ------------------ | ---------- | -------- | --------- | ----- |
| All source         | 65         | 60       | 60        | 68    |
| `src/domain/**`    | 80         | 75       | 75        | 80    |
| `src/contracts/**` | 85         | 80       | 80        | 85    |

`domain` and `contracts` are held higher because they are pure and cheap to test
exhaustively. The global threshold is deliberately unheroic: a number high enough
to require testing trivia is a number that gets an `/* istanbul ignore */`
comment instead.

Thresholds are zeroed under `--shard=`, because a shard measures a fraction of
the code and would fail every time.

## Mutation testing

```bash
npm run test:mutation
```

Stryker runs weekly and on dispatch, never on the critical path of a pull
request. It mutates:

`src/application/assertions.ts`, `src/application/ToolchainProvider.ts`,
`src/application/evidenceHelpers.ts`, `src/domain/{evidence,unknown,errors,result}.ts`,
`src/application/workspaceManifest.ts`.

`coverageAnalysis: "perTest"` with `related: true`, so a mutation re-runs only
the tests that covered it.

**There is no break threshold.** `thresholds.break` is `null` on purpose. A
mutation score that gates a merge invites two bad responses: writing tests that
kill mutants rather than find bugs, and nudging the threshold. The score is
reported, the survivors are listed, and a human decides.

The summary script exits non-zero when the report is **missing** — a run that
produced no report is not a clean sweep, and treating it as one is how a broken
mutation job goes unnoticed for a month.

## The rules the test suite enforces

Some of these are tests, some are lint. Both fail a build.

**Layering.** `no-restricted-imports` in `.oxlintrc.json`: `src/domain/` may not
import from `application`, `contracts`, `toolchains`, or the adapters;
`src/contracts/` may import from `domain` and nothing above it.

**Test discovery.** `npm run verify:test-discovery` fails if a `*.test.ts` file
on disk is not claimed by any project. A test file that runs in no project is a
test that silently is not running, which is worse than one that fails.

**Generated files.** The tool catalog, package metadata, skill metadata, and
error schema are generated from source. CI regenerates them and fails on a diff,
so a stale generated file is a build failure rather than a review comment.

**Effect declarations.** A tool description containing "write", "create",
"scaffold", "request", "probe", "build", "run" and the like while the matching
effect is declared `false` is flagged. The description is usually written first
and the effects block filled in second, which is exactly how they drift.

**Examples.** Every `examples[]` entry must satisfy its own `inputSchema`.

## Commands

```bash
npm run test:fast         # source projects, no build step
npm run compile           # build first
npm run test:built        # built projects
npm test                  # everything
npm run test:toolchain    # only the real-libuvcpp project
npm run test:mutation     # Stryker
npm run check:ci          # lint, format check, knip, jscpd, typecheck
```

`test:fast` is what you run while working. `test:built` is what CI shards three
ways.

## Dead code, duplication, and formatting

**knip** finds exports nothing imports, dependencies nothing uses, and files
nothing reaches. All ten rules are errors. Two allowances are explicit rather
than implicit: the toolchain test helper above, and the external binaries uvp
looks for (`cmake`, `ninja`, `g++`, …) which are invoked through `PATH` and would
otherwise be reported as missing dependencies.

**jscpd** flags duplication at threshold 3.5, minimum 5 lines and 50 tokens. The
threshold is a smell detector, not a refactoring mandate — some duplication is
clearer than the abstraction that removes it, and the report is read by a person.

**oxfmt** at `printWidth: 100`, with `sortImports` and `sortPackageJson` off.
Import order is a review conversation, not a formatter's decision.

## Next

- [Releasing](releasing.md) — how a release is cut
- [Architecture](architecture.md) — the layers the rules protect
