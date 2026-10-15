# Roadmap

uvp is early. This page says what works, what does not, and what is planned —
including the parts that are not planned, because a roadmap that lists only
intentions is a roadmap that never says no.

## Milestone 1 — the closure and the toolbox, in parallel

The first milestone has two halves and they are being built at the same time,
because each one is the other's best test.

### Half one: the framework proves itself

The full loop — describe → generate → build → run → probe → evidence — working
end to end on real libuvcpp.

|     |                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------ |
| ✅  | All five templates generate, build, run, and answer against libuvcpp 1.7.0                       |
| ✅  | Both discovery routes: CMake package and `pkg-config`, version floor on each                     |
| ✅  | Feature-to-switch mapping verified by building, not by reading                                   |
| ✅  | The three-state assessment: `satisfied`, `unmet`, `undetermined`                                 |
| ✅  | 15 tool contracts, shared by the CLI and MCP surfaces                                            |
| ✅  | The services behind them: `DoctorService`, `WebService`, `CaptureService`, `VerificationService` |
| ✅  | The adapters: MCP registrar, CLI registrar, entrypoints                                          |
| ✅  | Packaged install (`npm pack` → install → run) in CI                                              |

The verified pass, run against a real 1.7.0 build:

```
### hello-http      :8090 -> {"message":"Hello, AI"}
### rest-api        :8091 -> {"id":"1","value":"first"}
### websocket-echo  :8092 -> HTTP/1.1 101 Switching Protocols
### soap-service    :8093 -> <?xml version="1.0" encoding="utf-8"?><soap:Envelope …
### static-files    :8094 -> <!doctype html>
```

### Half two: the web toolbox

A test and debug surface for web services — not only the ones uvp generates.

|     |                                                                          |
| --- | ------------------------------------------------------------------------ |
| ✅  | Contracts for request, WebSocket probe, SOAP call, load, capture, assert |
| ✅  | HTTP with redirect policy, timeouts, and byte-accurate timing            |
| ✅  | WebSocket frames: send, receive, expect, close codes                     |
| ✅  | SOAP envelopes with the raw body preserved alongside the parsed one      |
| ✅  | Load testing with per-sample timings retained behind the percentiles     |
| ✅  | Capture with an explicit, reported size limit                            |
| ✅  | The native probe (`uvcpp-probe`) over libuvcpp's C ABI                   |

The probe exists so that a WebSocket check goes through libuvcpp's own stack
rather than through a Node client that happens to speak the same protocol. It
reaches the C ABI (`UVCPP_ENABLE_CAPI=ON`), which is why that switch is on in
the toolchain CI lane.

It is a **separate program**, not a module uvp loads. `native/uvcpp-probe`
reads one JSON request on stdin and writes one JSON report on stdout; the runner
locates it, supervises it, and reads the report. Nothing about it is linked into
uvp, and nothing uvp generates depends on it. `npm run build:native-probe`
builds it against an installed libuvcpp, `UVP_NATIVE_PROBE` points at a build
elsewhere, and a host with neither is reported as `toolchain_unavailable` — a
fact about the host, not about the service under test.

What the C ABI does not expose is reported rather than papered over: the probe
lists its blind spots in `not_observable`, and `abandoned` marks a run whose
report was written without the client loop returning, which on this stack is how
an idle-ended run ordinarily finishes.

## Milestone 2 — more providers

`local/` is the only provider implemented. The port was designed for more from
the start: `inspectAvailability` separate from use, gaps per capability rather
than all-or-nothing, and `ToolchainClient` apart from `ToolchainProvider` so an
inspection-only provider stays implementable.

|     |                                                                                              |
| --- | -------------------------------------------------------------------------------------------- |
| 🟡  | `container/` — build inside a pinned image, reporting the host-filesystem gap honestly       |
| ⬜  | `remote-ssh/` — build and run on another machine, with the provider identity on every result |
| ✅  | A provider conformance suite both of them must pass                                          |

The conformance suite came first, and it is what the two providers below were
written against. Two providers that pass the same suite are swappable; two that
merely both "work" are two code paths.

Twelve obligations, in `tests/conformance/providerContract.ts`, run against a
provider through `ToolchainProvider` and nothing below it. They are values rather
than tests so that `providerSubjects.ts` can hand each one a provider built to
break exactly that clause, and `providerContractFaults.test.ts` requires the
named obligation to reject it and every other obligation to accept it — a check
nobody has seen fail is a comment, and a check that fires on everything localises
nothing. Against the scripted provider they are the control; against the real
providers in `tests/toolchain/` they are the real thing, with the obligations
that need a toolchain skipping by name when the host has none.

Writing it corrected a claim in the port: `modules` is not the `UVCPP_*_ENABLE`
macros, as `ToolchainProvider.ts` said, but the `UVCPP_*` symbols a build defines
as exactly `1` — the installed 1.7.0 header also carries `UVCPP_ENABLE_MEMORY_POOL`
and `UVCPP_DB_RUNTIME_LOAD`. The reader was right and the sentence was wrong.

### `container/` — what is in and what is not

`src/toolchains/container/ContainerToolchainProvider.ts` is written, and it is a
second subject of the conformance suite. Given a container runtime and an image
that is present locally, **all twelve obligations pass**, including the four that
need a build: the suite compiles a generated `hello-http` workspace inside the
image, fails a hand-written one, and interrupts a third. On a host with either
missing, five pass and seven skip, each skip naming the provider's own reason.
The image is built by `npm run build:conformance-image` — see
[testing.md](testing.md#the-container-lanes-image) for what it needs and why the
lane refuses to fetch one. The build obligations themselves are supplied by
`tests/conformance/workspaceSubstrate.ts`, which this lane and the `local` one
share; two subjects asked the same question through two copies of the question
are not being asked the same question.

**In:** runtime discovery in preference order (`docker`, `podman`, `nerdctl`);
refusing an image that is not present without contacting a registry; reporting an
image that is present but will not run as `image_runnable` rather than as a
missing compiler; reading the image's compilers and build systems in one container
start; finding a libuvcpp inside the image with the layouts `local` uses, and
reading `uvcpp_version.h` from the directory the config header was actually found
in; building with the workspace bind-mounted at the same absolute path; and
creating the build directory before mounting it.

**Not in, and not for want of code:** the provider is still not reachable from the
CLI or the MCP surface. Nothing constructs it outside tests, so there is no
`uvp build --toolchain container` and no tool contract declaring what starting a
container would do to the machine. The three questions this section used to list
are down to one:

- **Authority.** Still open. Which flag or manifest key names the image, and
  whether naming one is enough to make uvp start a container on the user's
  behalf. The `effects` block of whatever contract carries this has to declare
  it, and "runs a process on this host" is a different declaration from "contacts
  a network endpoint".
- **Verification.** Answered for the provider, and not by argument: a real podman
  started a real image and real cmake compiled a generated workspace in it, and
  the binary it produced was checked on the host. What remains unverified is the
  _wiring_, which does not exist yet, and which still deserves the same treatment
  once it does.
- **The build obligations.** Done. They ran, and the first run found a defect —
  see below.

**Two things a real run established that reading the code did not.**

- **The build directory had to be created, and was not.** `uvp init` names
  `<root>/build/<name>` as the binary and never creates `<root>/build`; `local`
  never notices because `cmake -B <dir>` creates the directory as it configures.
  The container mounts that directory, and a bind mount of a path that does not
  exist is a hard error, not an empty directory:

  ```
  podman run --mount type=bind,source=<root>/build,target=<root>/build …
  Error: statfs <root>/build: no such file or directory     (exit 125)
  ```

  cmake never ran. Three of the four build obligations failed on this, having
  never failed anywhere before, because no provider had reached the same
  directory by a route that could not create it. The provider now creates the
  directory it is about to mount.

- **A container-built artifact does not run on this host.** The binary the
  container produces carries `RUNPATH=/opt/libuvcpp/lib` — an in-image path,
  written by the generated project's own CMake against the prefix the container's
  search returned. On a host with no libuvcpp at that path, `ldd` reports
  `libuvcpp.so => not found`. This is not a defect in the provider and it is not
  fixed by one: it is what "compiled against an image's library" means. It
  matters because `uvp build` reports artifacts, and an artifact that cannot be
  executed where it was written back to is a limitation a caller should be told.

Until the wiring lands, the honest description of `container/` is: implemented,
conformant in all twelve ways when a runtime and an image are present and in the
five that need neither when they are not, and reachable from nothing.

## Milestone 3 — depth

|     |                                                                       |
| --- | --------------------------------------------------------------------- |
| ✅  | HTTP/2 end-to-end, template through probe                             |
| ⬜  | HTTP/3, gated on the TLS row below                                    |
| ⬜  | TLS with real certificates, including the failure paths               |
| ⬜  | Database-backed templates                                             |
| ✅  | Replaying a capture as a regression suite                             |
| ✅  | Comparing two evidence bundles by semantic digest to see what changed |

HTTP/2 is the first row here that had to be established on the wire rather than
in a string. `uvp init --features http2` now changes the generated C++ — every web
template opens with `app.set_h2c_enabled(true)` when the workspace declared the
module, emitted once from a shared helper rather than five times — and
`tests/acceptance/http2.test.ts` generates, compiles, launches, and asks such a
service for a response over HTTP/2 and then, on the same port and in the same
service lifetime, for one over HTTP/1.1. That second request is the point: h2c and
h1 share one port and are told apart by the 24-byte connection preface RFC 9113
defines, so "the port speaks HTTP/2" and "the port speaks only HTTP/2" are
different claims and only the pair settles which one holds.

What makes the lane evidence rather than a green light is `http_version=2.0`, an
assertion on the version the response **arrived in** — a fact recorded from the
wire, which the caller's `--http-version` cannot supply because that names what to
_attempt_. It is checked where it must pass and where it must fail; a service
asked to negotiate answers HTTP/1.1, so the same assertion goes red and says
`1.1`. The same pair of facts is carried into a bundle, so an HTTP/2 verification
whose report does not say which protocol answered no longer exists, and
`uvp bundle diff` reports two passes over the same verdict at different protocols
as `changed_fields: ["http_version"]` beside `same_digest: true` rather than as
`identical`.

HTTP/3 is split out because it is not a smaller version of the same work. libuvcpp
1.7.0's web layer has no HTTP/3 listener at all — `uvcpp_web_app` documents the
h2c switch and adds "将来有 h3 时同理", the same treatment when there is h3 — so
there is no generated service that could be asked for h3 and nothing a probe could
observe. The C ABI does carry an h3 client and server
(`capi/uvcpp_c_http3.h`, `quic/uvcpp_quic_client.h`), but QUIC mandates TLS 1.3,
so serving it needs a real certificate: the row below is a prerequisite rather
than a neighbour. What uvp says in the meantime is a refusal — `--http-version 3`
is `unsupported_target`, non-retryable, naming the reason — because a client that
quietly sent HTTP/1.1 instead would make the flag a claim about a transport it
never used. The same refusal now also reaches the bundle's `unverified`, so a
report of a pass that could not ask says why.

The bundle comparison is the reason `digest` is semantic rather than a record
hash. Two runs of the same check on the same subject produce the same digest, so
a diff between them is a change in the world and not in the clock — and where the
digest stops, the comparison says so instead of guessing. Its unit is a report
`uvp_verify` wrote, addressed by path, because that is the one artifact carrying a
semantic digest: a comparison built on anything else would answer a different
question from the one the digest answers, and the two would eventually disagree
in public.

Replay turned out not to be about replaying. Sending a recorded request again is
a loop; the work is deciding what "the same request" means when only one side of
the comparison still exists, and that is not a question a pass/fail can carry.
It is why the tool reports what it compared rather than only whether it matched —
a run whose recorded body was cut by the recording limit is `partial`, not
`verified` — and why a run that compared nothing is `unknown` rather than a pass.
Re-issuing a writing method is refused by construction rather than by a note in
the description: only `GET`, `HEAD`, and `OPTIONS` are sent, which is what makes
the contract's absent `mutatesTarget` an observation instead of a promise.

Running it also found a defect in the transport, at a boundary that had nothing
to do with replay: the timing listeners were registered per request on pooled
sockets, where `lookup` and `connect` never fire again, so they accumulated one
set per request until Node reported eleven of them. The `once` listeners were
never going to fire; the fix is to register them only on a socket that is still
connecting. Both the warning and the fix are visible from outside the process,
which is the only reason it was found.

## Hardening {#hardening}

Known gaps in the project's own engineering, tracked here rather than left
implicit.

|     |                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜  | Pin third-party GitHub Actions to commit SHAs. Workflows currently reference major version tags (`actions/checkout@v4`); full SHA pinning needs the SHAs verified rather than guessed |
| ⬜  | A Windows CI lane for `local-msvc`                                                                                                                                                    |
| ⬜  | Renovate or Dependabot with grouped, reviewed updates                                                                                                                                 |
| ⬜  | Reproducible builds for the packaged tarball                                                                                                                                          |
| ⬜  | An SBOM in the release artifacts                                                                                                                                                      |
| ⬜  | Fuzzing the CMake output parser and the HTTP response parser                                                                                                                          |
| ✅  | A cap on capture size enforced by the session, not only reported                                                                                                                      |
| ✅  | A supervision port, so `application` stops importing `toolchains/local` directly                                                                                                      |
| ⬜  | `oxlint` has twice failed a gate on a `dist/` file it should not have been reading; unexplained and unreproduced                                                                      |

The `dist/` row is an observation with no diagnosis attached, recorded as such
rather than as a bug report. It has been seen twice, both times as the only error
in the `lint` task, with no rule name:

```
x Failed to open file .../dist/toolchains/local/processRunner.js with error
  "No such file or directory (os error 2)"          # 2026-10-15, first
x Failed to open file .../dist/toolchains/processRunner.js with error
  "No such file or directory (os error 2)"          # 2026-10-15, second
Found 22 warnings and 1 error.
```

Read the two lines as one observation rather than two: the name tracks whatever
path that file occupies at the time, so it is not a stale reference to a file
that has moved. In both cases the file existed and was readable immediately
afterwards, and in both cases `dist/` had been rebuilt out of band shortly
before the gate — which is consistent with, but does not establish, a window in
which a just-written file is not yet openable.

What the task graph does say is that `compile` runs _inside_ `check:ci` and
concurrently with `lint`: `knip` and `docs:check` both `dependsOn: ["compile"]`,
and `compile` is `clean-build-output.mjs` (which deletes `dist/`) followed by
`tsc` (which rewrites it). An earlier version of this row said `compile` was not
part of the gate at all; that was wrong, and the graph is the check.

It is still not a diagnosis. A stable `dist/` **is** skipped — a file with a
deliberate `no-var` violation placed in `dist/` is not reported, and `dist/` is
in both `.gitignore` and `.oxlintrc.json`'s `ignorePatterns` — and three
reproduction attempts (74 oxlint runs concurrent with an actively churning
`dist/`, including one against a real `npm run compile`) produced no failure at
all. Both times, re-running the identical gate on the identical tree passed: 11
of 11 tasks, 22 warnings and 0 errors, and on the second occasion 617 tests.

So the honest state is: seen twice, not understood, not reproduced. Worth a row
because an intermittent gate teaches people to re-run until it is green, which
is how a real failure gets waved through — but the next person should start from
"it has happened twice and nobody knows why" rather than from a mechanism this
row invented. The two occurrences are alike enough to be one bug and alike
enough to be the same file, which is the most that can be said.

The supervision row was the one place the dependency direction was inverted:
`WorkspaceService` called `startSupervised` from `toolchains/local/processRunner`,
and `sessionStore` imported that module's `SupervisedProcess` type, which the
[layer rule](architecture.md#the-rule-enforced) said cannot happen. Nothing failed
while it spread, because `.oxlintrc.json` enforced that rule for `domain` and
`contracts` only — so the row was not just the refactor, it was the lint rule that
would have caught it, and both landed together.

`src/application/ProcessSupervisor.ts` now holds what `application` needs from a
supervisor: the `SupervisedProcess` type, the three stop outcomes, and
`describeStop`, the one function that puts an outcome into words. `startSupervised`
stayed in `toolchains/local/`, annotated with the port type so the compiler checks
the implementation against the port at the definition, and `WorkspaceService` takes
a supervisor as a required constructor argument — no default, because a default
would have let a wiring mistake compile and surface later as a service that cannot
start. The new `src/application/**` rule in `.oxlintrc.json` is the part that
generalises: a scratch file importing `toolchains/local` from `application` was
confirmed to fail the lint both as a value import and as a type-only one.

## Not planned

Saying no is part of the roadmap.

**A uvp runtime library.** Generated projects must stand alone and depend only on
libuvcpp. A runtime would make every generated project depend on uvp forever,
which is the opposite of the point.

**A C++ MCP SDK.** The control plane is TypeScript. A second implementation would
be a second source of truth, and the two would drift.

**A production deployment tool.** uvp builds, runs, and verifies on your machine.
It does not deploy, scale, or terminate TLS in front of anything.

**A general-purpose load generator.** `uvp_load_test` exists to answer "does this
behave under a little concurrency". A tool that competes with dedicated load
generators would be worse at it and would drag in concerns uvp does not have.

**A hosted service.** uvp is a CLI and a stdio MCP server. There is no uvp
endpoint, no account, and no telemetry.

## How items move

An item is done when a test that would fail without it passes — not when the code
is written. The `🔴`/`✅` marks on this page track the test suite, and the
[Current status](../README.md#current-status) section of the README is the
summary a new user reads first.

If you want to work on something here, read
[CONTRIBUTING.md](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md)
first — in particular the contribution scope, which says which changes need a
discussion before a pull request.
