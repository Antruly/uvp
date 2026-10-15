# Testing

uvp's tests are organised around what they need in order to run, not around the
directory the code lives in. The distinction that does the most work is **source
tests** against **built tests**.

## Source tests

These import from `src/` directly and run with no build step.

| Project       | Covers                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| `domain`      | Evidence, unknown, errors, result algebra, identity, features              |
| `services`    | Application workflows against fake providers                               |
| `adapters`    | Contract schemas, CLI registration, MCP registration                       |
| `composition` | Wiring: the right provider reaches the right service                       |
| `conformance` | Handler output against its own contract, HTTP behaviour, the provider port |

`services` is the project Stryker mutates. It is where the interesting logic
lives and where a mutation is likely to be a real behavioural difference rather
than a formatting change.

## The conformance project

Four files, each asking one question, none of them needing a compiler.

`handlers.test.ts` calls every tool through its handler and parses the result
against the contract that describes it. The contract is the single source of
truth for the MCP server, the CLI, the generated catalog, and the shipped skill,
and that claim is worth nothing unless the implementations behind it obey it.

`httpBehaviour.test.ts` asks whether the switches in `uvp_http_request` do
anything. A client that ignored `follow_redirects`, `max_redirects`, and
`timeout_ms`, and whose timings nobody read, satisfied every other test in this
repository. It pins redirects as reported rather than followed, a loop stopped at
`max_redirects` and returned as a result, a deadline that distinguishes a wedged
service from a refused one, and a `ttfb_ms` that cannot be below the delay the
fixture itself imposed.

Writing it found a real defect, which is the point of putting the claims in one
place: on the default `http_version=auto`, a request that timed out was retried
over HTTP/2, and the retry's "Protocol error" was what reached the caller — so
`timeout` was **unreachable at the default settings** and a wedged service was
reported as an unreachable endpoint. `src/application/httpClient.ts` now
classifies each failure where it happens, retries only on a protocol mismatch,
and treats `timeout_ms` as one deadline for the whole call. Three tests in
`src/application/httpClient.test.ts` assert that from the transport's side,
including the number of connections one failed request opens.

`providerConformance.test.ts` and `providerContractFaults.test.ts` are the two
halves of one question: does a toolchain satisfy the port it is injected through?
`providerContract.ts` holds the twelve obligations every provider must meet, as
data rather than as a list of `it`s; `providerConformance.test.ts` runs them
against the scripted provider, which is the control that proves every check is
reached, and the same twelve run against the real providers — `local` in
`tests/toolchain/providerConformance.test.ts`, and the container in
`tests/toolchain/containerConformance.test.ts`, its image named by
`UVP_TEST_IMAGE`.

A provider that cannot do something skips those obligations **by name**, with the
reason in the test title, and the reason is the provider's own words rather than
this suite's guess about the host. There are two gaps rather than one because
they are different questions. `substrateGap` is about running a build: a
compiler, a CMake, and a libuvcpp. `toolchainGap` is about _looking at_ a
toolchain, which is what a libuvcpp search needs and a build does not. `local`
reports no `toolchainGap` even with no compiler installed, because it searches a
filesystem and `found: false` is a real answer it gives in the shape three
obligations check — which is exactly the shape exercised by a bare host. A
container with no runtime cannot look inside its image at all, and `LibuvcppBuild`
has no way to say "not looked", so it reports the `toolchain_unavailable` failure
instead and those three skip. Collapsing the two would either skip the
`found: false` shape on every host without libuvcpp, or claim a search had
answered when it had not.

The reason the obligations are data is `providerContractFaults.test.ts`. For each
one, `providerSubjects.ts` builds a provider that breaks _exactly_ that clause,
and the test requires two things: that the named obligation rejects it, and that
every other obligation accepts it. A check nobody has seen fail is a comment, and
a check that fires on everything localises nothing; between them those two rules
are what let a failing run be read as "this clause is the reason".

The rules that no single file owns are checked, and none of them here — worth
knowing before going to look for them. The layering rules are enforced twice:
`.oxlintrc.json` over `src/`, and `tests/boundary/importSurface.test.ts` over the
built output, because a re-export or a changed `rootDir` can satisfy the first
and violate the second. Generated files are checked by the `--check` scripts
behind `npm run docs:check`, which regenerate each one and fail on a difference.
Effect declarations are checked by `src/contracts/toolContracts.test.ts`, whose
write vocabulary and exact `network` list are described below. This section
previously described a `rules.test.ts` in this directory; no such file has ever
existed, and the four places above are where that coverage actually lives.

`handlers.test.ts` also holds the capture recording limit from both ends, in
`the recording limit`. A capture has two size limits and they are not the same
one: what it records, and what it will buffer in order to forward a body intact.
The lane drives a 4 KiB upload through a session that records 1 KiB and reads the
origin's echo back, so a change that capped the record by truncating the forward
fails the same test the other way round; reads a 100 000-byte body back in full
from a session whose limit is above it, which is the range where an undocumented
second cap at 64 KiB used to be invisible; and posts 8 MiB + 1 to a session that
will not forward it, asserting the `413` and that the refusal is in the capture
as an exchange with no status rather than as traffic that happened.

## Built tests

These require `npm run compile` to have run first. They exercise the artifacts
that ship: the CLI as a process, the MCP server as a process, the packaged
tarball.

| Project            | Covers                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ |
| `boundary`         | Import-surface rules across built output                                             |
| `cli-boundary`     | The CLI driven as a subprocess                                                       |
| `process-boundary` | Process supervision: start, readiness, stop, orphans                                 |
| `mcp-boundary`     | The MCP server over real stdio                                                       |
| `toolchain`        | Real CMake and real libuvcpp: five templates, a failing build, the provider contract |
| `acceptance`       | The whole closure through `uvp verify`, and the assertion vocabulary                 |
| `process-global`   | What a call leaves in the process it ran in, and whose session it is                 |

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

`tests/support/realLibuvcpp.ts` is the shared helper: it locates the install,
creates a scratch workspace under `TMPDIR`, builds it, runs it, ends it, and
cleans up. It talks to the published `bin.uvp` as a process and imports nothing
from `src/`, so nothing that uses it can pass because a module agreed with
itself. Two lanes use it — `toolchain`, which builds a workspace and starts the
binary itself, and `acceptance`, which goes through `uvp verify` — and it lives
in `tests/support/` rather than inside either lane so the second cannot drift
from the first.

One file in `toolchain` is not written that way, and it is the only one:
`providerConformance.test.ts` imports `LocalToolchainProvider` rather than the
CLI, because the module _is_ its subject — the question is whether a provider
satisfies the port, and a version of it that went through five adapter layers to
reach the provider would be testing something else. Everything it can establish
about the real toolchain it establishes the same way the rest of the lane does:
by compiling a real workspace with a real CMake against the libuvcpp that is
installed, and by skipping by name when this host has none.

Both lanes need to be told where libuvcpp is. `uvp doctor` searches `UVCPP_ROOT`,
`LIBUVCPP_ROOT`, `CMAKE_PREFIX_PATH`, the usual system prefixes, and
`<workspace>/third_party`, and when it finds nothing the lanes **skip with that
reason in the describe name** rather than failing. So:

```bash
LIBUVCPP_ROOT=/path/to/libuvcpp-1.7.0-linux-x64 npm run test:focused -- tests/acceptance
```

A skip is not a pass. On a host with no libuvcpp these lanes contribute no
evidence at all, and the summary says so in the name of every test that did not
run.

Two rules for tests in this project:

**Never write into the repository.** Scratch workspaces go under the system
temporary directory, canonicalised through `realpathSync` because on macOS
`/tmp` is a symlink and CMake reports a source-directory mismatch if you hand it
both spellings. That exact mismatch — a stale copied `build/` and a
`CMakeCache.txt` recording a different source directory — has wasted an
afternoon before.

**A skipped test says why.** `describe.skipIf(!libuvcpp)` with the reason in the
describe name. A silent skip and a passing test look identical in a summary.

### A build that fails

`tests/toolchain/buildFailure.test.ts` is the other half of the same claim. A
green run of five templates says the templates work; this says a workspace that
does **not** build is reported as one. Both halves serve the same caller, because
"your workspace is broken", "the library is missing", and "this tool could not
tell" are three different next steps.

It breaks a generated workspace rather than hand-writing a CMake project, so the
subject is a project uvp produced itself, and it checks one failure per phase:

| Failure            | Produced by  | What must come back                                                 |
| ------------------ | ------------ | ------------------------------------------------------------------- |
| Compile error      | the compiler | the compiler's file, line, and message                              |
| Configure error    | CMake        | CMake's own error, naming the line in the caller's `CMakeLists.txt` |
| Warning on success | CMake        | the warning, on a build that still succeeds                         |

The configure row is a regression: CMake's errors are not compiler diagnostics in
any spelling, and the parser knew only the compiler formats — so a configure
failure came back as `succeeded: false` with `diagnostics: []`, under a
limitation promising "the diagnostics below are the compiler's own output". The
formats are now parsed in `src/toolchains/local/diagnostics.ts`, one module for
all three spellings (GCC, MSVC, CMake), tested against text captured from the
real tools rather than text written to match the parser.

Two behaviours found while writing this are **recorded rather than fixed**,
because both are product decisions rather than defects in the parser:

- **A CMake error inside one of CMake's own modules names that module.** A
  `pkg_check_modules` failure reports
  `/usr/share/cmake-3.28/Modules/FindPkgConfig.cmake:619` — CMake's own answer,
  reproduced as data — while the caller's line is in the call stack below it,
  which is not scanned. The message does name the missing package, so the
  diagnostic is actionable; reporting the call site instead would be this tool's
  interpretation of which frame matters.
- **A failing rebuild still lists the previous build's binary as an artifact.**
  The compile branch discovers artifacts whether or not the compile succeeded,
  and a contract that calls these "the digests of the produced artifacts" then
  shows a non-empty `artifacts` beside `succeeded: false` — and `uvp run` will
  start that older binary. Gating the list on success is not obviously right
  either: a multi-target build that fails on the last target has produced the
  earlier ones. Distinguishing "produced now" from "already there" is a schema
  change, so the lane pins the observed behaviour instead. The configure branch
  is the other way round — it lists nothing when configure failed — so the two
  phases already disagree, which is itself part of why this is recorded rather
  than resolved here.

### The native probe, against a generated service

`tests/toolchain/nativeProbe.test.ts` answers the one question the rest of the
suite cannot: whether libuvcpp's _own_ WebSocket client can talk to a service uvp
generated. Every other WebSocket test uses a Node client, and two clients that
both claim RFC 6455 can disagree about everything the RFC leaves open — so a Node
client reaching `websocket-echo` says nothing about this one.

It has the same shape as the rest of the lane — generate, build, start, drive,
stop — with one addition: the probe is a **binary**, `uvcpp-probe`, that
`npm run build:native-probe` produces against a libuvcpp with
`UVCPP_ENABLE_CAPI=ON`. The lane does not build it, because that would make a test
run depend on a C++ compiler and a particular install; a host without it skips,
and the skip names which of the two problems it has — no libuvcpp, or no probe —
since only one of them is fixed by installing libuvcpp.

Where the probe is comes from `NativeProbeRunner.availability`, the same call the
CLI makes, rather than from a second search order written in the test; the path
it returns is passed to the child CLI as `UVP_NATIVE_PROBE`, so the test and the
tool cannot disagree about which binary answered. CI builds the probe before this
lane runs, for the same reason it installs libuvcpp at all.

All four tests in the file skip together, because all four need that binary: one
probes a generated service end to end, one reads the same run the way a person
would — without `--json`, where the stack row, the blind-spot list, and the note
about the abandoned log are the only place a reader meets them — one asserts that
an expectation the service never answered exits `1` with the echo still in the
log, and one asserts that a request the stack cannot serve exits `2` with nothing
spawned and nothing connected to. The file raises its own per-test timeout,
because the lane's is the cold-cache figure for one template build and this file
pays for a build plus two probes.

## The acceptance project

`toolchain` proves a generated project builds, starts, and answers. `acceptance`
proves the _workflow_ over it: `uvp verify` from the command line, against a real
service, with the status, the exit code, and the evidence bundle read together —
because those three are one claim and a lane that checked only the status would
not notice a bundle that disagreed with it.

| File                          | What it establishes                                                 |
| ----------------------------- | ------------------------------------------------------------------- |
| `verifyClosure.test.ts`       | The four verdicts, and that a pass stops what it started            |
| `assertionVocabulary.test.ts` | Every `--assert` form against a real response, and every refusal    |
| `manualPath.test.ts`          | `uvp run --no-detach` → drive it → Ctrl-C, and who owns the process |

The four verdicts are asked of one workspace on one port, reusing one build,
because that is what a caller does — and because a pass that leaked its service
would show up as the _next_ pass failing to bind. Ports are allocated per file
(`8301`, `8311`, `8321`) and stay disjoint from the toolchain lane's `8090–8094`.

`manualPath.test.ts` is the only file here that spawns uvp itself rather than
calling it: `uvp run --no-detach` does not exit while it holds a service, so the
lane reproduces a terminal — spawn the CLI in its own process group, read the
handle off the pipe, drive the service from a second uvp process, then signal the
group. It asserts the service is stopped and the port free afterwards, because a
foreground run's interrupt is the one place where a cleanup that did not happen
would leave nothing behind to notice.

`assertionVocabulary.test.ts` pins the vocabulary from both ends: the forms that
must work, and the three that must be refused with a named reason rather than
lowered into something else. It is the file that would have caught
`uvp_verify`'s contract listing eight of the eleven assertion kinds the
evaluator implements, which made `body_bytes<1024`, `header:<name>`, and
`json:<path>` parse and then fail validation one layer above the check they
described.

## The process-global project

Every other built lane looks at uvp from outside: it spawns the CLI or the MCP
server, reads the pipes, and asserts on what came back. This one looks from
inside, because some facts are only visible there. A subprocess's exit code and
signal handlers die with the subprocess, so a CLI that set them would leak into
whatever called it — an MCP server, a test runner, an embedder — and a lane that
only ever spawned it would see nothing at all.

| File                      | What it establishes                                         |
| ------------------------- | ----------------------------------------------------------- |
| `cliProcessTrace.test.ts` | A call returns a code and leaves the process as it found it |
| `sessionBoundary.test.ts` | A session's runs and its exchanges belong to its own graph  |

`cliProcessTrace.test.ts` calls `runCli` in-process across the paths where
cleanup can be skipped — a tool call that succeeds, one that throws inside its
handler, a failure raised by a provider, both halves of the missing-command
branch — and asserts that `process.exitCode`, `process.cwd()`, and the handler
counts for SIGINT, SIGTERM, `unhandledRejection`, and `uncaughtException` are
unchanged afterwards. One test also reads the handler table from _inside_ a tool
call, through a doctor that records what it sees: an install that was later
removed is otherwise indistinguishable from one that never happened, and the
install is the half that makes a Ctrl-C abort a build instead of the process.
Deleting the `finally` that offs the pair fails all three tests, on the twelfth
call, with the `MaxListenersExceededWarning` the file exists to keep out of
someone's terminal.

`sessionBoundary.test.ts` asks the same question of the object graph. The store
`createUvpServices` builds belongs to that graph and not to the module: a run
registered in one is invisible to another's `stop --all` while remaining stoppable
by its owner, and an exchange one recorded is counted by it and not by the other.
Both are worth a test because neither failure errors — a shared store answers a
different session's question about a different session's observations, which is
the kind of wrongness that has no symptom. Making the store module-level fails
exactly these two tests.

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
`src/contracts/` may import from `domain` and nothing above it; `src/application/`
may not import from `toolchains`, `composition`, or the adapters, because it
defines the ports it needs and is handed the implementations. The `application`
rule covers type-only imports, which is not incidental — the violation that
prompted it was `sessionStore` importing a `SupervisedProcess` type, and a rule
that let that through would have missed the only instance there was.

**Test discovery.** `npm run verify:test-discovery` fails if a `*.test.ts` file
on disk is not claimed by any project. A test file that runs in no project is a
test that silently is not running, which is worse than one that fails.

**Generated files.** The tool catalog, package metadata, skill metadata, and
error schema are generated from source. CI regenerates them and fails on a diff,
so a stale generated file is a build failure rather than a review comment.

**Effect declarations.** A tool description containing "write", "create",
"scaffold", "generate", "save", "delete", or "remove" while `writesFilesystem`
is declared `false` is flagged. The description is usually written first and the
effects block filled in second, which is exactly how they drift. The write
vocabulary is the only one scanned, because it is the only one where a mention
is reliably a claim; `network` is pinned by an exact list of the tools that
contact a caller-named host instead, since "call" and "send" also describe a SOAP
call to loopback and an assertion over an exchange already recorded.

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
nothing reaches. All ten rules are errors, and there are no allowances: the
toolchain helper above is reached by the lanes that import it, so it needs no
entry point, and the external binaries uvp looks for (`cmake`, `ninja`, `g++`, …)
are invoked through `PATH` rather than imported, so knip does not report them.

**jscpd** flags duplication at threshold 3.5, minimum 5 lines and 50 tokens. The
threshold is a smell detector, not a refactoring mandate — some duplication is
clearer than the abstraction that removes it, and the report is read by a person.

**oxfmt** at `printWidth: 100`, with `sortImports` and `sortPackageJson` off.
Import order is a review conversation, not a formatter's decision.

## Next

- [Releasing](releasing.md) — how a release is cut
- [Architecture](architecture.md) — the layers the rules protect
