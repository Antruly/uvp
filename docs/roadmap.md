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

### The assertion engine's third state

An assertion had two outcomes where the engine had three, and the missing one was
the state this whole framework is built around. `AssertionOutcome.passed` is a
boolean, so a check the engine could not run — a header the client never read, a
body that was never recorded, a body that is not JSON, a regex that does not
compile, a JSONPath the dialect does not support — was assigned `passed: false`
and counted as a failure of the service. That is a finding about a subject derived
from a limit of the check, which is the direction of error
[the evidence rules](evidence.md) exist to forbid.

It showed both faces. `uvp verify` reported `failed` for a pass whose only
non-passing assertion was unevaluable, and `verified` for a pass in which
**every** assertion was unevaluable — the absence of failures read as success,
which is the same defect looking the other way. Negation was where the laundered
state became a lie rather than a mistake: `evaluateAssertion` read
`negated ? !raw.passed : raw.passed`, and `!false` is `true`, so `!header_equals`
on a name nobody looked at was a **pass**. A caller who asked "is this header
different from what I expect?" of a response whose headers were never read was
told yes.

`AssertionOutcome` now carries `evaluated`, negation reads
`raw.evaluated && (negated ? !raw.passed : raw.passed)`, and each unevaluable
check names its own reason. Consumers count only what ran, so `passed + failed`
equals `results.length` and neither counter is a claim about a check that never
ran: `uvp_verify` reports `partial` when part of the goal was unexamined and
`unknown` when none of it was, naming each unanswered question in `unverified`;
`uvp_assert_exchange` records one unknown per unrun assertion; evidence coverage is
`complete` only when every assertion was evaluated and `partial` with
`examined`/`total` otherwise. Two smaller conversions went the same way: a body
nobody recorded is no longer measured as `length 0`, and a request that never
answered is no longer compared against a latency limit.

**No output schema changed, and that is a decision rather than an omission.**
[CONTRIBUTING](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md) puts a
tool's output schema behind a design discussion first, and the third state reaches
a caller through `unverified` and the envelope's `unknowns`, which already exist
and already carry a reason. The open question is whether `results[]` should carry
`evaluated` beside `passed`, or a `status: met | unmet | undetermined` reusing the
capability vocabulary — a `results` row and a capability answer to the same
question should not spell their third state two ways. Until that is settled, the
counter and the coverage note are where a caller learns a check did not run.

What makes this evidence rather than a patch: twenty-three of the engine's
sixty-three tests fail against the previous `assertions.ts`, and each of the three
conformance tests added beside it fails without the fix — `expected 1 to be +0`
for the failure count, `failed` for a status that should be `partial`, and
`failed` for one that should be `unknown`. The fix is what breaks them.

## Hardening {#hardening}

Known gaps in the project's own engineering, tracked here rather than left
implicit.

|     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅  | Every third-party `uses:` under `.github/` is pinned to a commit SHA with the release named beside it, and `npm run verify:actions` fails one that is not — or that pins the same action at two SHAs. Each SHA was resolved with `gh api repos/<owner>/<repo>/git/ref/tags/v4`, never from memory, and each `# vX.Y.Z` label read from the tag list. See [below](#action-pins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ⬜  | A Windows CI lane for `local-msvc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ✅  | Dependabot updates both ecosystems weekly — routine bumps grouped into one pull request per ecosystem, majors left to arrive alone — because a pin nothing updates is a pin that goes stale. Renovate would need an app installed on the repository; Dependabot is GitHub reading a file in it. See [below](#action-pins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ⬜  | Reproducible builds for the packaged tarball                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ⬜  | An SBOM in the release artifacts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ⬜  | Fuzzing the CMake output parser and the HTTP response parser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ✅  | A cap on capture size enforced by the session, not only reported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ✅  | A supervision port, so `application` stops importing `toolchains/local` directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ⬜  | `oxlint` has twice failed a gate on a `dist/` file it should not have been reading; unexplained and unreproduced                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ✅  | CI's database and HTTP/3 coverage: observed at last in run `38801883813` (2026-10-16), the first run in which the real-libuvcpp lane did anything — it reports `UVCPP_DB_ENABLE 1` and `UVCPP_HTTP3_ENABLE 1` in the install's config header, and both the h3 service and the probe's HTTP/3 exchange passed. See [below](#the-real-lane-s-first-run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ✅  | `npm run build:native-probe` builds the HTTP/3 exchange only when the install it is pointed at exposes the HTTP/3 C ABI, so a libuvcpp built without HTTP3/QUIC no longer costs the WebSocket half its native stack. The gate asks the compiler and names the third answer — an install that contradicts itself — instead of concluding "no HTTP/3" and dying in a header. See [below](#the-probe-s-http-3-build-gate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ⬜  | `tests/composition/runCancellation.test.ts` failed once in CI with `expected 'execution_failure' to be 'cancelled'` (run `38805381480`, job _Source tests_, 21.5 ms) and passed on every run since, local and CI. The mechanism is unknown and the row is here rather than in a commit message because an intermittent gate teaches people to re-run until it is green. See [below](#the-cancellation-flake)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ⬜  | `ubuntu-latest` starts moving to Ubuntu 26.04 on 2026-10-19 and the rollout is scheduled to finish by 2026-11-19 (`actions/runner-images#14748`), so for a month a run may land on either image. Two things about the new image come from its own software list rather than a guess: it ships **OpenSSL 3.5.5**, so the real lane's from-source 3.5.0 build becomes redundant rather than broken (it is cached and verifies itself with `nm`), and it ships **CMake 4.4.3**, which no longer accepts `cmake_minimum_required(VERSION < 3.5)` — every declaration in this repository is 3.16 or higher, so that break is not ours. The lane's `apt-get` list is unchanged on 26.04 (`libsqlite3-dev` is there; no `libuv` entry, as today, which is why `libuv1-dev` is installed explicitly). Everything else about running these lanes on a package set never rehearsed here is unknown until it happens |
| ⬜  | Four Actions emit Node.js 20 deprecation warnings on the runner: `actions/checkout@v4`, `setup-node@v4`, `cache@v4`, `download-artifact@v4`. They run on Node 24 today and the warning is not yet a failure — which is exactly the state that ends in a red lane on a date nobody wrote down                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ✅  | A CI test step that sets its own `--reporter` flags loses the skip list, because flags replace the config. `npm run verify:reporters` now fails any `run:` under `.github/` or any `package.json` script that replaces the reporters without naming the skip reporter, and asks `vitest/node` for the reporters a default run resolves to rather than searching the config's text. See [below](#the-skip-list)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ⬜  | Whether `uvp_verify`'s `exchanges[].results[]` should carry `evaluated` beside `passed`, or a `status: met \| unmet \| undetermined` reusing the capability vocabulary. The third state currently reaches a caller through `unverified` and `unknowns`; two spellings of one answer is how they drift. An additive change, but a change to a tool's output schema, so it waits for the design discussion CONTRIBUTING requires                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

At the time, that lane's coverage of the db and h3 rows became a request rather
than an observation, and the row above said so until a run reported it. A run has
now reported it — [below](#the-real-lane-s-first-run). What was observed first, and
recorded as evidence about the lane rather than about the run, is the same lane run
locally against a libuvcpp built the way the workflow now builds it — source
install, `WEB`, `WEBAPP`, `CAPI`, `DB`, `OPENSSL`, `QUIC`,
`HTTP3`, OpenSSL 3.5.0 from source, libuv 1.48.0 from Ubuntu's packages, the
runner's OpenSSL 3.0.13 alongside: 47 tests across 6 files, all passing, including
`http3-service` opening both legs, the probe completing an HTTP/3 exchange against
a generated service, and the database template keeping a value across a restart.
The runner is not this host, so that is evidence about the lane and not a
prediction about the run.

### The real lane's first run {#the-real-lane-s-first-run}

Run `38801883813` (2026-10-16, `97a1d39`) is the first run in which this lane did
anything at all, and it is the run that establishes the four claims above. All
sixteen of its steps succeeded, including the two nobody had watched work:
OpenSSL 3.5.0 built from source for its QUIC API, and libuvcpp 1.7.0 configured,
built and installed with the flag set the lane asks for. The job reported:

```
Test Files  6 passed (6)
     Tests  40 passed | 7 skipped (47)
```

The seven skips are all `containerConformance` — no container runtime on the
runner — and they are the reason the skip reporter below exists: the log said
`7 skipped` and, until it was added, named none of them and gave no reason.

**What the install actually provides**, read from the config header of the
build the lane made rather than from its configure line, which is the check
[the evidence rules](evidence.md) require and the reason the configure line alone
was never enough:

```
#  define UVCPP_NET_ENABLE 1        #  define UVCPP_WSDL_ENABLE 0
#  define UVCPP_WEB_ENABLE 1        #  define UVCPP_YYJSON_ENABLE 0
#  define UVCPP_WEBAPP_ENABLE 1     #  define UVCPP_ZLIB_ENABLE 0
#  define UVCPP_OPENSSL_ENABLE 1    #  define UVCPP_BROTLI_ENABLE 0
#  define UVCPP_NGHTTP2_ENABLE 0    #  define UVCPP_QUIC_ENABLE 1
#  define UVCPP_HTTP3_ENABLE 1      #  define UVCPP_CAPI_ENABLE 1
#  define UVCPP_DB_ENABLE 1         #  define UVCPP_DB_SQLITE_ENABLE 1
#  define UVCPP_DB_MYSQL_ENABLE 1   #  define UVCPP_DB_PGSQL_ENABLE 1
#  define UVCPP_TRY_WRITE_ENABLE 1  #  define UVCPP_UDP_GSO_ENABLE 0
```

Every module the database template, the HTTP/3 template and the probe need is on,
and the install was found by exactly one route — `installed:
/tmp/uvcpp-prefix/lib/cmake/uvcpp/uvcppConfig.cmake`, with no `uvcpp.pc` beside
it — which is the asymmetry the lane's evidence step was rewritten for.

The two rows this settles are the database and the HTTP/3 ones: `UVCPP_DB_ENABLE
1` with `UVCPP_DB_SQLITE_ENABLE 1` read out of the header rather than inferred
from a configure flag, and the two h3 subjects passing — `http3-service: opens
both legs on :8095 and answers on the route table`, and `completes an HTTP/3
exchange with a generated service, both legs answering alike` through the native
probe. `stores a value in SQLite and still has it after the service restarts`
passed in the same job, so the database half is a real restart and not a
connection that stayed open.

The run as a whole was **red**, and the lane was not why: `Packaged CLI and MCP
rehearsal` failed at `97a1d39`, which is the defect `bdeb7e0` fixes. The next push
(`38802214943`) is green in all twelve jobs, so the lane has now run on a commit
that also passed everything else — and the two runs answer different questions.
The first performed both builds and passed; the second found the OpenSSL and
libuvcpp steps served from the caches the first had populated (`skipped`, not
`success`), and passed off them. A lane that builds nothing and a lane that builds
correctly both print a green step, so `38802214943` is evidence about the cache
and `38801883813` is the evidence that the build works.

### The probe's HTTP/3 build gate {#the-probe-s-http-3-build-gate}

The probe compiled its HTTP/3 exchange unconditionally, which made a missing module
in the _install_ the probe's problem: a host whose libuvcpp was configured
`-DUVCPP_ENABLE_HTTP3=OFF` could not build `native/uvcpp-probe` at all, and so lost
the WebSocket exchange's native stack — the one exchange that has nothing to do with
HTTP/3 — to a compiler error about a header.

The gate that replaced it asks the compiler rather than the filesystem, because the
two questions are not the same question:

- _Is `capi/uvcpp_c_http3.h` on disk?_ This was the first attempt, and on an install
  whose generated config header enables HTTP/3 while that header is absent — a
  packager that moved a file, an install copied without one — it answers "no" and so
  concludes "this install has HTTP/3 off". The build then dies on the
  `#include <capi/uvcpp_c_http3.h>` inside `capi/uvcpp_c.h`, the umbrella header that
  **every** translation unit of the probe includes, with `fatal error:
  capi/uvcpp_c_http3.h: No such file or directory`: a sentence about a header nobody
  asked for, naming neither the install nor the fix. The same check is wrong in the
  other direction too, where a header is present that the config header has already
  switched off: it would answer "HTTP/3 available" and then fail to build the
  exchange, because the declarations are not there.
- _Can a translation unit of this probe use the HTTP/3 C ABI here?_ That is what the
  build actually needs answered, and it has three answers rather than two.

`check_cxx_source_compiles` compiles a TU that includes the umbrella header and calls
`uvcpp_c_h3_version`, so the answer accounts for the config header, the headers it
names, and the compiler. It is compiled rather than linked
(`CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY`): the check needs a declaration, not
a symbol, and reaching for the library would pull the install's own dependencies into
a configure step.

| what the compiler said                                       | what the build does                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the HTTP/3 header compiles                                   | build `http3_exchange.cpp` into the probe; `--version` lists `websocket` and `http3`, and reports nothing unavailable                                                                                                        |
| it does not, and the umbrella header compiles on its own     | build the WebSocket half; this install genuinely has HTTP/3 off                                                                                                                                                              |
| it does not, and the umbrella header does not compile either | stop, and name the install as the problem: a config header generated with HTTP3 on whose `capi/uvcpp_c_http3.h` was not installed beside it, fixed by reinstalling libuvcpp so its headers match its generated config header |

The second and third are the pair worth separating — both are "this install has no
HTTP/3", and only one of them is a build that can succeed.

The reason travels with the answer. `--version` now reports `unavailable_exchanges`,
keyed by exchange name and written **even when it is empty**, so a caller can tell
"nothing is missing" from "this probe is too old to be asked" — `exchanges` alone
cannot, because a name absent from a list and a name omitted without a reason look
identical there. The native probe runner prefers that sentence to its own generic
one, because the remedies differ: repeating `npm run build:native-probe` produces the
same binary when what is missing is in the install, and only the build that produced
this probe knows which case it was, since it asked the compiler.

**What was verified, and how.** `tests/toolchain/nativeProbeGate.test.ts` runs real
CMake and a real compiler against three include trees, in the real-libuvcpp lane: the
install as it is (the h3 exchange is built); a copy whose config header is rewritten
to the `0` shape libuvcpp's generator emits for an off switch, with the h3 header
removed (the probe still builds, its `--version` lists `websocket` alone, and the
reason it gives for the missing exchange is the probe's own sentence — built and run,
not only configured); and a copy with only the h3 header removed (the named
`FATAL_ERROR`, and no binary left in the build directory).

The second and third trees are **models**: this install's headers with one generated
file rewritten, not a libuvcpp built with `-DUVCPP_ENABLE_HTTP3=OFF`. They are
evidence about the gate and about the header shape the gate reads, and not about
libuvcpp's generator. The library the probe links in those trees is the real one,
which is enough here: the gate reads headers, and a probe built without the h3
translation unit never calls the ABI that was left out. QUIC is deliberately left on
in the second tree — `-DUVCPP_ENABLE_QUIC=ON -DUVCPP_ENABLE_HTTP3=OFF` is a real
configuration, since HTTP/3 needs QUIC and not the reverse, and this gate does not
read it.

The HTTP/3 test in `tests/toolchain/nativeProbe.test.ts` now carries its own skip,
for the same reason the gate exists: an h3-less probe is a supported configuration,
and a lane that dropped that test without saying so would read as coverage it did
not have.

### The cancellation flake {#the-cancellation-flake}

Run `38805381480` failed one test in the _Source tests_ job, and it is the only
failure this project has seen that has not been reproduced:

```
FAIL  tests/composition/runCancellation.test.ts > a run whose caller withdrew >
      stops the service it started, and reports the withdrawal rather than the deadline
      expected 'execution_failure' to be 'cancelled'   // Object.is equality   21.5 ms
```

Read from that job's blob artifact rather than from the summary: 721 tests, 720
passing, one failing, and the 21.5 ms is the test's own duration — the run ended
almost immediately, long before the 400 ms withdrawal and far inside the three-second
grace a cancellation is given, which is the part that does not fit any path through
the code. The push also carried the skip reporter, which is not implicated: the blob
was written, the summary printed, and every other test in the job passed. Re-running
the failed job came back green on every lane, and locally the file alone and the whole
source lane have passed repeatedly, including pinned to two cores, which is the
condition a loaded CI runner most resembles.

What reading the code establishes, and what it does not:

- Every path in `WorkspaceService.run` that ends a run because the caller withdrew
  produces `cancelled`, and every path that fails to start the supervised process
  produces `launch_failed`. Neither is the literal `execution_failure` that was
  observed. `spawn` with a nonexistent working directory was checked by running it
  rather than by reading the documentation: its `ENOENT` arrives asynchronously, so
  that case lands in `launch_failed` through the readiness wait's own rejection.
- Two mechanisms survive. An unrecognised plain `Error` thrown before the readiness
  wait would arrive at `toUvpError` with no code of its own. So would a real
  `UvpFailure` from a **second instance of the errors module** in one process, which
  would make `isUvpFailure` false and produce exactly the observed code while
  preserving the original message.

Neither has been observed, and a change made for a mechanism nobody has seen cannot
be tested against anything. So the row above stays open, and what was done instead is
that the assertion now prints the failure's message and details alongside the code: a
repeat of the first mechanism prints an error with no `UvpFailure` in it, and a repeat
of the second prints `UvpFailure`, which is the whole difference between them.

### The skip list, wherever a run sets its own reporters {#the-skip-list}

`vitest.config.ts` registers two reporters, and `docs/testing.md` forbids the
summary that would result from registering only the first: a silent skip and a
passing test look identical in a count. A CLI `--reporter` flag **replaces** the
configured list rather than adding to it, so a CI step that passes its own flags
loses the skip names while staying green — the lane reports `7 skipped` and
nothing a reader can act on, and the run that lost them looks exactly like a run
that had none to lose.

Three steps in `ci.yml` pass reporter flags today and all three name
`./scripts/lib/vitest-skipped-reporter.mjs` back. The fourth is the risk: it will
be written by copying one of the three and dropping the flag whose purpose was
not obvious.

`npm run verify:reporters` (`scripts/verify-reporters.mjs`) fails a run that
replaces the reporters without naming the skip reporter. It reads every `run:` in
`.github/workflows/` and in the composite actions under `.github/actions/`, plus
every script in `package.json`, because an `npm` script carrying the flags has
exactly the same effect. `--coverage.reporter` is a different option and leaves
the test reporters alone, so it is not one of these; neither is jscpd's plural
`--reporters`.

Two decisions are worth stating, because both were made against the cheaper
alternative:

- **The config is asked, not read.** The obvious check is
  `vitest.config.ts.includes("vitest-skipped-reporter")`, which is one line and no
  loader. It also passes when the module is imported and then left out of the
  `reporters` array — the first thing an edit that breaks this produces — so it
  would report a registration that does not exist. Instead the script loads the
  config through `vitest/node` and inspects the reporters a default run resolves
  to. That was a quarter of a second, and it is the difference between a check and
  a claim. Reporters are compared by class **name**: the config is loaded through
  Vite's module graph, so the class in the resolved config is not the same object
  as the one the script imports and `instanceof` is false for a correct
  registration. That was measured rather than assumed, because the natural thing
  to write here is `instanceof` and it silently never matches.
- **The scan is not a YAML parser.** Reading `run:` scalars needs one, and this
  repository has none — `scripts/ci/plan.mjs` classifies paths without reading
  YAML at all. What is needed is narrower than YAML: the value of each `run:` key,
  in the three forms a step is written in — one line, a `|`/`>` block, or a value
  that starts on the line below the key. Block lines are consumed as they are
  collected, so a shell script whose content opens a line with `run:` cannot be
  mistaken for a step. A **quoted** scalar that runs past its line is the case
  with no honest reading: it comes back as an empty command, and the scan fails on
  an empty command rather than reading it as a step with nothing to check. That
  guard was tested by writing the form: a `run:` whose value sits on the next line
  used to be the case that tripped it, and now that the plain-scalar form is read
  the same mutation reports the flag inside it instead. An anchor (`run: *cmd`) is
  the one form left out — the flag would live in the anchor's definition, which is
  not a `run:` and is not read. No workflow here uses one.

  The script checks its own rule and its own extraction against inline fixtures on
  every invocation, for the same reason `plan.mjs` checks its lane table: the
  failure mode of a check like this is not being wrong on the day it is written,
  but a rule that stops matching after an edit and a scan that then finds nothing
  wrong.

It runs in the static job beside `verify:test-discovery`, guarded on `workflows`
as well as `code`. The wider guard is the point: a _new_ workflow file classifies
as `workflows` alone, so under the `code`-only guard the case this exists for —
a job added to a workflow of its own — would be the one case it never saw.

Each of these was run against the check before this section was written, and
reverted after: dropping the flag from the source-test step (reported at
`ci.yml:150`); adding a fourth step with `--reporter=json` while the three around
it still name the skip reporter (reported, which is what distinguishes per-step
reading from a whole-file string search); registering the class in the import but
not in the `reporters` array (reported, naming the `[String, Object]` it resolved
to instead); and writing a `run:` whose value is a quoted scalar running past its
line (reported as unreadable, with the `--reporter` remedy correctly left off,
since a remedy about flags is not the answer to a form the scan cannot see).

### The pins, and what keeps them current {#action-pins}

`uses: actions/checkout@v4` names a tag, and a tag is a pointer its owner can
move. Forty references across the six files under `.github/` named one of six
actions that way. All forty now name a commit, and `npm run verify:actions` fails
any that goes back.

**The SHAs were resolved, not remembered.** Each one came from
`gh api repos/<owner>/<repo>/git/ref/tags/v4 --jq '.object.sha + " " + .object.type'`,
which also answers the question a tag list does not: the refs are lightweight
(`type: commit`), so the SHA is the commit rather than a tag object. The `# vX.Y.Z`
beside each pin came from the same repository's tag list —
`actions/checkout@11d5960a… # v4.4.0`, `setup-node@49933ea5… # v4.4.0`,
`cache@0057852b… # v4.3.0` (and `cache/restore`, the same commit),
`upload-artifact@ea165f8d… # v4.6.2`, `download-artifact@d3f86a10… # v4.3.0`,
`github-script@f28e40c7… # v7.1.0`.

**A pin must name its release, and that is not decoration.** Dependabot rewrites
a SHA pin's version comment _only when the comment is on the same line_ as the
`uses:`, which GitHub's own security-hardening page states. So a bare SHA is a pin
whose next update is an unreadable hash, and the rule requires the comment for the
same reason the check exists at all.

**And the pin costs something, which is why the bot is the same change.**
Dependabot alerts do not cover actions pinned to a SHA — they apply to
semantic-version references — so pinning trades an alert for immutability. The
weekly pull request is then where a bump is seen, and a repository pinned without
a bot has taken the immutability and given up the notification. That is why the
two rows above close together rather than in sequence.

**Dependabot rather than Renovate**, because Renovate is an app installed on the
repository and Dependabot is GitHub reading `.github/dependabot.yml`. Only one of
those asks uvp to extend someone's authority over the repository, and it is not
the one chosen. Routine bumps are grouped one-per-ecosystem; a major arrives alone,
because a grouped major is a major nobody read the changelog for. The
`chore(deps)` prefix is load-bearing too: `pr-title.yml` requires a conventional
title, and Dependabot's default ("Bump x from a to b") would fail the gate before
anyone read it.

**Three decisions in the check itself.**

- **One action, one SHA.** Two spellings of `actions/checkout` at two SHAs is what
  hand-pinning produces, and both jobs look pinned while running different code.
  The key is everything before the last `@`, so `actions/cache` and
  `actions/cache/restore` are separate actions — they are separate steps that
  happen to share a repository, and holding them to one SHA would forbid a release
  that moved only one.
- **A form the check cannot read is a failure, not a skip.** `uses:` whose value
  starts on the next line is reported with "whether that action is pinned is
  unknown", because a reference nobody read is a reference nobody checked — the
  same reasoning as the reporter check's empty-`run:` guard.
- **Lines inside a `run:` scalar are masked before anything is matched.** This is
  not hypothetical: `verify-reporters.mjs`'s own extraction fixture contains a
  `run:` block holding a line that begins `run:`. A `uses:` line in shell text is a
  string a script prints, and reporting it would be a false alarm — which is why
  the mutation below includes the control that disables the masking and shows the
  case fails without it.

**The extraction moved rather than being written twice.** Both checks ask the same
question about the same file — which lines are workflow syntax and which are shell
text — so it now lives in `scripts/lib/runKeySpans.mjs`, with its fixture and
self-check, and `verify-reporters.mjs` imports it instead of owning a copy. One
interpretation, two callers, one place to get it wrong.

The CI step is guarded on `code` as well as `workflows`, which is not the same
reason as the step above it: this checker is under `scripts/`, the `code` lane's
territory, so a change to the rule has to run the rule.

**Verified by nine mutations**, each applied, run, and reverted: a tag
reintroduced at one of forty steps (attributed to `pages.yml:25`, not to the
file); a pin that keeps its SHA and loses its comment; one action at two SHAs;
a `uses:` whose value sits on the next line; a `uses:`-looking line inside a `run:`
block, which must stay silent, **and the same case with the masking disabled,
which must not**; a `docker://` image with no digest; and the two self-checks,
shown to fail loudly when a rule table or a fixture expectation stops meaning what
the file says. Turning the masking off is in that list because a case that passes
without the mechanism under test proves nothing about the mechanism.

**One thing this does not establish.** The pins are reviewed by a human like any
other change, and what each action's code does with the permissions a workflow
grants is not something a pin changes. A pin fixes _which_ commit runs, not what
it is allowed to do. Nor is the Dependabot configuration verified here beyond
parsing as YAML and saying what it is meant to say: whether GitHub accepts it is
GitHub's answer, and it arrives on the first scheduled run rather than from
anything run locally.

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
