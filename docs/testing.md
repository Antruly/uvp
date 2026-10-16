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

### The fuzz lanes {#fuzz}

Two source tests state invariants over generated input instead of over examples:
`src/toolchains/diagnostics.fuzz.test.ts` for the build-output parser and
`src/application/httpClient.fuzz.test.ts` for the response decoder and the
transport classifier. They use `tests/support/fuzz.ts`, a seeded generator with no
dependency behind it.

They are not a replacement for the captured-fixture tests they sit beside, and the
two kinds answer different questions. A capture is evidence about the tool that
produced it; a generated input is evidence about the parser. Where the parser has
to agree with Node or with a real compiler, only a capture can say so, and each
fuzz file's header states what it therefore does not establish.

**Rules for a lane like this**, all of which exist so that a failure is a defect
rather than a coincidence:

- **Every case comes from a seed.** `DEFAULT_FUZZ_SEEDS` is a fixed list, and each
  iteration is seeded from `(seed, iteration)` rather than from a stream that runs
  across iterations, so the seed and iteration a failure prints identify that one
  case. A red fuzz run is re-run with `UVP_FUZZ_SEED=<n>`; `UVP_FUZZ_ITERATIONS`
  widens a run.
- **A run states its scope.** `reportFuzzRun` prints the seeds and the iteration
  count, because a bounded search that does not say what it bounded reads like a
  proof.
- **A failure carries its input.** `replay` renders the problem, the reproduction
  line, and the input itself — hex for bytes, quoted and numbered lines for text.
  The cost of a generator is that the failing case exists nowhere but in the run
  that produced it.
- **A recorded behaviour says that it is recorded.** Where the lane pins something
  known to be wrong, the test says so and says why the obvious repair is not the
  one taken, and the item carries a roadmap row. A fuzz lane that asserted only
  what it approved of would be silently narrower than the parser.
- **Only reachable inputs are drawn.** An impossible value proves a point about a
  case nobody can hit. Where a shape is reachable in principle but not from Node
  today — a `code` that is not a string — the test names it and says so rather than
  leaving it to the generator.

## The conformance project

Seven files, each asking one question, none of them needing a compiler.

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

`captureReplay.test.ts` asks whether replaying a capture means what it says. The
failure mode it exists for is a replay that reports success without having
compared anything, so every test drives a real request through a real capture
session and then replays it: a run over two matching routes, a body difference
from an echoed request header, a status difference on a route whose body is
constant (so the digests match and the status is the only thing that differed),
a `POST` skipped by name rather than re-sent, a capture replayed against a dead
port, a capture whose upstream was never there at all, a session whose 8-byte
recording limit leaves the replayed body comparable on status alone, and a
replay against a second origin, which is what pins the stripping of the
connection headers the proxy added. The session limit, the record, and the
second origin are all real; nothing here is a fixture standing in for a
different fixture.

A failure here prints what both fixture children were doing when the request died
— `running`, `exited with code 0`, `killed by SIGKILL`, with the last line the
child said — because this lane is where the socket hang-ups appeared: four times,
twice inside a full gate and twice standalone. The fixture's own exit is the one end
of that request a run can answer for itself, and the diagnostic is logged with the
error rethrown unchanged. The mechanism is settled — a reserved port handed out
twice, against the client's keep-alive pool, which is what the
[roadmap section](roadmap.md#socket-hang-up) reconstructs and the reservation's test
now pins.

`bundleDiff.test.ts` is the one lane whose subject is another tool's file. It runs
`uvp_verify` twice against the scripted toolchain, writes each result to disk the
way `uvp verify --json` does, and compares the two files through the handler a
caller would reach. Two passes of one service differ in bundle id, exchange id, run
id, elapsed time and endpoint, and the comparison has to ignore all five — one that
reported a difference there would make the tool useless rather than wrong. Every
refusal it checks comes from a real file on disk, including a report whose digest
was edited by hand, which is what a reader meets when a caller edits one.

`portReservation.test.ts` is the lane's own infrastructure, tested where it broke.
`freePort` hands out numbers from a window below the ephemeral range, and its
promise is that a number it handed out is spent: a client's keep-alive pool holds a
socket keyed by `host:port` for the life of the process, so a second server on a
re-handed number is reached through the stale socket. It draws a batch rather than
calling twice, because a collision is a draw and not a certainty — eighty draws
fail against the reservation as it was before the fix in 99.8% of runs, and the
window is 512 wide, which is what bounds the batch.

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

### The container lane's image

`tests/toolchain/containerConformance.test.ts` needs three things before any of
its seven toolchain-shaped obligations can run: a container runtime, an image
that is already present on this host, and a libuvcpp _inside_ that image.
`npm run build:conformance-image` builds the third from the libuvcpp that uvp's
own discovery finds and prints the command line to run the lane with. It is a
script and not part of a lane because the lane must not fetch anything: uvp never
pulls an image, and a lane that pulled its own fixture would be testing a network
as much as a toolchain.

That is not a hypothetical. On the host this lane was first run on, every
registry route measured either an error or single-digit KB/s, while the same host
reached a mirror of the Debian archive at 13.7 MB/s — so the base came from that
mirror and was imported locally, and the image's apt host became a `--apt-host`
argument for the same reason. Which route a host has is a fact about the host,
which is why both are arguments rather than constants, and why the lane names its
image instead of acquiring one.

With a runtime and the image present, the lane reports twelve passing. Without
them it reports five passing and seven skipped, each skip naming the provider's
own reason. Neither number is a claim about docker or podman in general: it is a
claim about the image that was named.

The two real-provider lanes share their build substrate —
`tests/conformance/workspaceSubstrate.ts`: generate a workspace, build it, fail a
hand-written one, generate a second that nothing has built yet. A conformance
suite whose two subjects are asked the same question through two copies of the
question is not asking the same question, and `jscpd` found the copy: 34 lines
and 145 tokens that were identical down to the comments. What stays with each
lane is what is actually about that provider — where its libuvcpp came from, how
its absence is worded, and which prefix its requests carry.

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

`docs:build` is the other half of the documentation check and is in the gate for
the same reason the `--check` scripts are: it renders every page and fails on a
link or an anchor that does not resolve, which nothing else here can see. The one
dead link CI has caught was a relative path to the repository README that
`docs:check` accepted and this refuses, so a page can be consistent with the code
and still send a reader nowhere.

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

## The Windows lane {#windows}

`windows-source` runs `npm run check:fast` and `npm run test:fast` on
`windows-latest`: the source projects and the two static gates over them, on the
platform uvp says it supports. Before it existed, every claim this repository makes
about Windows was read out of the source rather than observed — the `cl` probe in
the local provider, the `C:/…` rule in the build output parser, `detached:
process.platform !== "win32"` in the process runner, the `.exe` suffix the native
probe looks for. Each of those was `undetermined` on the platform it was about.
The lane is what makes them observed.

**It says what it does not cover.** No job had run on Windows before this one, and
the lane deliberately stops at the TypeScript half: it needs no C++ compiler and
no libuvcpp, so it establishes generation, parsing, the providers' own decisions,
capture and replay on Windows, and nothing about a compiler there. A workspace
built and run on Windows, `local-msvc` end to end, is not this lane and is not
claimed by it. The job name carries the limit for the same reason
`tests/toolchain/` skips with a reason rather than failing: a lane must not imply
coverage it did not have.

**Its first run found real gaps, and they are skipped by name until each is
fixed.** 53 of the source tests could not run there, in three groups, each with
an issue and a fix PR of its own:

| tests | gap                                                                                                                                           | tracked by                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 45    | the suite's fake built binaries are `#!/bin/sh` scripts with no extension, which Windows cannot spawn — five fixtures write one independently | [#18](https://github.com/Antruly/uvp/issues/18) |
| 4     | the artifacts fixture names its outputs the POSIX way (no extension), and `discoverArtifacts` decides by extension on Windows                 | [#19](https://github.com/Antruly/uvp/issues/19) |
| 4     | a recorded command line is rendered in POSIX dialect (`env NAME='C:\…'`), and four assertions read the raw line                               | [#20](https://github.com/Antruly/uvp/issues/20) |

The skips are `it.skipIf`/`describe.skipIf` with the reason in the **title**, so
`scripts/lib/vitest-skipped-reporter.mjs` prints each one and no skip can read as
a pass. Each names its issue, which is where the removal is tracked; the count
above is the number that should fall as those land.

**All three rows are fixed, the fake-executable one only partly.** The artifacts
fixture now names every file it means as a build output
the way this host names one — `EXE` from `src/toolchains/host.ts`, which is the
product's own answer to that question — so its 4 tests run on Windows and the
skips that named #19 are gone. The five fake-executable fixtures now install a
program the host will start through one owner (`tests/support/fakeExecutable.ts`),
so 43 of the 45 run. The other 2 are a _second_ wall behind the first, and it is
worth stating plainly because it is not the shell-script problem: the local
provider chooses `cmake`'s arguments itself, and on Windows the fake is a copy of
Node, which reads `-S`/`--build` as its own bad options and exits 9 before any of
the suite's code runs. Two tests are skipped by name for it and it is filed as
[#22](https://github.com/Antruly/uvp/issues/22), which records the routes — a
`run` seam on the local provider, as the container provider has, or an executable
image that is not Node — and leaves the choice to a maintainer.

The recorded-command row was two problems wearing one issue number. The four
assertions read the record as raw text, and `(?:^|\s)NAME=(\S+)` hands back
`'C:\Users\…` for a Windows path — the opening quote is captured with the value —
and truncates at the space for a POSIX path that has one. That is the reader, not
the product, and it is what the lane actually failed on: `tests/support/recordedCommand.ts`
now reads the notation the record is written in, splitting into words before it
matches so that a `NAME=` inside another variable's value cannot be mistaken for
an assignment. The same commit stops the test from joining a path list with a
literal `:` where the product uses `delimiter`, which was a second, independent
POSIX assumption in one of the four. The other problem is the record itself, and
it is not fixed here: `renderCommand` writes `env NAME=value …` on every host,
which is POSIX shell notation and not a line `cmd.exe` or PowerShell will run, and
it quotes the environment but never the command's own arguments — so the line its
docblock calls re-runnable is not reliably re-runnable on POSIX either, once a
path has a space in it. That is a product question with a schema dimension
(`commands: z.array(z.string())` is a declared output field, generated into
`docs/public/tool-catalog.json` and consumed as provenance), so it stays open on
[#20](https://github.com/Antruly/uvp/issues/20) with three costed options for a
maintainer to choose between, and no product behaviour changed in this fix.

So 51 of the 53 have landed, leaving 2 skipped in these three groups, both the
`cmake` pair for #22; the lane's own total is 4, the other two being the
reserved-port window — a host with no window below the ephemeral range has none
to reserve from, and says so in the title — and `runCancellation`'s stop marker,
which is a `TerminateProcess` on Windows and says so in its title too.

The lane also found one defect it could not have run without: `scripts/run-tests.mjs`
spawned `node_modules/.bin/vitest` directly, which on Windows is not a file that
can be executed — only `vitest.cmd` and a shell script are there. `npm run
test:fast` would have died before loading a test file, and it would have looked
like a broken suite rather than a wrong path. The runner now resolves the Vitest
entry from Vitest's own `package.json` and runs it through the Node already
executing the script.

**The same defect, one caller later.** `scripts/lint.mjs` did what the runner had
done: it resolved `oxlint/package.json`'s `bin` and handed _that file_ to
`spawnSync`. The file is 46 bytes of JavaScript behind `#!/usr/bin/env node`, so
the spawn asked the host to start it as an image — which a POSIX host does by
reading the shebang, and which Windows cannot do at all. libuv's `search_path`
tries the literal name only when it has an extension, so a name without one is
searched as `NAME.com` and then `NAME.exe`; Node's own layer consults `ComSpec`
only when `options.shell` is set, and this call passes no shell. So the old call
was a POSIX-only assumption: on Windows it fails with `spawnSync … ENOENT` for a
file that is present — **derived** from libuv's name search rather than measured,
since the lane could not run lint at all before this fix, and the message under
it guessed `Install first: npm ci` at a dependency that was installed. Both are
fixed: oxlint is started through `process.execPath`, the same shape the runner
uses, and a spawn failure now reports what the spawn said — resolution is the step
that fails when the dependency is absent, and it keeps that hint.

That fix is what let the lane take the gates: `windows-source` now runs
`npm run check:fast` before the source projects. Still not in the lane: `oxfmt`
and the rest of `check:pr` (`docs:build`, `knip`, `jscpd`,
`verify:pack-reproducible`, the built tests), none of which has been examined for
Windows. `oxfmt` is the one worth naming separately, because it is _not_ the same
shape: `format:check` names `oxfmt`, which npm starts through its own `.bin` shim
rather than through a path this repository resolved — measured by reading
`node_modules/oxfmt/bin/oxfmt`, which is the same 46-byte Node entry, reached a
different way. Whether that route works on Windows is unmeasured, and this
document does not claim it does.

## Built tests

These require `npm run compile` to have run first. They exercise the artifacts
that ship: the CLI as a process, the MCP server as a process, the packaged
tarball.

| Project            | Covers                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `boundary`         | Import-surface rules across built output                                                                     |
| `cli-boundary`     | The CLI driven as a subprocess                                                                               |
| `process-boundary` | Process supervision: start, readiness, stop, orphans                                                         |
| `mcp-boundary`     | The MCP server over real stdio                                                                               |
| `toolchain`        | Real CMake and real libuvcpp: six templates, a database-backed one, a failing build, both provider contracts |
| `acceptance`       | The whole closure through `uvp verify`, and the assertion vocabulary                                         |
| `process-global`   | What a call leaves in the process it ran in, and whose session it is                                         |

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
2. generates each of the six templates,
3. configures and compiles each one,
4. starts each one **on its own port** and waits for readiness,
5. drives a real request and asserts on the response,
6. stops it and asserts the process is gone.

Each template gets a distinct port (8090–8095 in the reference run). Sequential
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
### http3-service   :8095 -> hello over HTTP/3
```

The `http3-service` row is the one that needs a word. It binds TCP and UDP on the
same port, and this table is produced by a TCP readiness probe and a plain HTTP
request — so what the row records is that the template's _other_ leg answers, and
that the service printed the UDP port it opened before serving anything. The h3
claim itself is made one project over, by
`tests/toolchain/nativeProbe.test.ts`, which asks `uvp http --http-version 3` and
gets its answer from libuvcpp's own QUIC client. A row here that read
"HTTP/3 verified" would be a claim this probe cannot make.

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

The summary is where that has to hold, and Vitest's default reporter does not
hold it: it folds skips into a count and prints none of their names. So
`scripts/lib/vitest-skipped-reporter.mjs` runs beside it and lists every skipped
test under the suite it was skipped by, which is where the reason sits for a
whole-suite skip. It is registered in `vitest.config.ts` for a local run and
named in the CI test steps, whose explicit `--reporter` flags would otherwise
replace the config — a lane that prints a count and no reason is a lane that
cannot be read. `npm run verify:reporters` is what keeps the two in step.

### A build that fails

`tests/toolchain/buildFailure.test.ts` is the other half of the same claim. A
green run of six templates says the templates work; this says a workspace that
does **not** build is reported as one. Both halves serve the same caller, because
"your workspace is broken", "the library is missing", and "this tool could not
tell" are three different next steps.

It breaks a generated workspace rather than hand-writing a CMake project, so the
subject is a project uvp produced itself, and it checks one failure per phase:

| Failure            | Produced by       | What must come back                                                 |
| ------------------ | ----------------- | ------------------------------------------------------------------- |
| Compile error      | the compiler      | the compiler's file, line, and message, at `phase: "compile"`       |
| Configure error    | CMake             | CMake's own error, naming the line in the caller's `CMakeLists.txt` |
| Link error         | the linker (`ld`) | the linker's words, the caller's file and line, at `phase: "link"`  |
| Warning on success | CMake             | the warning, on a build that still succeeds                         |

The configure row is a regression: CMake's errors are not compiler diagnostics in
any spelling, and the parser knew only the compiler formats — so a configure
failure came back as `succeeded: false` with `diagnostics: []`, under a
limitation promising "the diagnostics below are the compiler's own output". The
link row is the same defect one phase later: the linker's lines carry a file, a
line and a section and no column, so every format passed them by and a link
failure reported nothing either. Both are parsed now in
`src/toolchains/diagnostics.ts`, one module for all four producers (GCC, MSVC,
CMake, the linker), tested against text captured from the real tools rather than
text written to match the parser — the captures and what they decided are in
[the roadmap](roadmap.md#link-failures).

The link test also carries the half that is not about formats. `ld` and GNU Make
translate their messages, so the same failure on a `zh_CN.UTF-8` host is
`找不到 -luvcpp` and matches nothing; the second test runs the build with that
locale in the _caller's_ environment and asserts the diagnostic is still the
English one. It probes the host's own `ld` first and prints a named reason when
this machine's linker does not localize, because on such a host the hostile
environment would change nothing and the test would pass without having shown
anything.

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

### The database-backed template

`tests/toolchain/database.test.ts` asks the one question a string cannot answer:
whether what a service stored survives the process that stored it. It generates
`rest-api --features db`, compiles it, starts it on a SQLite file, writes a value
that did not exist before the run, stops it, **starts it again**, and reads the
value back.

The second process is the assertion. `src/application/templates.test.ts` covers
the cheaper half — that declaring `db` replaces the in-memory map in the
generated source — and that is a claim about a string, which is exactly what a
handler that answers `{"stored":1}` and then forgets would also produce. The
value written is unique to the run, so nothing the template could have canned
satisfies the read.

The recorded run, against libuvcpp 1.7.0, with
`UVP_DATABASE_URL=sqlite://<root>/doc.db`. The start line is the service
announcing the connection string it actually opened, which is how a caller learns
the variable was read at all; the JSON bodies are the db module's own `to_json()`
reflowed onto one line here, because it indents, and the service's own log lines
are left out:

```
serving from sqlite://<root>/doc.db
listening on 8097

GET  /items          -> 200 {"table":"","columns":["id","value"],"rows":[]}
GET  /items/nobody   -> 404 {"error":"not found"}
POST /items/7        -> 201 {"stored":1}
GET  /items/7        -> 200 {"table":"","columns":["id","value"],"rows":[{"id":"7","value":"hello-db"}]}
POST /items/8        -> 400 {"error":"empty body"}          # no body sent
POST /items/7        -> 500 {"error":"not stored","status":"exec_failed"}

-rw-r--r-- 12288 …/doc.db                                   # the file, not the process

--- a second process, nothing shared but the connection string ---
GET  /items          -> 200 {"table":"","columns":["id","value"],"rows":[{"id":"7","value":"hello-db"}]}

--- the same binary, a connection string it cannot open ---
cannot open sqlite:///no/such/directory/svc.db: open_failed: …      (exit 1)
```

Four things behind that transcript are decisions rather than consequences:

- **`/items` is empty at the start.** The in-memory template seeds two rows, so
  this is also the shortest statement that the store behind these routes is not
  that one.
- **The duplicate key is a 500 and not a 409.** The layer underneath reports one
  status for every failed `execute`, so a taken key and a dropped connection
  arrive with the same name (`exec_failed`) and the service reports what it was
  told. It is the same fact that makes the route a `POST`: an upsert is a promise
  this code cannot keep.
- **The refusal happens before the listener.** `init` opens the first connection
  at startup, so a connection string that cannot be opened is an exit code, the
  driver's own reason, and the URL echoed back — not a service that comes up
  green, answers `/healthz`, and 500s on the first request that needs data,
  reporting a deployment mistake as a bug in the request. The port is checked to
  be free afterwards.
- **With no `UVP_DATABASE_URL` at all it opens `sqlite://./<name>.db`** in the
  working directory, and the lane asserts the file is there. That default is what
  makes a freshly generated workspace runnable with nothing installed but
  libuvcpp — SQLite is a library, not a server — and `uvp verify`, which starts a
  service with no environment at all, is the caller that depends on it.

The lane exercises **SQLite only**, and this is a limit of the host rather than a
choice. libuvcpp loads the three drivers at run time, so all three dialects are
the same template and the same generated code; MySQL and PostgreSQL additionally
need a server to connect to. What the lane says about them is what it can see:
nothing runs against them here, and the generated README says which of the three
it was tried against rather than implying all three were. The port is 8096, in
the toolchain lane's block, and the file reuses none of `realToolchain.test.ts`'s
six.

### The native probe, against a generated service

`tests/toolchain/nativeProbe.test.ts` answers the one question the rest of the
suite cannot: whether libuvcpp's _own_ WebSocket client can talk to a service uvp
generated. Every other WebSocket test uses a Node client, and two clients that
both claim RFC 6455 can disagree about everything the RFC leaves open — so a Node
client reaching `websocket-echo` says nothing about this one.

It has the same shape as the rest of the lane — generate, build, start, drive,
stop — with one addition: the probe is a **binary**, `uvcpp-probe`, that
`npm run build:native-probe` produces against a libuvcpp with
`UVCPP_ENABLE_CAPI=ON`. The HTTP/3 exchange inside it needs more than that — the
install has to expose the HTTP/3 C ABI, which is a libuvcpp configured with
`UVCPP_ENABLE_HTTP3=ON` and `UVCPP_ENABLE_QUIC=ON` — and the probe's build asks the
compiler which install it has rather than assuming: without that ABI it builds the
WebSocket exchange alone and reports the missing one, with its reason, from
`--version`. So this file's own guard has three conditions, and names which one is
true — no libuvcpp, no probe binary, or a probe that cannot run the h3 exchange —
because only the first is fixed by installing libuvcpp and only the second by
building the probe. The lane does not build the probe, because that would make a
test run depend on a C++ compiler and a particular install.

Where the probe is comes from `NativeProbeRunner.availability`, the same call the
CLI makes, rather than from a second search order written in the test; the path
it returns is passed to the child CLI as `UVP_NATIVE_PROBE`, so the test and the
tool cannot disagree about which binary answered. CI builds the probe before this
lane runs, for the same reason it installs libuvcpp at all.

All five tests in the file skip together when there is no binary, because all five
need it: one probes a generated service end to end, one reads the same run the way
a person would — without `--json`, where the stack row, the blind-spot list, and the
note about the abandoned log are the only place a reader meets them — one asserts
that an expectation the service never answered exits `1` with the echo still in the
log, and one asserts that a request the stack cannot serve exits `2` with nothing
spawned and nothing connected to. The fifth drives the HTTP/3 exchange over QUIC,
and it is the one test here that can also skip by itself, when the probe was built
against an install without the HTTP/3 C ABI — a supported probe rather than a broken
one, which is why the skip names itself rather than disappearing. The file raises
its own per-test timeout, because the lane's is the cold-cache figure for one
template build and this file pays for a build plus two probes.

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
| `http2.test.ts`               | A workspace generated with `--features http2` really speaks HTTP/2  |

The four verdicts are asked of one workspace on one port, reusing one build,
because that is what a caller does — and because a pass that leaked its service
would show up as the _next_ pass failing to bind. Ports are allocated per file
(`8301`, `8311`, `8321`, `8322`) and stay disjoint from the toolchain lane's
`8090–8099`.

`http2.test.ts` is the one file here whose subject is a transport rather than a
verdict, and it is written so that it cannot pass by accident. The generated
workspace is built and asked for HTTP/2 in cleartext, then asked on the same port
for HTTP/1.1 without restarting anything — a pair, because "the port speaks
HTTP/2" and "the port speaks only HTTP/2" are different claims. The assertion
that carries the weight is `http_version=2.0`, which reads the version the
response arrived in; it is run where it must pass and where it must fail, and the
failing run is required to name `1.1` rather than merely to be red. The negative
control for the whole file is the third test: `auto` negotiates down, so an
evaluator that answered `passed: true` for any response at all would go red there.

HTTP/3 is not tested _here_, and the file says why in its header rather than
leaving a reader to wonder. What it asserts instead is a refusal: `--http-version
3` does not reach a h3 client from this lane, because the client is only asked for
when verification is off and this call leaves it on — see
[libuvcpp features](libuvcpp-features.md#http3-quic-and-the-web-layer-travel-together).
The transport itself is covered where it can be: `tests/toolchain/nativeProbe.test.ts`
generates `http3-service`, builds it, starts it, and completes an exchange over
QUIC with libuvcpp's own client, with the same service answering over its TCP leg
as the control. The last test here uses a plain Node HTTP/1.1 server rather than a
second generated workspace: the fact under test is uvp's classification of a
protocol mismatch, which needs a real socket and a real response but no C++.

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
`uvp_verify`'s contract listing eight of the assertion kinds the evaluator
implements, which made `body_bytes<1024`, `header:<name>`, and `json:<path>`
parse and then fail validation one layer above the check they described. The
contract's list is `ASSERTION_KINDS` rather than a second copy, so that
particular drift cannot recur — the count moved from eleven to twelve when
`http_version_equals` was added, and it is named in one place.

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
`src/application/evidenceHelpers.ts`, `src/application/bundleDiff.ts`,
`src/application/workspaceManifest.ts`, and `src/domain/{evidence,unknown,errors}.ts`.

Those files' tests are the `services` and `domain` projects, and no other
project runs: a mutant in a pure module does not change what a lane that
compiles real C++ decides, and running one per mutant would turn a sweep
measured in milliseconds per mutant into one measured in minutes.
`vitest.mutation.config.ts` is that scope, filtered out of the suite's own
project list so that the file which decides what `domain` and `services` contain
is still `scripts/lib/test-projects.mjs`.

`coverageAnalysis: "perTest"` with `related: true` is the plan: a mutant re-runs
only the tests that covered it. It is also the plan the runner cannot carry out —
read [the subsection below](#mutation-not-a-measurement) before reading any
number this lane prints.

**There is no break threshold.** `thresholds.break` is `null` on purpose. A
mutation score that gates a merge invites two bad responses: writing tests that
kill mutants rather than find bugs, and nudging the threshold. The score is
reported, the survivors are listed, and a human decides.

The summary script exits non-zero when the report is **missing** — a run that
produced no report is not a clean sweep, and treating it as one is how a broken
mutation job goes unnoticed for a month. It exits non-zero for one more reason,
which [the next subsection](#mutation-not-a-measurement) explains: a report in
which mutants that were planned as a run completed no test describes the runner
rather than the suite, and a percentage over it reads like a suite that notices
nothing.

### The score is not a measurement yet {#mutation-not-a-measurement}

Measured on this tree at `175b9a7`, with the configuration described above,
against `@stryker-mutator/core@10.0.0`, `@stryker-mutator/vitest-runner@10.0.0`
and `vitest@5.0.3`.

A sweep of those eight files produced **1294 mutants: 199 killed, 934 survived,
125 with no coverage, 36 static survivors**. All 199 kills are `static: true`,
and **not one of the 934 mutants reported `Survived` ran a single test** — every
one carries `testsCompleted: 0` next to a `coveredBy` naming the tests that were
supposed to run. The shape does not depend on the settings that look like they
would change it: the same files' `assertions.ts` slice under
`coverageAnalysis: "all"` with `related: false` gives 307 runtime survivors with
zero tests run, 65 with no coverage and 11 static kills, and under
`coverageAnalysis: "off"` the same split appears.

**The mechanism.** Core plans a non-static mutant against the tests that covered
it and hands the runner their ids as a `testFilter`. The runner records an id as
`file#suite and test names joined by a space` (`collectTestName` in the runner's
`test-helpers.js`) and turns the filter into `project.config.testNamePattern`, a
regular expression built from those names. Vitest 5 matches that pattern against
a task's `fullTestName`, which joins the same names with `" > "`. The pattern
therefore matches nothing: vitest loads the right files, selects zero tests, and
the runner returns `{tests: [], status: Complete}`, which Stryker records as
`Survived`. Driving one test file through vitest's own programmatic API with the
runner's pattern gives **13 tests with no pattern, 0 with the recorded one, and
2 with the same two names joined by `" > "`**. Static mutants are untouched —
they are planned with the project's whole test-file list instead of a name
pattern — which is why they produced every kill. The runner's own peer range is
`vitest >=2.0.0`, so this is not a case of a package used outside the versions it
claims: the lane is inside it.

`coverageAnalysis: "off"` does not avoid it, because core only ever _adds_ the
coverage global it uses in that mode: the vitest runner returns its own
`mutantCoverage` from the dry run regardless, so coverage exists and the per-test
plan is built from it. `related: false` does not avoid it either; it changes
which files the dry run loads, not how a mutant is planned.

**The score is wrong, not merely low.** Hand-applying the mutant Stryker reported
as `Survived` at `src/application/assertions.ts:74:10` (replacement
`index >= path.length`) fails **4 of the 396 tests** in the lane's own scope. The
suite would have caught it; the runner never ran it. So the survivors this lane
lists are not a list of gaps, and the percentage over them describes the runner.

**Three defects stood between the configuration and this measurement**, all
fixed before that measurement was produced. `vitest.project` is not a Stryker
10 option and the schema rejects the key, which is what the workflow's preflight
step hit first. Core's `TSConfigPreprocessor` rewrites the sandbox's tsconfig
through `ts.parseConfigFileTextToJson`, which TypeScript 7.0.2 does not export —
its JavaScript API is `version` and `versionMajorMinor` alone — so the checker
declared in `plugins` cannot run either, `checkers` is empty, and `tsconfigFile`
names a file that is deliberately absent from the repository. And the `mutate`
list named `src/domain/result.ts`, a file that has never existed here.

**What is undecided** is how the lane gets a measurement. Four ways, with the
cost each one was measured or reasoned at:

- **Own the runner.** A Stryker `TestRunner` plugin over `vitest/node`'s public
  API, recording ids in the `" > "` form vitest matches. It is the only option
  that keeps per-test planning, and therefore the only one whose sweep stays
  affordable. Its size is not measured, and it is not a shim: the package exposes
  `.` and `./package.json` and nothing else, so `VitestTestRunner` cannot be
  subclassed, and the dry run, the setup file that names each test to the
  instrumented code, and per-test mutant activation would all be written here.
- **Patch the dependency.** One separator, two copies of `collectTestName`. It
  puts a patched package between what CI installs and what this repository reads,
  for a bug that is upstream's to fix.
- **Run every mutant against the whole scope**, using the built-in `command`
  runner, which supplies no coverage and so is planned with the global filter.
  Measured on this host at `concurrency: 2`: the 43 mutants of `domain/unknown.ts`
  took 1 minute 26 seconds, about **two seconds per mutant**, which puts the
  1294-mutant sweep near **43 minutes** — on an 18-core workstation, against a
  job with a 60-minute timeout on a smaller runner, so treat it as a floor. It
  also grades a mutant only by the command's exit code, so a mutant that stops
  the run from starting reads as a kill, and it reports `1.00 tests per mutant`
  because it models the whole command as one test.
- **Drop the lane.** The cheapest, and honest if none of the above is worth the
  cost: what is lost is the survivor list, and that list was not real either.

Until one of them is taken, the weekly job fails at the summary step instead of
publishing a percentage, and the mutation row under _Hardening_ in the roadmap
owns the decision.

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

**Reporter flags.** `npm run verify:reporters` fails if a `run:` step under
`.github/`, or a script in `package.json`, passes its own `--reporter` flags
without naming the skip reporter. The flags replace what `vitest.config.ts`
registers rather than adding to it, so the step loses the names and keeps the
count — green, and unreadable. It is the same defect the discovery check exists
for, one level down: a lane that reports nothing looks like a lane that passed.
These repository checks are scripts rather than turbo tasks. Every one of them
runs in the static job except the pack check, which needs a built `dist/` and so
runs in the packaged rehearsal job instead.

**Action pins.** `npm run verify:actions` fails if a `uses:` under `.github/`
names a third-party action by anything but a 40-hex commit SHA with the release
beside it (`owner/repo@<sha> # v4.4.0`), or if one action is pinned at two SHAs.
A tag is a pointer its owner can move, so `@v4` is a decision to run whatever
`v4` is on the day the job starts — and a bare SHA is a pin a reviewer cannot
read. It also fails on the one form it cannot read, a `uses:` whose value starts
on the next line, because a reference nobody read is a reference nobody checked.
`.github/dependabot.yml` keeps the pins current; it is the same change for the
same reason, since an unmaintained pin is a stale action that looks reviewed.

**Artifact guards.** `npm run verify:artifact-guards` fails when a step that
downloads an artifact is gated on a condition that can be true while the job
uploading that artifact is skipped — the reader's `if:` has to imply the
writer's. The comparison is a parsed implication rather than a text match, so
`code` reading an artifact `code || package` uploads is accepted, which is the
shape CI actually uses. A step's effective condition is its job's condition
**and** its own, since a step narrows its job rather than replacing it; reading
one as the other is what the check got wrong first. `actionlint` checks what a
workflow says about itself and cannot see any of this: no single job's condition
is wrong, so nothing is wrong until two of them are read together. See
[the roadmap](roadmap.md#artifact-guards) for the run that made it necessary.

**Docs interpolation.** `npm run verify:docs-interpolation` fails when a markdown
page under `docs/` holds an unescaped <span v-pre>`{{`</span> that Vue will read as an interpolation,
because the docs are VitePress pages and their braces are code. What a reader gets
depends on the expression: <span v-pre>`{{ name }}`</span> renders as nothing and takes its own
text with it, <span v-pre>`{{ name() }}`</span> fails the page's whole render — which VitePress
logs and then **exits 0** on, publishing an empty page. This paragraph has to
escape its own examples for that reason. A fence or a `<span v-pre>` is where a
brace renders literally; an indented block is not, which is the form that looks
like a fence and is not one. Which files are pages is asked of
`docs/.vitepress/config.ts`'s `srcExclude` rather than restated, so the Chinese
README, a GitHub page that no Vue renders, is out of the scan. See
[the roadmap](roadmap.md#docs-interpolation) for the page that shipped empty.

**Pack reproducibility.** `npm run verify:pack-reproducible` packs three more
times — twice more from the tree, once from the first tarball's own contents
unpacked at a different absolute path — and fails if the bytes differ. It is the
one check here whose subject is the artifact rather than the repository: a
tarball whose bytes depend on the checkout's path or on the clock is a tarball
nobody can reproduce from a tag. Packing what the tarball holds is what asks that
question without a second implementation of npm's file selection. It needs
`dist/`, so it fails on an unbuilt tree rather than passing over one. See
[the roadmap](roadmap.md#pack-reproducibility) for what it does and does not
establish.

The same script checks the other half of the same claim: every path
`package.json`'s `files[]` names has to be delivered by the tarball — a file entry
by appearing in it, a directory entry by delivering something beneath it — and an
entry naming nothing in the repository is a failure with the path printed. npm
ignores such an entry in silence, which is how `THIRD_PARTY_NOTICES.md` came to
tell a redistributor to keep a file that no tarball had ever contained. The
opposite direction — a file that should ship and is not listed — is a policy
question rather than a decidable one, and stays a reviewer's.

**Generated files.** The tool catalog, package metadata, skill metadata, error
schema, the licence inventory under `licenses/` and `sbom.cdx.json` are generated
from source. CI regenerates them and fails on a diff, so a stale generated file is
a build failure rather than a review comment. The licence inventory is the one
whose input is `package-lock.json` rather than `src/`, and it had drifted by twenty
packages — the script existed and nothing ran it. See
[the roadmap](roadmap.md#dependency-inventory) for what that cost.

`sbom.cdx.json` reads the same lockfile and shares one closure walk with the
licence inventory, in `scripts/lib/productionClosure.mjs`, so "what ships" is one
interpretation rather than two. It is CycloneDX 1.5, and its own generator carries
two kinds of guard: the rules that could stop matching (purl encoding, the UUID
derivation, the integrity decoder) are run against inputs whose answers are known,
and the document's structural invariants — a unique `bom-ref` per component, a
dependency graph in which every reference resolves, no component the graph does not
name — are asserted before it is written. Neither is schema validation; see
[the roadmap](roadmap.md#sbom) for what was validated by hand and is not a gate.

**Instructions, not only facts.** `scripts/check-doc-facts.mjs` also reads the
pages as instructions: every `npm run <name>` a page tells a reader to run has to
be a script `package.json` defines, and the distributed-dependency table in
`THIRD_PARTY_NOTICES.md` has to match `package.json` and, row by row, the licence
the lockfile records for each package. Both were found by this check being
written: six documented commands did not exist (`metadata:generate` among them, a
rename that never reached `CONTRIBUTING.md`) and two of the three licence cells
were wrong. A dependency the lockfile records no licence for is a note
rather than a failure — the check says it could not read the fact instead of
deciding it.

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
npm run check:ci          # lint, format check, knip, jscpd, typecheck, docs, lane plan
npm run verify:lane-plan  # the CI lane table alone, without classifying a diff
```

`test:fast` is what you run while working. `test:built` is what CI shards three
ways.

`check:ci` is also where the CI lane plan is checked. `scripts/ci/plan.mjs`
decides which lanes a change selects, and it carries a table of paths whose lanes
it must keep selecting — a rule that reads correctly but never fires is invisible
in a plan's own output, because the lanes it did select look deliberate. The
script enforces that table on every invocation, and `verify:lane-plan` invokes it
for the table alone so the check is in the local gate rather than only in the run
it configures.

One rule is worth knowing when reading it. A change under `.github/workflows/`
selects **every** lane, because the workflow file is what defines the lanes —
which apt packages, which OpenSSL, which library path. A commit that repaired the
real-libuvcpp lane was classified as a workflow-only change and skipped that lane,
so the repair could not be validated by the change that made it. Editing CI is
rare and the long build is the cheaper of the two mistakes.

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
