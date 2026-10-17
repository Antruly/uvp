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

**All three rows are fixed, and the fake-executable wall is now crossed by a seam
rather than a workaround.** The artifacts fixture now names every file it means as
a build output the way this host names one — `EXE` from
`src/toolchains/host.ts`, which is the product's own answer to that question — so
its 4 tests run on Windows and the skips that named #19 are gone. The five
fake-executable fixtures now install a program the host will start through one
owner (`tests/support/fakeExecutable.ts`), so 43 of the 45 run. The other 2 are a
_second_ wall behind the first, and it is worth stating plainly because it is not
the shell-script problem: the local provider chooses `cmake`'s arguments itself,
and on Windows the fake is a copy of Node, which reads `-S`/`--build` as its own
bad options and exits 9 before any of the suite's code runs.
[#22](https://github.com/Antruly/uvp/issues/22) recorded that and **decided on
2026-10-16: no product change for this source lane**. [#11](https://github.com/Antruly/uvp/issues/11)
is the Windows C++ lane where the seam is needed for real, and the provider now
takes the same `run` slot `ContainerToolchainProvider` has. The two tests inject a
runner that answers the provider's request on Windows; on every other host the
real runner still starts a real child, so the seam does not turn the whole file
into a scripted one. What that does not establish is that a Windows host can start
`cmake`: the `windows-toolchain` lane is where a real MSVC build observes that,
and it says in its own name what it does.

The recorded-command row was two problems wearing one issue number. The four
assertions read the record as raw text, and `(?:^|\s)NAME=(\S+)` hands back
`'C:\Users\…` for a Windows path — the opening quote is captured with the value —
and truncates at the space for a POSIX path that has one. That is the reader, not
the product, and it is what the lane actually failed on: `tests/support/recordedCommand.ts`
now reads the notation the record is written in, splitting into words before it
matches so that a `NAME=` inside another variable's value cannot be mistaken for
an assignment. The same commit stops the test from joining a path list with a
literal `:` where the product uses `delimiter`, which was a second, independent
POSIX assumption in one of the four.

The other problem was the record itself, and it is fixed in a change of its own,
still on [#20](https://github.com/Antruly/uvp/issues/20). `renderCommand` quoted
the environment but not the command's own arguments, so `cmake -S /tmp/uvp probe/ws`
was four arguments to a reader and two to uvp: the line its docblock calls
re-runnable was not re-runnable on POSIX either, once a path had a space in it —
and the workspace is an argument, so that is the ordinary case for a path someone
has. Every word now goes through the one function that already owned the rule,
`shellQuote`, and an argument that is empty is written `''` rather than vanishing
into a separator. What the line still is — `env NAME=value …`, POSIX notation, on
every host including Windows — is a statement in the docblock rather than a
defect. The alternative, the record as data (`command`, `args` and `env` in place
of one string, a change to the declared `commands: z.array(z.string())` field
that is generated into `docs/public/tool-catalog.json`), was considered and
rejected on the issue: every consumer would still have to render a string for
`sources[].ref`, and the field's job is provenance, not re-execution.

So all 53 have landed: the `cmake` pair now runs on Windows through the injected
runner, and the source lane's own total is 2 — the reserved-port window, where a
host with no window below the ephemeral range has none to reserve from and says so
in the title, and `runCancellation`'s stop marker, which is a `TerminateProcess`
on Windows and says so in its title too.

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

**The C++ Windows lane is `windows-toolchain`.** It installs the pinned
`libuvcpp-1.7.0-msvc-x64` release archive, records the modules its config header
defines, installs a `pkg-config.exe`, activates MSVC through
`vswhere`/`vcvars64.bat`, and runs the built toolchain group under **two Windows
generations**, Ninja and the default Visual Studio generator, both in Release.
The archive is a release build with the release CRT, so a Debug build would mix
CRTs; the provider passes `--config <type>` to `cmake --build` for the
multi-configuration Visual Studio generator
([#144](https://github.com/Antruly/uvp/issues/144)), and the default-generator
leg observes that selector and the `build/<name>` output property. The lane is where the
Windows claims in the local provider and the generated code are observed;
`windows-source` only proves the TypeScript half. Its first runs found four
lane/stand-in defects (quoted record text, the pkg-config PATH, the `.bat`/`.exe`
mix-up, and the `svc`/`svc.exe` name) and the multi-configuration output
directory. The native probe is not built there; the two link-diagnostic tests skip
with the reason the roadmap records; and the DB refusal case runs there since
[#108](https://github.com/Antruly/uvp/issues/108), on a path blocked by a file
rather than by the host's permissions.

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
cannot open sqlite://./blocker/svc.db: open_failed: …              (exit 1)
```

The connection string is blocked by a regular file named `blocker` in the
workspace root, not by a missing directory. libuvcpp's SQLite driver creates a
path's parent chain before opening it (`make_parent_dirs`), so a missing
directory is unopenable only where the host forbids creating it: `/no/…` is
EACCES on the POSIX runner but a creatable path on the Windows one, which is
why this case used to skip there ([#108](https://github.com/Antruly/uvp/issues/108)).
A file where a directory is needed is refused on both — the driver accepts
`EEXIST` as "the chain exists" and `sqlite3_open_v2` answers `CANTOPEN` — so the
case runs on both lanes; it was observed on the POSIX runner here, and the
Windows lane is where the other half is measured.

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
measured in milliseconds per mutant into one measured in minutes. That scope is
the `mutation` group in `scripts/lib/test-projects.mjs`, which is also the file
deciding what `domain` and `services` contain — so a project renamed there is
renamed here, and there is no second copy of the two names to drift.

**The runner is `command`, and it grades a mutant by exit code alone.** The
`vitest` runner plans each mutant against the tests that covered it, and vitest 5
cannot match the ids it plans with, which is why the lane produced no
measurement at all until 2026-10-16; [the subsection
below](#mutation-not-a-measurement) carries that finding and the choice made
from it. What the lane runs now is
`node scripts/run-tests.mjs mutation` — the suite's own entry point, so a mutant
meets the suite's pools, worker bound and canonical `TMPDIR` — and a mutant is
killed exactly when that command exits non-zero. The cost is time: every mutant
runs the whole group rather than the tests that touched it. That count is a property
of the tree rather than of the lane, and it moves with nothing to mark it: **391**
where the first full sweep ran (`a772ccb`), **396** at `a1e82da` once
[#31](https://github.com/Antruly/uvp/issues/31) pinned twelve `errors.ts` survivors
with five more cases, **428** on `main` with the `evidenceHelpers` tests below, and
**447** with the `workspaceManifest` tests below. It is read off
runs rather than remembered — all 936 kill records of run `38919206652` carry
`(391)` — and the figure written here was 396 while the tree it described had 391:
wrong where it was written, and true again by accident once those five cases landed
rather than by anyone correcting it.

**The break threshold is 70, and the sweep is a canary rather than a per-PR
gate.** `thresholds.break` fails the weekly run when the score falls below it. The
first full sweep reported **73.15%**, so 70 is a floor about three points under
the measured baseline — enough headroom for the noise this lane actually has (a
flaky kill, a mutant that times out instead of dying, the difference between this
host and the CI runner) without being loose enough to pass a real regression. It
is a floor, not a target: a run that trips it is telling the maintainer to read
the survivors, which is what the sweep is for. It is one measurement, and it is
re-derived once several weekly numbers exist, and again from the first sweep under
a runner that attributes per test, because [#41](https://github.com/Antruly/uvp/issues/41)
would move the number in a direction nobody has measured — the `command` runner's
exit-code grading makes today's score an upper bound ([#42](https://github.com/Antruly/uvp/issues/42)).

Why a floor here and not on a pull request: the old rationale — a score that gates
a merge invites writing tests that kill mutants rather than find bugs, and nudging
the threshold — is about a person under merge pressure with the threshold standing
between them and `main`. A scheduled run has none of that. **The sweep is a
canary, not a per-PR gate**: it takes 51 minutes 53 seconds, so a lane that slow
cannot run on a pull request, and `mutation.yml` stays `schedule` and
`workflow_dispatch`-only. Tripping the floor produces a failed workflow and a
report to read, which is the outcome the lane exists to produce.

Because Stryker signals a below-threshold run with a non-zero exit, `mutation.yml`
marks the sweep step `continue-on-error` and fails the job in a later step, after
the report is required, the survivors are summarized and the reports are uploaded.
Otherwise the one run that most needs reading would be the one that printed
nothing.

The summary script exits non-zero when the report is **missing** — a run that
produced no report is not a clean sweep, and treating it as one is how a broken
mutation job goes unnoticed for a month. It exits non-zero for one more reason: a
report in which mutants that were planned as a run completed no test describes
the runner rather than the suite, and a percentage over it reads like a suite
that notices nothing. That check is why the defect in [the next
subsection](#mutation-not-a-measurement) was reported as a failure instead of a
score, and it stays: it is the check that would catch the same class of breakage
arriving a second way.

**The upper bound is printed beside the score, and it is not a gate either.** A
kill is the group's exit code, so a group that fails for a reason of its own —
a flake, or damage that stops the run before the suite reports — reads as
detected. The report carries the fact that separates the two without running
anything again: the `command` runner puts the child's combined stdout and stderr
in each killed mutant's `statusReason` (`completeResult` in core's
`command-test-runner.js`), so a kill whose suite ran carries the suite's own
summary there, and a kill without one rests on the exit code alone.
`scripts/ci/mutation-summary.mjs` counts that and prints it under the score —
`Kill basis: all 936 kills carry the suite's own summary, so none rests on the
group's exit code alone.` — and never fails on it. A mutant whose damage stops the
run before the suite reports is conventionally counted as killed, Stryker counts a
mutant that breaks the build the same way, and a check keyed to a test reporter's
wording is exactly the kind that should report a shape change rather than fail a
lane for a reason that is not about mutations.

That reading holds only under the `command` runner, so the report's own
`config.testRunner` decides whether the line is read at all. Under another runner
— the `vitest` runner, where a result travels back over the IPC channel and
`statusReason` is not known to hold the suite's output — every kill would match
nothing, and the honest answer is not `936 of 936 kills carry no suite summary`
but `Kill basis: not read`, with the runner it saw named beside it and the score
still an upper bound. [#41](https://github.com/Antruly/uvp/issues/41) is the
issue that would change it. `npm run verify:mutation-summary` pins each of those
readings against fixture reports, since the real input is a 52-minute weekly
sweep.

### The runner ran no test {#mutation-not-a-measurement}

Measured on this tree at `175b9a7`, with the configuration as it then stood —
`testRunner: "vitest"` over `vitest.mutation.config.ts` — against
`@stryker-mutator/core@10.0.0`, `@stryker-mutator/vitest-runner@10.0.0` and
`vitest@5.0.3`. The runner package is no longer installed; the finding is what it
produced.

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
`index >= path.length`) fails **4 of the 391 tests** in the lane's own scope. The
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

**The decision, taken on 2026-10-16, is the third of the ways below** — the
built-in `command` runner over the whole mutation group. It supplies no coverage,
so core plans every mutant with the global filter and the separator never enters
the path. The command it runs is `node scripts/run-tests.mjs mutation`, and a
mutant is killed exactly when that exits non-zero.

**The first real measurement**, taken from the change that adopted it: a sweep of
`src/domain/errors.ts`, 141 of the eight files' mutants, run against the whole
group. It took **4 minutes 30 seconds** and reported **127 killed, 14
survived, 0 timed out, 0 without coverage** — a score of **90.1%**, with the
reporter's "Ran 1.00 tests per mutant on average" as the line saying the defect is
gone: the `command` runner counts the whole command as one test, so the zero this
document's summary script rejects is what a regression here would look like. That
is **1.9 seconds per mutant** for this slice, measured rather than extrapolated,
and it agrees with the 43-mutant measurement below, so the full sweep — the 1281
mutants `stryker run --dryRunOnly` reports on this tree, 13 fewer than the
defective run's 1294 because the unused bundle shape was deleted from
`src/domain/evidence.ts` in the meantime — projects to **near 41 minutes** on
this host. The job's `timeout-minutes` went from 60
to 90 in the same change, because every measurement here is from an 18-core
workstation and the job runs on a smaller machine: the limit is what turns a
sweep that overruns into a reported failure with its reports retained, rather than
a platform kill with nothing to read.

**The first full sweep is on the record, and it ran inside that projection.** Run
[`38919206652`](https://github.com/Antruly/uvp/actions/runs/38919206652)
(`Mutation sweep`, `workflow_dispatch`, success, 2026-10-16) mutated all eight
files into **1281 mutants**. Its `npx --no-install stryker run` step took **51
minutes 53 seconds** against the 41-minute projection, and it reported **936
killed, 1 timeout, 344 survived, 0 with no coverage, 0 errors — 73.15%**. The
summary script printed `936/1281 mutants detected — score 73.1%` on the day, and
prints `937/1281` beside `344 survivor(s)` for the same report now that it counts a
timeout where Stryker's own metric does — the paragraph below has that counting.
That is **2.4
seconds per mutant** in CI against the 1.9 measured on the workstation this
document's other numbers come from, so the smaller machine costs about a quarter
more time and the 90-minute limit is not close.

**The per-file read**, because the aggregate hides the range: `ToolchainProvider.ts`
94.44%, `errors.ts` 90.07%, `unknown.ts` 86.05%, `bundleDiff.ts` 85.41%,
`evidence.ts` 67.50%, `assertions.ts` 66.41%, `workspaceManifest.ts` 58.59%, and
`evidenceHelpers.ts` **17.65%** — 15 killed against 70 survived, an order of
magnitude below every other file and the largest single read this lane has
produced. `errors.ts`'s 127 killed and 14 survived reproduce the one-file
measurement above exactly, from a different host and a different run shape.

**`evidenceHelpers.ts`'s seventy have been read, and sixty-six of them are
pinned** ([#52](https://github.com/Antruly/uvp/issues/52)). The file had no test of
its own — three test files reached it and all three took `createRecorder` — so the
fifteen that died were the mutants an unrelated test happened to walk. The read is
`src/application/evidenceHelpers.test.ts`, and a one-file `stryker run` over this
tree reports **81 of 85 killed, 95.29%**, against 17.65% before. The four that
remain are equivalent rather than missing: `exactOptionalPropertyTypes` forces the
conditional spread on every forwarded optional, and at two sites in `record` and
two in `recordUnknown` the callee re-checks the same one — `createEvidence`
defaults `derived` and `limitations`, `createResidualUnknown` drops `blockedBy` and
`partialEvidence` — so a key present as `undefined` and a key absent build the same
value. That was measured rather than reasoned about, by building both forms against
the compiled domain code and comparing them as canonical JSON, as key ownership and
as a deep walk that counts a present-but-`undefined` key as a difference: all four
pairs equal, and the mutant that replaces each condition with `false` is the one
left in the report. They are recorded here rather than chased with an assertion
that cannot exist.

**What exit-code grading costs**, stated because it is where a score can still
mislead: there is no per-test attribution left, so a survivor's `coveredBy` no
longer says which test should have caught it; and a mutant whose damage stops the
run from starting at all reads as a kill rather than as a survivor or as a broken
run — which also makes the percentage an **upper bound**, since a group that fails
for a reason of its own is indistinguishable from one a mutant killed. The
survivors are real locations, and each one still has to be read, because a survivor
is either a missing assertion or an equivalent mutant.

**`errors.ts`'s fourteen have been read, and the read is the argument for the
check.** Twelve of the fourteen were missing assertions rather than equivalent
mutants, and they are pinned as of [#31](https://github.com/Antruly/uvp/issues/31):
the retryable table for the four codes whose category says the environment might be
different next time, the `docs` conditional at `:148` in both directions and as an
inversion, the spread it guards, the failure's `name`, the whitespace-only cause,
`retryable: false` on a thrown non-`Error`, a `ZodError` carrying no issues, and the
fallback sentence. The file moves from **90.07% to 98.58%** — 139 of 141.

The two that remain are left deliberately. `:256` and `:257` are the two halves of
one remediation sentence, so killing either means asserting user-facing prose, which
turns every later wording change into a test failure — an assertion that would
measure this document rather than the suite. They are unpinned here and in the test
file, recorded rather than quietly dropped. The sweep's other 260 survivors are
still unread.

**`workspaceManifest.ts`'s fifty-three have been read, and it is the read that says
the most about how a file can look tested and not be.** Twelve cases already reached
this reader, so the mutants did not live in an untested file — they lived in the
shape of the thing. Nineteen more cases pin forty-nine of the fifty-three as of
[#54](https://github.com/Antruly/uvp/issues/54), and the file moves from **58.59% to
96.88%** — **124 killed, 4 survived, 0 timeouts, 0 errors** over the group's 447
tests, in 3 minutes 32 seconds for the one-file run. The largest family was the one
already covered: **seven of the fifteen `StringLiteral` mutants replace a property
name the reader looks up** — `"binary"`, `"template"`, `"libuvcpp"`, `"port"`,
`"name"`, `"requirements"`, `"image"` — so a manifest that stated that field reads as
one that stated nothing, or falls back to `app`. Two replace a literal it compares
against (`"local"` for the kind, `"number"` for `typeof`), one the default it falls
back to, one the encoding, and four a refusal message. None of the fifteen failed a
case. The four `toolchainProblem` mutants survived for a sharper reason — the table
asserting them asserted `toBeTypeOf("string")`, and the empty string is one — so it
now asserts that the reason _exists_, which is the defect those mutants produce,
without pinning prose for the reason `:256`/`:257` above are not pinned.

The four survivors are not gaps, and each is measured rather than argued. A scratch
harness applied each mutation to the **compiled** reader and compared it with the
original by a shape walk, not by `JSON.stringify` — JSON drops a key whose value is
`undefined`, and that is exactly the difference a spread mutant makes — over **4921
inputs**: 4910 manifests from a lattice that walks every value of every field against
every value of every other field, plus eleven raw files (`null`, an array, a number
and a string, an empty file, malformed JSON, a BOM, non-ASCII, a lone escaped
surrogate, invalid UTF-8 bytes, a trailing newline). **No input distinguishes any of
the four**, while two control mutations travelling with them were caught on 2651 and
4260 of those inputs, so the verdict is the comparison's finding rather than a
comparison that cannot see. Separately, `tsc --noEmit` over each mutation says `:88`
and `:107` compile clean and `:135` and `:106` do not — `TS2375` and `TS2345`, the
shapes `exactOptionalPropertyTypes` forbids — which is the second way a mutant can be
unfalsifiable here: `checkers` is empty in `stryker.config.mjs`, so Stryker reports a
mutant the tree could never hold as a survivor. The four sites are
`src/application/workspaceManifest.ts:88:12` (`image === undefined` implies the
conjunction's other operand), `:106:66` (`readFile(path, "")` returns a `Buffer`,
which `JSON.parse` accepts by coercion), `:107:11` (an emptied `catch` leaves
`parsed` `undefined`, and the next line returns `undefined` for it) and `:135:9`
(`Number.isInteger` is false for everything that is not a number).

One question from this read is worth keeping visible because its answer is
one-sided, and because it is the opposite of what `evidenceHelpers.ts` above found. A
key present with the value `undefined` is **not** the same object as an absent key, so
the spread mutants were real missing assertions and the suite now has them —
`toStrictEqual` between them is load-bearing, since `toEqual` ignores exactly this
difference. But no consumer distinguishes the two today: `selectToolchain` compares
`manifest?.toolchain` with `undefined`, `WorkspaceService` reads `manifest?.binary ??
manifest?.name`, `DoctorService` enumerates `manifest.features`, and `??` and
`!== undefined` alike treat a present `undefined` as absent. Those assertions
therefore pin the reader to its own docblock rather than to a caller, and they become
load-bearing the day one of those consumers spreads a manifest or asks whether a key
is there. The sweep's other 207 survivors are still unread.

**`assertions.ts`'s 129 have been read, and it is the read where an unreferenced
function is the whole story.** [#62](https://github.com/Antruly/uvp/issues/62) read
the **90** readable survivors of that file's 129 — 39 of them the compiler refuses, in
the class below — and pinned **84** of them with 38 new cases, so the file's own cases
go from 66 to **104**. The file moves from **66.41% to 94.27%**: **361 killed, 22
survived, 1 timeout**, 0 errors, in **10 minutes 23 seconds** for the one-file run
against the group's **485** tests. Two functions hold **53 of the 90** and a test named
neither. `evaluateJsonPath` is exported, is the module's only statement of what a path
may be, and is reached by no test and by no module outside the file (`jsonPathValue` is
its only caller); with `isRecord` beside it, the block `:66`–`:104` carried **54 of the
file's 129 survivors** — 30 readable, 18 refused, 6 — the largest concentration this
lane has found in one place. The other is `unevaluatedQuestion` and its `brief` helper
(**23**): they build the question a check that could not run leaves behind, they are
called from `VerificationService.ts:469` and `composition/toolHandlers.ts:1036` in
production, and every part of that question is optional, so all four of their
conditionals were mutated in both directions and the cap at 80 characters four ways.

**What the read killed is more than the readable survivors, and that is a finding about
the class below.** Of the 129 survivors the baseline reported, **107** were gone when
the read landed: **84 of the 90 readable**, and **23 of the 39 the compiler refuses**.
[#61](https://github.com/Antruly/uvp/issues/61) added the other four — the read's last
two readable rows and the two refused siblings at the same sites — so **111** of the
129 are now gone and the table holds **18**. A
refused mutant is not therefore an unkillable one — the mutation group runs `src/`
through Vitest, which strips types rather than checking them, so a refused mutant whose
behaviour a new test exercises is a kill like any other, and this read has 23 of them.
That narrows what the class means once a file's read is done: it is a set of sites the
compiler would have stopped, not a set of mutants no assertion can reach.

**The survivor table was reconciled row by row rather than taken as read, and the
reconciliation is itself a finding of the read.** The first sweep left 23 survivors
where the accounting above allowed 22 — 16 the classifier refuses and **7** that
compile, one more than the six the read had accounted for (the four equivalents
measured below and the two rows [#61](https://github.com/Antruly/uvp/issues/61) is
for). The seventh is `:77:21`, a `Regex` mutant that drops the `^` from the dot
branch's pattern in `evaluateJsonPath`, and it is **not** equivalent: over the widened
lattice **338** of the 121,908 inputs differ. With the anchor gone the engine finds the
next `.name` anywhere in what remains of the path, so `$.[0].abc` reads the field `abc`
and `$...a` reads `a` — both paths the pristine walker reports as ones it will not
walk. That is a third state collapsing into a resolved value, which is the damage
#61's two rows do as well, so the row is pinned rather than recorded: two rows in the
refusal table, and the first sweep's 23 survivors are 22.

The **18** that remain are recorded rather than chased. **Four** are equivalent
mutants, measured by driving the compiled module — mutated and unmutated — through
**121,908** inputs: 23 exchange records against all 12 assertion kinds × 10
expectations × 11 targets × 2 negation states, each spec with and without an
`expected` key, plus 9 documents × 52 paths through `evaluateJsonPath`. The comparison
is a shape walk that counts a key present with the value `undefined` as a difference,
because that is the difference an object-literal mutant makes; **no input distinguishes
any of the four**, while four controls travelling with them were caught on **392**,
**1532**, **440** and **4680** of those inputs, so the verdict is the comparison's
finding rather than a comparison that cannot see. The `:85:11` site, `if (close < 0)`,
has two mutants: the `ConditionalExpression` one is refused by the compiler, which is
why the fourth equivalent is the `EqualityOperator` one rather than both. The two rows
left for a fix were [#61](https://github.com/Antruly/uvp/issues/61)'s — `header_matches`
and `body_matches` read an expectation that is not a string as the empty pattern, so a
check that could not run reported `satisfied` — and they are fixed: the expectation is
resolved once, in `patternOf`, and one that is not a string is a check that did not
run, reported `undetermined` with the reason naming the value. The **1280** and
**7744** differences of the lattice are therefore the record of what the substitution
cost rather than a survivor's measurement. The fresh sweep reports **376 killed of
395, 1 timeout, 18 survived — 95.44%**, the four above plus **14** damage the compiler
refuses; the 15 mutants the new helper and its two call sites add are all killed, and
the mutation group is **494** tests. The comparison is now
`scripts/mutation-equivalence.mjs`: it takes a built module, the text edits a report
implies, and the caller's inputs, and it refuses to call anything equivalent when a
control travelling with it is not distinguishable. The numbers above are **not**
re-measured with it — their input lattices were built for their targets and are not in
the repository, which is the part [#57](https://github.com/Antruly/uvp/issues/57) leaves
with each target rather than guessing at — and
`scripts/verify-mutation-equivalence.mjs`, in `check:pr`, holds the instrument with
fixtures whose expected verdicts are arithmetic rather than a claim about any real
read. The sweep's other
**7** survivors are still unread — the six in `evidence.ts` the read below leaves
compiler-refused and `bundleDiff.ts`'s one equivalent — **0** readable once the
classification below is applied. The baseline's **78** had already shrunk to **71**
because tests the earlier reads added killed seven of them, five of those in
`evidence.ts`, and the four `unknown.ts` and five `ToolchainProvider.ts` survivors read
below are the next nine; the `bundleDiff.ts` read below kills 53 of its 54.

**`unknown.ts`'s four have been read, and all four are pinned**
([#66](https://github.com/Antruly/uvp/issues/66)). The file is the vocabulary for
"we could not answer this, and here is why", and its survivors were the vocabulary
itself: two reason members — `unsupported_by_platform` and `ambiguous_requirement` —
that could become the empty string with the suite green, and the two anchors of the
`^unk_[0-9a-f]{22}$` id grammar. The read adds an enumeration of the eight reasons
the contract publishes, in declaration order, so a member added, removed, or respelled
is a diff in the test rather than a silent change to the vocabulary, and a boundary
table for the id: 22 hex digits accepted, 21 and 23 refused, trailing characters
refused, and an `unk_` that does not start the id refused — the last two being the
inputs the dropped anchors would have accepted. The file measures **100.00%** on the
branch, 43 killed of 43, against 90.70% before the read.

**`ToolchainProvider.ts`'s five have been read, and they are four rows of the feature
table plus one sentence** ([#67](https://github.com/Antruly/uvp/issues/67)). The test
file pinned the whole requirements row for websocket, soap, http3, and grpc, and never
looked at http2's `cmakeOptions` or at db at all — so `UVCPP_ENABLE_NGHTTP2` and
`UVCPP_ENABLE_DB` could become `[]` or `""` with the suite green, and the gap record a
caller acts on would name no switch. Both rows are now pinned whole, switch, config
symbol, and header together. The fifth survivor was the no-probe branch's reason text,
unpinned while its sibling — probe answered `undefined` — was only checked for
mentioning the header, so the two third-state sentences were interchangeable. Both are
now asserted exactly, because which sentence a caller reads is what tells them whether
they forgot to supply a probe or the install could not be read. The file measures
**100.00%** on the branch, 90 killed of 90, against 94.44% before the read.

**`evidence.ts`'s have been read, and what is left is the compiler's** ([#65](https://github.com/Antruly/uvp/issues/65)).
The fresh report left eight survivors: six enum members whose `""` mutation cannot flow
into the literal uses downstream — three of `evidence_kind` (one is `"comparison"`, the
kind that says a record looked at nothing), the `coverage.status` member, and two of
`evidence_sources.kind` — and the two anchors of the `^ev_[0-9a-f]{22}$` id grammar.
The two readable ones are pinned by a boundary table over `evidence_id`: 22 hex digits
accepted; 21 and 23 refused; trailing characters refused; an `ev_` that does not start
the id refused; a different prefix refused. The remaining six survivors are the
compiler-refused rows, measured by `scripts/mutation-survivor-kinds.mjs` rather than
assumed: all six are `TS2322`, so the file measures **85.00%** — 34 killed of 40 — and
the gap is damage `npm run compile` refuses, not an assertion the suite is missing.

**`bundleDiff.ts`'s fifty-four have been read, and one is left** ([#64](https://github.com/Antruly/uvp/issues/64)).
**52** of the 54 compiled. The other two are `""` StringLiteral mutations
(`entry.change !== ""`) that `tsc` refuses with `TS2367`; the read's tests kill them
anyway, so what the classifier would have recorded as damage the build already catches
is now damage an assertion catches too. The twenty tests added here pin the paths the
sweep showed were unread: the digest's own field table (`assertions_passed` and
`assertions_failed` move the verdict because the digest covers them), the summary's
key-presence rules (an absent endpoint is not an absent `status`, and a goal nobody
stated is not a goal that did not move), the outcome's inputs (an unchanged row listed
because the caller asked for it does not make the outcome `changed`; an added or absent
exchange does), and the result's sentences — the two-sided incomparability reason, the
duplicate-name reason, and the digest-agreement limitation, each asserted as the
sentence a caller reads. The file measures **99.73%** — 369 killed of 370 — against
85.41% before the read. The survivor is `:329:10–38`, the `left.length === right.length`
conjunct → `true` (the whole-expression mutants are killed), and it is **equivalent
rather than unpinned**: `sameSequence` has exactly one caller, `reordered`, which
reaches it only after sorting both sequences and finding them equal, and equal sorted
sequences have equal length — so the length comparison adds nothing to the element
comparison that follows it. That is a derivation from the caller's guard rather than a
measurement over an input lattice, and it is recorded as one.

**A third of the survivor table is damage the build refuses, which segments the
queue without shrinking it.** [#56](https://github.com/Antruly/uvp/issues/56) is the
question the `workspaceManifest.ts` read above surfaced — with `checkers` empty, how
much of the 344 is mutants the tree could never hold? — asked of the whole table
rather than of one file. `scripts/mutation-survivor-kinds.mjs` applies each surviving
mutant's own replacement text to the span its own report records, runs the project's
`tsc --noEmit`, and restores the file from the report's embedded `source`, which is
the authority for the restore rather than a copy taken when the run started. That
source is also what each location is checked against: a span past its last line, an
inverted span, or a missing one is reported as `undetermined` with the reason rather
than applied, because an unchecked `NaN` offset writes a program nobody described
and the compiler's answer about it would be counted as the mutant's. Over run
[`38919206652`](https://github.com/Antruly/uvp/actions/runs/38919206652)'s report:
**108 of the 344 do not compile** — `assertions.ts` 39 of 129, `evidenceHelpers.ts`
28 of 70, `workspaceManifest.ts` 25 of 53, `evidence.ts` 10 of 13, `errors.ts` 4 of
14, `bundleDiff.ts` 2 of 54, and none of `ToolchainProvider.ts`'s five or
`unknown.ts`'s six. Of the **207** survivors in files whose read is still
outstanding, **51** are in that class, so the queue the sweep's table presents is at
most **156**.

What the class is made of says more than its size, because the diagnostics are not
one kind of thing. These counts are sites that name the code, and one mutant can name
two of them — `TS18046+TS7027` is a row of the table the instrument prints — so the
families overlap and do not sum to 108. `TS2322` (**37**) is a value of the wrong shape
and `TS2375` (**15**) the `exactOptionalPropertyTypes` spread, both of which the type
system forbids outright; `TS2739` (**13**) is an object literal that would lose
properties; `TS2554` (**9**) is a call with the wrong number of arguments; `TS18046`
(**8**) is a value of type `unknown` used as something else; `TS2367` (**7**) is a
comparison the types say cannot hold. `TS7027` — unreachable code, **19** of the 108 —
reads differently from all of those: it is `allowUnreachableCode: false` refusing a
_dead branch_, so the mutant is a control-flow change the build rejects rather than a
shape the types forbid.

Where the dead branches sit is a derivation from the baseline rather than a reading of
the diagnostic's name: the pristine tree compiles clean, so no region of it is already
unreachable to the checker, so the region each of these 19 kills is one the checker
still considered reachable in the unmutated tree. That is a starting point and not a
verdict, and the gap between the two is worth stating rather than rounding off.
**Reachable to the checker is not the same as reachable for some input.** Its
reachability is intraprocedural and takes no view of what a callee can return, so a
branch it cannot rule out can still be a branch no input takes — and for that mutant
the difference is equivalence rather than an unasserted assertion, which is a
different reason to stop reading it. Settling which of the 19 are which is the
per-file work [#54](https://github.com/Antruly/uvp/issues/54) did for one file. What
the family does establish is that the compiler is doing work a test could have done,
which is why these are worth reading before the outright-forbidden 37. By mutator the
class is dominated by `ConditionalExpression` (**38**), `StringLiteral` (**28**) and
`ObjectLiteral` (**16**) — read from the report's own `mutatorName`, and these do sum
to 108.

A survivor that does not compile is not therefore one nobody needs to read, and the
lane is why: the mutation group runs `src/` through Vitest, which strips types rather
than checking them, so all 108 were run and survived anyway — `:106:66` above is one,
a `Buffer` coercing through `JSON.parse`. What the classification establishes is
narrower and was measured rather than inferred: **all 108 are refused by
`tsconfig.build.json` as well**, the configuration `npm run compile` builds with, so
they are damage no built tree could carry. The `typecheck` gate is a separate matter
and does not need this measurement — it runs `tsc --noEmit` under `tsconfig.json`,
which is the very command this instrument runs, so it was already the reason those
108 could not have been merged. So the summary's line — a survivor is a place where
the code can be wrong and the suite still passes — stays true and says less than it
looks like: for these 108 the suite passing is a division of labour with the compiler
rather than a gap in the suite. They are recorded here rather than pinned, and the way
to stop them arriving in the table at all is the checker `checkers: []` above is still
waiting on.

The instrument is part of the change rather than a scratch file, because an
instrument that no longer exists turns a measurement back into an argument:
`scripts/mutation-survivor-kinds.mjs` takes any report, and
`scripts/verify-mutation-survivor-kinds.mjs` holds it with a stub compiler that puts
compiles, refused-with-a-diagnostic and undetermined in one fixture, asserts that each
mutation landed on the span its report named, and is wired into `check:pr`. It is not
wired into the weekly sweep: it costs a typecheck per mutant — **4 minutes 15
seconds** for the 344 survivors of this report — and the report it needs is already an
artifact of that job.

**In that run the upper bound was tightly zero, and the line says so.** Over the
936 kills of the retained report, **936 carry the suite's own summary** in their
`statusReason` and the 344 survivors carry no `statusReason` at all, so no kill in
that sweep came from a group that never reached the suite — the bias is measured
rather than bounded. The strip is what makes that reading possible, and measuring
it is what says so: the record is the child's output **as a terminal sees it**, so
its summary lines begin with an escape sequence, and the same two patterns match
**0 of the 936 without stripping ANSI** against 936 with it. `Kill basis: all 936
kills carry the suite's own summary, so none rests on the group's exit code alone.`
is what run `38919206652`'s summary prints now that the count is in the script;
what it printed on the day is the line quoted above it.

**One number in that job was wrong, and it is fixed rather than explained away.**
The summary counted a `Timeout` mutant as a survivor where Stryker's own metric
counts it as detected — `mutation-testing-metrics@3.8.4`'s
`totalDetected = timeout + killed`
(`dist/src/calculateMetrics.js:170`) — so the same run printed `936/1281 … 73.1%`
beside `73.15%` and listed the one timeout under
`src/application/assertions.ts:74` in a 345-row survivor table, under a caption
saying a survivor is a place where the code can be wrong and the suite still
passes. A mutant that stops the group terminating is not that: the run did not
pass, it did not finish. The counting now comes from that package rather than from
this repository's reading of it — the same source keeps errored, ignored and
pending mutants out of the total, where `total - survivors` had counted them as
detected — so the report above prints `937/1281 mutants detected — score 73.1%`
and `344 survivor(s)`, with the timed-out mutant named on its own line instead.
The score line keeps this document's one decimal, so 73.15% and 73.07% both print
as `73.1%`; the counts beside it are exact, and Stryker's own line uses two
decimals. See [#43](https://github.com/Antruly/uvp/issues/43).

The four ways, all of them still on the record:

- **Own the runner.** A Stryker `TestRunner` plugin over `vitest/node`'s public
  API, recording ids in the `" > "` form vitest matches. It is the only option
  that keeps per-test planning, and therefore the only one whose sweep stays
  affordable. Its size is not measured, and it is not a shim: the package exposes
  `.` and `./package.json` and nothing else, so `VitestTestRunner` cannot be
  subclassed, and the dry run, the setup file that names each test to the
  instrumented code, and per-test mutant activation would all be written here.
  _Not taken._
- **Patch the dependency.** One separator, two copies of `collectTestName`. It
  puts a patched package between what CI installs and what this repository reads,
  for a bug that is upstream's to fix. _Not taken, and the end state to reach if
  the sweep ever needs to be fast: it keeps per-test planning at a fraction of
  the time, at the cost of carrying a patched package and the machinery that keeps
  the patch applied._
- **Run every mutant against the whole scope.** Measured on this host at
  `concurrency: 2`: the 43 mutants of `domain/unknown.ts` took 1 minute 26
  seconds, about **two seconds per mutant**. It grades a mutant only by the
  command's exit code, and it reports `1.00 tests per mutant` because it models
  the whole command as one test. _Taken, as above._
- **Drop the lane.** The cheapest, and it was the honest option while the score
  was wrong: what would be lost is the survivor list, and that list was not real
  either. _Not taken now that the score is real._

The mutation row under _Hardening_ in [roadmap.md](roadmap.md#hardening) records
the outcome rather than the open question.

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

**Sweep reporting.** `npm run verify:mutation-summary` runs
`scripts/ci/mutation-summary.mjs` over fixture reports whose answers are known by
construction, and fails when its output disagrees with any of them. The line it
checks is the kill basis — how many kills carry the suite's own summary, which is
the measurement behind the score's upper bound — and nothing else can check it:
the real input is a 52-minute weekly sweep, and a classification that has stopped
matching prints a plausible count either way. The two failures are silent and
opposite. Vitest's colors are the first, and it is measured rather than imagined:
`statusReason` is the child's output as a terminal sees it, so the same patterns
match 936 of 936 kills **with** ANSI stripped and **0 of 936 without** — a summary
that forgets to strip reports every kill as resting on the exit code alone, every
week. A matcher loosened to a bare `/Test Files/` is the second and the worse one,
because it matches the failing test's own name and reports zero bias always, which
reads as a clean sweep. So the fixtures include a kill whose output mentions a test
file without printing a summary at all, and a report whose `config.testRunner` is
not `command`, where the script has to say it cannot read the basis rather than
report 936 false positives. What this does not establish is that a real report
still has the shape its fixtures have — that is what the kill basis line in the
weekly job's own summary is for, and the two are read together.

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
