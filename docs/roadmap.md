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
| ✅  | All six templates generate, build, run, and answer against libuvcpp 1.7.0                        |
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
### http3-service   :8095 -> hello over HTTP/3
```

`http3-service` appears in this list on its **TCP** leg: this table is produced by
a TCP readiness probe and an ordinary HTTP request, and the template binds TCP and
UDP on the same number. Its HTTP/3 leg is verified separately, by a client that
speaks HTTP/3.

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
| ✅  | HTTP/3 end-to-end, template through libuvcpp's own QUIC client        |
| ✅  | TLS with real certificates, including the failure paths               |
| ✅  | Database-backed templates                                             |
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

HTTP/3 was split out for a reason that has since been answered, and the shape of
that answer is worth recording. libuvcpp 1.7.0's web layer has no HTTP/3 listener
at all — `uvcpp_web_app` documents the h2c switch and adds "将来有 h3 时同理",
the same treatment when there is h3 — but the _plain_ `uvcpp_http_server` does,
behind `#if UVCPP_WEB_ENABLE` and reached through `set_quic_ssl_context` plus
`listen_quic`. So the row landed as a **new template** rather than a new feature
on the existing ones: `http3-service` serves one route table over a TCP leg and a
QUIC leg at once, and asking a web-app template for `--features http3` still buys
a build requirement and a guard and no protocol. Both are stated; neither is
implied by the manifest.

The client half is `uvcpp-probe`'s QUIC client, because Node has no HTTP/3 client
at all. That the client and the service come from one implementation is the whole
value: two projects that both claim HTTP/3 can disagree about everything the spec
leaves open, so a Node client reaching an h3 endpoint would not answer the
question uvp exists to ask. `tests/toolchain/nativeProbe.test.ts` generates the
template, builds it with the CMake uvp found, starts it, completes an exchange
over QUIC, and then asks the same route over the TCP leg as the control.

Three things this path refuses instead of guessing, each of which would otherwise
become a green result about a transport nobody used — `http://`, because QUIC has
no cleartext mode; `verify_tls`, because the C ABI's QUIC client verifies against
a CA bundle it is handed or not at all and this tool has no input for one; and
redirects, because the probe makes one request. What comes back says
`verification: not_checked` rather than a certificate nobody examined, reports the
response headers it actually read as a partial set rather than as the whole set,
and reports one duration rather than four phases, because the connection has no
ready callback and a phase measured over the poll interval would be a number
about the poll.

The bundle comparison is the reason `digest` is semantic rather than a record
hash. Two runs of the same check on the same subject produce the same digest, so
a diff between them is a change in the world and not in the clock — and where the
digest stops, the comparison says so instead of guessing. Its unit is a report
`uvp_verify` wrote, addressed by path, because that is the one artifact carrying a
semantic digest: a comparison built on anything else would answer a different
question from the one the digest answers, and the two would eventually disagree
in public.

TLS is the row where the interesting work turned out to be on the failure side.
The client half came first and is described in
[MCP contracts](mcp-contracts.md): a certificate that is not accepted is
`target_unavailable`, not `endpoint_unreachable`, with the reason code OpenSSL
gave rather than prose, and `verification` is four states because the boolean it
replaced conflated a plaintext request, an exchange whose check the caller had
turned off, and one whose certificate was refused. Three of the defects it fixed
were found by measurement rather than by reading — `res.socket` is `null` by the
time `end` fires, so every completed HTTPS exchange had been reported as an
unreachable endpoint; `ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL` begins with
`ERR_SSL`, so a protocol mismatch had been classified as a certificate failure;
and `ERR_HTTP2_STREAM_CANCEL` arrives before the session's own certificate error,
so the code had to be read out of the `cause` chain.

The serving half is where the row's own words earn their place. A workspace
generated with `--features tls` serves HTTPS and **refuses to start rather than
fall back to cleartext**, because that is the one failure a caller cannot see from
their side: a request that asked for HTTPS and got HTTP succeeds, returns the
right body, and says nothing about the traffic being readable. libuvcpp marks such
an app TLS-unavailable so `start()` returns `UV_EINVAL` — its header calls silent
cleartext the worst failure mode here — and the generated `main.cpp` refuses
before `start()` on both of the ways to be misconfigured, naming the file or the
variable. `tests/acceptance/tls.test.ts` compiles a real workspace against a real
libuvcpp, hands it a certificate minted by `openssl`, and asserts all of it: the
certificate it serves is the one it was handed (with a client that was not told
about the CA refusing it, so a service that served something Node already trusted
cannot pass), the self-signed default and the banner saying so, and the two
refusals — half a pair, and a key from a different certificate — each ending
non-zero with **nothing listening** afterwards.

One decision was made against the obvious symmetry. `uvp verify` does _not_ check
the certificate unless asked, which is the opposite of every other command. The
subject of a pass is the service's behaviour, and a workspace generated with
`--features tls` serves a development certificate, so a default that enforced
would fail against the workspace uvp had just generated — a default that makes the
tool's own output unusable is not a safe default. The certificate is reported per
exchange either way, so nothing is hidden, and `--tls` moves it from a note in the
bundle to part of the verdict. The manifest went the other way for the same kind
of reason: it states `features` and not the transport, and the one reader derives
the scheme from that list, because a second field stating the same fact is a
second field that can state it differently.

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

The database row was ambiguous on one point that mattered — does `db` add a
template or change one? — and the answer was in the code that was already there.
`rest-api`'s generated `main.cpp` said, in a comment, to replace its store with
the db module when the service needs durability; a seventh template that was
`rest-api` with a pool underneath would be two copies of one route table, and the
copy nobody edits is the one that drifts. So `db` switches the store:
`--features db` on `rest-api` generates the same routes, status codes and JSON
over `uvcpp_db_pool` instead of an `unordered_map`, reading `UVP_DATABASE_URL`
and defaulting to a SQLite file in the working directory. On the other web
templates `db` is a build requirement and a guard and nothing more, because they
have no store to back — stated in
[libuvcpp features](libuvcpp-features.md#the-db-module-backs-exactly-one-template)
rather than left to be discovered by diffing two generated projects, and stated
again in the tool contract, because that is what a caller reads before
generating anything.

What the lane establishes is durability rather than the shape of the source:
`tests/toolchain/database.test.ts` writes a value unique to the run, stops the
service, starts it again, and reads the value back — because a handler that
answers `{"stored":1}` and then forgets produces the same source and the same
first response. Beside it, the two ways to be misconfigured: a connection string
that cannot be opened ends the process before it listens, with the driver's own
reason and no port held, and no connection string at all opens `./<name>.db`.
The recorded transcript and the decisions behind it are in
[testing](testing.md#the-database-backed-template).

Two limits belong to the row rather than to the lane. **Only SQLite was
exercised**: libuvcpp loads all three drivers at run time, so MySQL and
PostgreSQL are the same template and the same generated code, but only SQLite
needs nothing else present on the host, and uvp reports what it observed rather
than generalising from the one dialect it can reach. And **the pool shares
libuv's worker pool** — four threads by default, the same ones serving `uv_fs_*`
and DNS — which is why generated services bound each statement with a 5 s
timeout instead of resizing a process-global pool, and why the generated README
carries `UV_THREADPOOL_SIZE` for a caller who has measured their own workload.

## Hardening {#hardening}

Known gaps in the project's own engineering, tracked here rather than left
implicit.

|     |                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜  | Pin third-party GitHub Actions to commit SHAs. Workflows currently reference major version tags (`actions/checkout@v4`); full SHA pinning needs the SHAs verified rather than guessed                                                                                                                     |
| ⬜  | A Windows CI lane for `local-msvc`                                                                                                                                                                                                                                                                        |
| ⬜  | Renovate or Dependabot with grouped, reviewed updates                                                                                                                                                                                                                                                     |
| ⬜  | Reproducible builds for the packaged tarball                                                                                                                                                                                                                                                              |
| ⬜  | An SBOM in the release artifacts                                                                                                                                                                                                                                                                          |
| ⬜  | Fuzzing the CMake output parser and the HTTP response parser                                                                                                                                                                                                                                              |
| ✅  | A cap on capture size enforced by the session, not only reported                                                                                                                                                                                                                                          |
| ✅  | A supervision port, so `application` stops importing `toolchains/local` directly                                                                                                                                                                                                                          |
| ⬜  | `oxlint` has twice failed a gate on a `dist/` file it should not have been reading; unexplained and unreproduced                                                                                                                                                                                          |
| ⬜  | CI's database and HTTP/3 coverage is requested but unobserved: the real-libuvcpp lane has built libuvcpp with `-DUVCPP_ENABLE_DB=ON` and with a from-source OpenSSL 3.5 for QUIC only since 2026-10-16, and no run has yet reported what that lane did with either                                        |
| ⬜  | `npm run build:native-probe` needs the HTTP/3 C headers in the install, because the probe compiles `http3_exchange.cpp` unconditionally — so a libuvcpp built without HTTP3/QUIC cannot build the probe at all, and the WebSocket half loses its native stack for a reason that has nothing to do with it |

The `dist/` row is an observation with no diagnosis attached, recorded as such
rather than as a bug report. It has been seen three times, each time as the only
error in the `lint` task, with no rule name:

```
x Failed to open file .../dist/toolchains/local/processRunner.js with error
  "No such file or directory (os error 2)"          # 2026-10-15, first
x Failed to open file .../dist/toolchains/processRunner.js with error
  "No such file or directory (os error 2)"          # 2026-10-15, second
x Failed to open file .../dist/toolchains/processRunner.js with error
  "No such file or directory (os error 2)"          # 2026-10-16, third
Found 26 warnings and 1 error.
```

Read the three lines as one observation rather than three: the name tracks
whatever path that file occupies at the time, so it is not a stale reference to a
file that has moved. In all three cases the file existed and was readable
immediately afterwards — `npm run lint` run again straight after the third
passed with 26 warnings and no errors — and in all three `dist/` had been rebuilt
out of band shortly before the gate (the third run followed a manual
`npm run compile` and `npm run docs:generate` in the same shell), which is
consistent with, but does not establish, a window in which a just-written file is
not yet openable.

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

### The run that showed CI had never tested anything

Every Actions run before `ebda64e` (2026-10-16) failed in its first step, `npm ci`,
on a lock file missing rolldown's darwin-x64 optional binding — npm validates the
whole optional set, not only the platform it is installing for. Twenty-five runs,
twenty-five failures, no lane past installation. Until that commit, every sentence
in this repository about what CI does was a description of a workflow file rather
than an observation of one.

Run `38796990242` is the first observation, at `ebda64e`. Six lanes had never run
before and passed on their first attempt — Classify changes, Static checks, Build
package, and all three test shards. Six failed:

| lane               | what it reported                                                     |
| ------------------ | -------------------------------------------------------------------- |
| Documentation      | `Found dead link ./../README in file roadmap.md`                     |
| Source tests       | `UvpFailure: Port 33097 is already in use` — 705 of 706 tests passed |
| Packaged rehearsal | `npm pack --pack-destination .cache` → ENOENT                        |
| Real libuvcpp lane | `pkg-config --modversion uvcpp` → no such file                       |
| Portable tests     | consequential — see below                                            |
| CI required        | consequential — it exists to fail when any selected lane fails       |

Four were defects. Each is fixed in the tree rather than recorded here:

- **The dead link.** The roadmap pointed at `../README.md`, which is outside the
  VitePress site root; it now uses the absolute blob URL, which is what this file
  already did everywhere else it points outside the docs.
- **The port.** `tests/support/ports.ts` asked the kernel for port 0, which returns
  an _ephemeral_ port — the same pool a TCP client's own source port is drawn
  from. A port free when it was probed can therefore be taken by any outbound
  connection the suite opens a moment later, and the child that was told to listen
  there gets `EADDRINUSE` for a number nobody chose. The file now reads
  `ip_local_port_range` and walks candidates just below it, where the kernel never
  hands out source ports, and says in its own comment what it does on a host where
  that range cannot be read.
- **The tarball.** `npm pack` writes its tarball but does not create
  `--pack-destination`, and `.cache/` is gitignored, so in a fresh checkout the
  directory was not there. The step now creates it.
- **The evidence step in the toolchain lane.** Two mistakes in four lines, both of
  which made it record nothing while looking like it had: it required
  `pkg-config --modversion uvcpp`, which a `cmake --install` of libuvcpp does not
  write (that install carries a CMake package and no `uvcpp.pc`; the prebuilt
  archives are the other way round, so the lane demanded the one form the CI build
  does not produce), and its `grep -E '^#define UVCPP_\w+_ENABLE'` matched none of
  the header's defines, which are indented `#  define` — the `|| true` on the end
  then hid the fact that it had printed nothing. It now prints every module macro,
  requires the modules its configure line asks for, and reports which discovery
  routes are on disk without deciding which one the generated project will use.

The two consequential failures are worth naming because they are the reason to
read a red run's dependencies before its lanes: Portable tests merges the source
lane's report and then requires the source lane to have passed, so it fails
whenever that lane does, and CI required aggregates. Both went red without a
defect of their own.

Fixing the fourth put the lane's real coverage in view, and the news was worse
than one flag. CI's libuvcpp was built with `UVCPP_BUILD_WEB`, `UVCPP_BUILD_WEBAPP`
and `UVCPP_ENABLE_CAPI` and nothing else, while the lane below it builds **all six
templates** and the native probe:

- `UVCPP_ENABLE_DB` defaults to `OFF` in libuvcpp, so there was no database module
  and `tests/toolchain/database.test.ts` — the lane behind Milestone 3's database
  row — was skipping in the only lane that could have run it.
- With no OpenSSL, QUIC or HTTP/3, `http3-service` had no transport to be built
  against, and the probe could not be built at all: it compiles its h3 translation
  unit unconditionally, and with the module off libuvcpp does not install
  `capi/uvcpp_c_http3.h`. That one was verified here rather than argued — a
  from-source install without those modules fails `npm run build:native-probe` with
  `fatal error: capi/uvcpp_c_http3.h: no such file or directory`, which would have
  been the next red step after the one being fixed.

The configure line now asks for everything a template or the probe needs, and the
reason it is not a two-line change is QUIC: HTTP/3 runs on QUIC, QUIC runs on
TLS 1.3, and libuvcpp's configure step wants an OpenSSL at or above 3.2 with
`SSL_set_quic_tls_cbs`. Ubuntu 24.04's 3.0.13 is not one, and libuvcpp forces QUIC
off — and HTTP/3 with it — rather than producing a library that cannot link
against ngtcp2. So the lane builds OpenSSL 3.5.0 from source into a prefix of its
own and points `OPENSSL_ROOT_DIR` at it, exactly as libuvcpp's own `quic` and
`http3` CI legs do, and puts that prefix on `LD_LIBRARY_PATH` for the steps that
run a generated service — its soname is `libssl.so.3`, the same name the runner's
3.0.13 has, so without it a service resolves the dependency out of `/usr/lib` and
the loader refuses it by version: `libssl.so.3: version 'OPENSSL_3.5.0' not found
(required by .../libuvcpp.so)`. That is the shape this failure takes, and it is
worth knowing that it is a refusal to start rather than a missing QUIC symbol
somewhere into a handshake. Both prefixes are cached and both cache keys name
their flag set, so a changed configure line is never served the previous install.

Rehearsing that lane here turned up two more dependencies the lane had been
missing, neither of them about uvp:

- **The libuvcpp prefix belongs on `LD_LIBRARY_PATH` too.** The prebuilt release
  archive's `libuvcpp.so` is self-contained — `libc`, `libstdc++`, `libm`,
  `libgcc` — which is why the real-* lanes never needed a loader entry for it. A
  source install links libuv, libllhttp, libssl, libcrypto and libsqlite3
  dynamically and gives the library no `RUNPATH` of its own, and a binary's
  `RUNPATH` is not consulted for its dependencies' dependencies: the probe found
  `libuvcpp.so` through its own `RUNPATH` on the prefix and then died on
  `libllhttp.so.9.2: cannot open shared object file`, with the file sitting in the
  very directory the `RUNPATH` pointed at.
- **libuv has to be installed, not fetched.** libuvcpp prefers a system libuv and
  otherwise fetches v1.51.0 into its build tree, and the runner image ships
  neither libuv1 nor its headers — its package list has no libuv entry. A fetched
  libuv is linked as a shared library, so the install carries a `libuv.so.1`
  dependency whose only copy is in a build directory nothing puts on the loader
  path, and the failure lands on the first generated service that starts. The apt
  step installs `libuv1-dev` so that dependency is a package the runner resolves.

Neither is visible from the configure line, which is the argument for rehearsing a
lane on the host that will run it rather than reading it.

That lane's coverage of the db and h3 rows is requested from here on; it is not
yet observed, and the row above says so until a run reports it. What _is_ observed
is the same lane run locally against a libuvcpp built the way the workflow now
builds it — source install, `WEB`, `WEBAPP`, `CAPI`, `DB`, `OPENSSL`, `QUIC`,
`HTTP3`, OpenSSL 3.5.0 from source, libuv 1.48.0 from Ubuntu's packages, the
runner's OpenSSL 3.0.13 alongside: 47 tests across 6 files, all passing, including
`http3-service` opening both legs, the probe completing an HTTP/3 exchange against
a generated service, and the database template keeping a value across a restart.
The runner is not this host, so that is evidence about the lane and not a
prediction about the run.

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
[Current status](https://github.com/Antruly/uvp/blob/main/README.md#current-status)
section of the README is the summary a new user reads first.

If you want to work on something here, read
[CONTRIBUTING.md](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md)
first — in particular the contribution scope, which says which changes need a
discussion before a pull request.
