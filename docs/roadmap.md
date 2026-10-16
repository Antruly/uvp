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

|     |                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ✅  | `container/` — build inside a pinned image, reporting the host-filesystem gap honestly. See [below](#container-wiring)                  |
| ✅  | `uvp_doctor` reads the manifest's container toolchain, so a host with no runtime says so before a build. See [below](#doctor-toolchain) |
| ⬜  | `remote-ssh/` — build and run on another machine, with the provider identity on every result                                            |
| ✅  | A provider conformance suite both of them must pass                                                                                     |

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

**In, since the wiring landed:** the three questions this section listed are
answered, and [the section below](#container-wiring) says how. What a call may
ask for, what a workspace may declare, and what each of the two surfaces does
with it are settled, and `uvp build` on a workspace whose `uvp.json` names an
image now starts that image on the host and reports the image's own identity.

**Not in:** `uvp_doctor` still reports only the host's toolchain. It takes no
path and reads no manifest, so a host with no container runtime and no image is
still described as ready — the gap shows up at the first `uvp build` rather than
before it. That is the row below this one in the table.

- **Authority.** Answered. The image is named by the workspace, in `uvp.json`'s
  `toolchain` key, and by nothing else: a call may _require_ a container or
  refuse one, but cannot designate an image. See
  [below](#container-wiring) for why that split is the one that keeps the answer
  in the file a workspace ships.
- **Verification.** Answered for the provider and now for the wiring: a real
  podman built a real generated workspace inside `localhost/uvp-conformance-image:local`
  through the CLI, the result reported `container
  localhost/uvp-conformance-image:local`, and the claim its `limitations` carry
  was then checked on the artifact rather than asserted —
  `RUNPATH=/opt/libuvcpp/lib`, `libuvcpp.so => not found`, and the binary refuses
  to start.
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
  Both halves are now reported on the result rather than prevented, and the three
  lines above are what the first statement was checked against.

The honest description of `container/` is now: implemented, conformant in all
twelve ways when a runtime and an image are present and in the five that need
neither when they are not, reachable from both surfaces, and unable to answer
`uvp_doctor`.

### Wiring `container/` into both surfaces {#container-wiring}

Three questions had to be answered before the provider could be reachable, and
only the first was a design question in the ordinary sense.

**Who names the image.** The workspace, in `uvp.json`, and only the workspace.
A call gets two words — `container` and `local` — and neither of them carries an
image reference. `container` from a call is a _requirement_ ("build this in a
container") and is refused with `missing_requirement` when no workspace named
one; `local` is a _refusal_ ("not in a container, whatever the workspace says")
and is how a caller checks a container-declared workspace with this host's
compilers. One word per direction, and no way to spell an image on a command
line, because an image chosen by the caller of the moment is an image chosen by
whoever ran the command rather than by the file the workspace ships.

`--toolchain docker` is refused rather than ignored. `docker` is a runtime, not
a toolchain, and a validator that accepted it and fell back would be a flag that
appears to work.

**What an unreadable declaration means.** `readWorkspaceManifest` reports
`toolchainProblem` instead of dropping the field, and the selection rule turns
that into `invalid_request`. This is the one field of `uvp.json` that is an
instruction rather than an observation, so it is the one field whose malformed
value must not degrade to a default — the default here is "build on this host",
which is the opposite of what a workspace that named an image asked for. The
refusal is raised even when the call asked for `local`: a call cannot paper over
a file it did not write.

**What a verification pass does.** `uvp_verify` refuses with
`unsupported_toolchain` and names `toolchain: "local"` as the way past it. A pass
builds a workspace and then starts what it built, and the second half is exactly
what a container build cannot deliver — the artifact carries an in-image RUNPATH.
The refusal is raised _before_ the build, because "the service never came up" is a
verdict about a service and this is not one. Passing the escape makes the bundle
report `local` in its provider, so nothing about the pass claims to be what the
manifest asked for.

**No new effect was needed.** The build contract already declares
`spawnsProcess`, and starting an image is starting a process; "contacts a
registry" would be the different declaration the section above once worried
about, and the provider does not do it — an image that is not present is a
refusal, never a pull. The contract's own `description` says a container build
starts a container, so the sentence a client reads without opening the schema
carries it too.

**What was deliberately not done.** The RUNPATH limitation is _reported_ on the
result rather than prevented, because there is nothing to prevent: the artifact
is correct where it was built, and a build that refused to produce it would be
declining to do the thing it was asked. `uvp_doctor`'s container awareness is its
own row rather than a corner of this one, because doctor takes no path today and
giving it one changes what the tool is.

**And one thing that needed nothing.** `uvp_run` was left alone, which was a
decision rather than an omission, and it was wrong on the first guess and right
on the second. A container-built artifact launched by hand _does_ fail here, and
the failure is the dynamic loader's own:

```
run          run_fb9db8a7ad0341dfb13d28  pid 3742356
ready        no  (still_running: no)
stderr       …/svc: error while loading shared libraries: libuvcpp.so: cannot open shared object file: No such file or directory
evidence     launch:partial
```

So `uvp_run` points at the same limitation `uvp_build` states, in the words of
the thing that knows, and adding a second refusal here would replace a specific
message with a general one. `uvp_verify` is the different case and is refused,
because there the load failure would be read as a verdict about the service.

### `uvp_doctor` and the toolchain a workspace names {#doctor-toolchain}

The section above ends by deferring this: doctor took no path, so it could not
see a workspace's declaration. It takes one now, and the rule it applies is not a
second rule — `doctor()` calls `selectToolchain({ manifest })`, the same function
`uvp build` resolves its provider through, and composition hands both surfaces
the same `toolchainFor`. A doctor whose answer about where a workspace builds
disagrees with the build's is not a doctor.

That resolver is a **required** option rather than one defaulted to the first
registered provider. The default is the trap: a workspace that names an image is
asking about a toolchain this host's provider list may not hold, and answering
with this host's facts under a workspace that said it must not be built here is
the exact disagreement the row exists to remove. When a caller restricts the
report with `--provider` and the restricted list does not include the selected
provider, the report says so in `limitations` — the flag narrows what is
_reported_, and it does not move the subject of the libuvcpp and feature sections,
which the workspace decides.

**The image that cannot be examined.** This was the one real decision. The port
already answers it: a provider that cannot run its toolchain at all throws
(`toolchain_unavailable`) rather than answering `found: false`, because `found:
false` means "there is no libuvcpp here" and a caller reading it has no reason to
open `limitations` — the note `LocalToolchainProvider` writes is for a reader who
already knows to look. So the doctor catches that refusal, for a container
selection and for that code alone, and does three things with it:

- the toolchain entry for the image is reported as what it is, `available: false`
  with `container_runtime` in `missing` and the reason it was looked for;
- the libuvcpp section reports **this host's** install, labelled as such, with a
  limitation in the report's own voice — `Nothing here describes <image>: the
  libuvcpp below is this host's own install, and this workspace does not build
  with it`;
- every requested feature comes back `undetermined` with the provider's sentence,
  never `unmet`, and each is recorded as a `toolchain_missing` unknown blocked by
  the provider's own remedy.

The third of those is the one that would have been easy to get wrong in the other
direction. A container workspace on a host with no runtime is a host that cannot
look, and "this build does not provide TLS" is a finding about a library the build
will not use.

**The probe is not rooted at the image's prefix.** The install prefix a container
provider reports is a path _inside_ the image. Pointing `headerProbeAt` at it would
`stat` this host, where nothing is there, and answer `false` for every header-only
feature — converting "this host cannot look" into "that build does not have it",
which is the one inference `assessFeatures` keeps an `undetermined` state for. A
container selection therefore gets the probe that always answers `undefined`. The
conformance lane pins this the way it deserves: the fixture creates
`include/grpc` in the workspace and points the image's prefix at it, so a probe
that followed the prefix would find the header and report `satisfied`.

**The envelope stopped lying about it.** `DoctorReport` carries the selected
provider's identity and the handler stamps that instead of the first provider's. A
report whose libuvcpp section came out of an image and whose envelope says `local`
is a result that contradicts its own body.

**What the row did not add.** No new tool, no new effect, no new field: `workspace`
already existed on the input, and the report's shape is unchanged. The doctor still
never builds, never pulls an image and never starts a container — it reads the
declaration and reports the prerequisite, which is the whole point of asking before
a build rather than after one.

**One extraction, because the change made the method too long.** Teaching
`doctor()` the manifest's toolchain pushed it past oxlint's function-length limit
(136 lines) and pushed `#assess` past it too (113), so the per-provider loop became
`#inspect` — the one half of the report that is about this host, which is also the
half a `--provider` restriction moves — and `#assess`'s two "nothing could be
decided" exits became one `undecidable()` pair plus an `allUndetermined()` that
records each feature against the same blocker. `#assess` also took its subject as
one record rather than five parameters, since `build` and `unexamined` come out of
`#libuvcppOf` together and are never apart. The file goes from one pre-existing
warning to none, and the repository's total is where it was; the fix was the
extraction rather than a raised limit, which is what the earlier rows in this file
did for the same rule.

**Evidence.** Five tests appended to
`tests/conformance/handlers.test.ts` (the file goes 68 → 73), all at the
production boundary through the registered handler: the unexaminable image in the
provider's own words, the libuvcpp asked of the image rather than of this host
(a fixture whose modules are empty and whose version differs, so the host's list
cannot be what answered), the probe that must not follow the prefix, the refusal
of a declaration that could not be read even when the call passed its own
features, and the restricted report that discloses what it is restricted away
from. Seven mutation arms were run against them and all seven were caught:

| arm | what it breaks                                                     | tests that fail |
| --- | ------------------------------------------------------------------ | --------------- |
| M1  | `selectToolchain` replaced by a fixed `local` selection            | 5               |
| M2  | `#libuvcppOf` asks the host's provider instead of the selected one | 3               |
| M3  | the `toolchain_unavailable` refusal is no longer caught            | 1               |
| M4  | the container probe rooted at the image's install prefix           | 1               |
| M5  | the `--provider` restriction disclosure deleted                    | 1               |
| M6  | the "nothing here describes `<image>`" limitation deleted          | 1               |
| M7  | the handler stamps the first provider instead of the report's      | 1               |

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

### The assertion engine's third state {#assertion-third-state}

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

**The output schema changed, and the third state now has one name everywhere.**
[CONTRIBUTING](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md) puts a
tool's output schema behind a design discussion first, and the question left open
here was whether `uvp_assert_exchange`'s `results[]` should carry `evaluated`
beside `passed`, or a `status` reusing the capability vocabulary. It carries
`status` — the second option — and the vocabulary is declared once, in
`src/domain/verdict.ts`, as `satisfied | unmet | undetermined`.

Three facts decided it. The same question was already answered in that vocabulary
by `uvp_doctor` (`satisfied | unmet | undetermined`, declared inline in
`DoctorService.ts` and again as a `z.enum` in the toolchain contract), and a
`results` row and a capability answer that spell their third state two ways are
two vocabularies to keep true. `evaluated` beside `passed` is that same pair
re-encoded, which is the duplicated interpretation
[the architecture rules](architecture.md) keep out of a boundary. And the row
that a caller reads is the right place for the answer: `results[]` now holds one
row per assertion asked, `not_evaluated[]` is gone, and
`satisfied + unmet + undetermined` is `results.length`, so a check nobody could
evaluate is visible in the array rather than inferable from a counter. The
envelope's `unknowns` and the `partial` coverage note still carry it, which is
where `uvp_verify` reports it and stays as it was: `uvp_verify` has no per-check
rows, and its third state reaches a caller through `unverified[]` and `coverage`; its
exchange counters are `assertions_passed`/`assertions_failed`, which its own contract
declares and which this change leaves alone. The assertion evidence record inside the
bundle does carry the three words now, because a bundle that spelled "nobody could tell"
one way while the tool result it came from spelled it another is the duplication this row
was opened for.

The engine followed. `AssertionOutcome` carries `status` instead of
`evaluated` + `passed`, negation is `negateVerdict` — which leaves
`undetermined` alone, because the check that must not be inverted into a pass is
the one that never ran — and the two counts moved to `tallyVerdicts`, so one
function decides what a status contributes to a total. `uvp assert` renders the
three states (`ok`, `FAILED`, `unknown`) and exits `2`, not `0`, when a check went
unanswered: the exit codes are a two-way answer to a three-way question, and the
collapse that must not happen is the one where "nobody could tell" reads as
"everything held". This is a breaking output-schema change for `uvp_assert_exchange`
and for `AssertionOutcome`; the catalog and the shipped skill were regenerated
from the contracts, and the conformance test that pinned "an assertion it could
not evaluate" as a missing row now pins it as a row whose `status` is
`undetermined`.

What makes this evidence rather than a patch: twenty-three of the engine's
sixty-three tests fail against the previous `assertions.ts`, and each of the three
conformance tests added beside it fails without the fix — `expected 1 to be +0`
for the failure count, `failed` for a status that should be `partial`, and
`failed` for one that should be `unknown`. The fix is what breaks them.

## Hardening {#hardening}

Known gaps in the project's own engineering, tracked here rather than left
implicit.

|     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅  | Every third-party `uses:` under `.github/` is pinned to a commit SHA with the release named beside it, and `npm run verify:actions` fails one that is not — or that pins the same action at two SHAs. Each SHA was resolved with `gh api repos/<owner>/<repo>/git/ref/tags/v4`, never from memory, and each `# vX.Y.Z` label read from the tag list. See [below](#action-pins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ⬜  | A Windows CI lane for `local-msvc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ✅  | Dependabot updates both ecosystems weekly — routine bumps grouped into one pull request per ecosystem, majors left to arrive alone — because a pin nothing updates is a pin that goes stale. Renovate would need an app installed on the repository; Dependabot is GitHub reading a file in it. See [below](#action-pins)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ✅  | The packaged tarball is a fact about its contents and a promise about them: `npm run verify:pack-reproducible` packs it three more times — twice more from the tree, once from the first tarball's own contents unpacked at another path — fails if any digest differs, and fails when a path `package.json`'s `files[]` names is not delivered. Measured stable across repeated packs, pack destinations, an unpacked copy at another path, and a clean rebuild of `dist/`; another machine, npm version and filesystem are not established. It also found that no tarball had ever contained `THIRD_PARTY_NOTICES.md`, which tells a redistributor to keep it. See [below](#pack-reproducibility)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ✅  | A published docs page was an empty shell: `docs/roadmap.md` quoted a GitHub workflow expression in an inline code span, Vue read its braces as an interpolation, the render threw, and VitePress logged the error and **exited 0** — so CI stayed green while the roadmap page shipped with no content in it, 16 KB against 73 KB for `testing.html`. The expression is escaped now, and `npm run verify:docs-interpolation` fails the next one, asking `docs/.vitepress/config.ts` which files are pages rather than restating its `srcExclude`. See [below](#docs-interpolation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ✅  | The documentation told a reader to run six commands that do not exist, and the licence inventory it pointed at for the dependency set was stale in the commit that imported it — 24 packages and 5 direct dependencies recorded against a `package.json` declaring 3. Nothing read either, because nothing ran the generator. Both are checked now, and each new rule is measured against known text before it is trusted. See [below](#dependency-inventory)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ✅  | An SBOM in the release artifacts: `sbom.cdx.json` is CycloneDX 1.5 over the production npm closure, written by `npm run sbom:generate`, compared byte for byte by `npm run sbom:check` inside `docs:check`, and shipped in the tarball along with `THIRD_PARTY_NOTICES.md` and `licenses/npm-dependencies.json`, neither of which any tarball had contained. `npm sbom` was measured before it was rejected: under `--omit dev` it omits `zod`, a declared dependency a user installs; without it, it describes ~300 dev tools; and reading a tree describes this host's stale `node_modules`. The closure walk is shared with the licence file now, so the two cannot disagree. See [below](#sbom)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ✅  | The build-output parser and the response decoder are fuzzed from generated input as well as from captured output: `tests/support/fuzz.ts` is a seeded generator, `src/toolchains/diagnostics.fuzz.test.ts` and `src/application/httpClient.fuzz.test.ts` state invariants over what it draws, and the first run found a real defect — the file part of a Windows diagnostic ended at the drive colon, so every `C:\…\main.cpp:12:5: error:` line in a build log was dropped. It also found a `TypeError` in the transport classifier and made it reachable: `code.startsWith` on an error whose `code` is not a string. See [below](#fuzzing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ✅  | A link failure has a diagnostic format here, written from captures of real ones rather than from a plausible-looking log: `ld: cannot find -luvcpp`, gold's `ld.gold: error: cannot find -luvcpp`, a located `undefined reference to` naming the symbol and the caller's own source line, the same reference in a build with no debug information where only a section offset is left to name, a `multiple definition of` with its "first defined here" trail, and the driver's `collect2: error: ld returned 1 exit status` — which is held back until the whole scan is read, so a link failure the linker stated plainly does not print twice. All of them answer `phase: "link"`, the phase the contract has had since the beginning with nothing producing it. The same captures found the other half: `ld` and GNU Make translate their messages, so on a `zh_CN.UTF-8` host this failure reads `找不到 -luvcpp` and matches nothing — every build subprocess now runs with the language its output is read in. See [below](#link-failures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ✅  | `decodeBody` answered `decoded_as_text: true` with text that is not the response's bytes when a peer declared a text content type and sent something that is not UTF-8: `Buffer.from([0x48, 0x69, 0xff])` became `"Hi\uFFFD"`, which re-encodes to three different bytes, and no field in the output said so. `text_lossy` names which of the two causes it — the peer's bytes, or a cap of the caller's that cut a character in half — and the three answers are asserted over a real socket as well as against a known-answer table. The two had to be told apart first, and the fact that tells them apart is `cutShort`, which only the caller knows; the SOAP path, decoding the same bytes a second time, was the same defect in a third place. See [below](#lossy-text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ✅  | A body the text is not was handed over as text alone: `decodeBody` answered with `text` or with `base64` and never both, so a caller whose text came back lossy could not obtain the bytes it was decoded from — `text_lossy` named the loss and `digest` is over bytes that no longer travelled with the answer. The two travel together now, under a rule written as an equivalence rather than a preference: `base64` is present exactly when `text` is not the body's bytes, so which of them a caller reads first has one answer — the bytes when they are there, the text otherwise — and `text_lossy` says why they differ. The SOAP path's cut moved from 64 Ki characters of the decoded envelope to 64 KiB of the envelope's bytes in the same change, because a cut on code units can split a surrogate pair and did report a loss for envelopes whose every character was whole. See [below](#lossy-text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ✅  | `uvp_soap_call` handed a caller the first 64 KiB of the envelope's bytes and offered no way to ask for more: an envelope past the cap arrived cut, with `truncated`, `text_lossy` and `base64` saying exactly that, and the rest of it was unreachable. The cap is the caller's now — `max_body_bytes`, the name and the smaller-of-two rule `uvp_http_request`'s body cap already uses — and the question the row left open is answered by what the fields already were: `bytes` and `digest` are taken over the envelope as received rather than over the prefix handed over, so a caller who asked for too little still holds the name of the response and can ask again for the rest of the same body. No cap is refused, because the call reads the whole envelope whatever it says — the fault comes from all of it — so a cap larger than the envelope asks for bytes that are already in hand, and the transport's own read limit stays the ceiling, reported by `truncated` as it was. See [below](#lossy-text)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ✅  | A cap on capture size enforced by the session, not only reported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ✅  | A supervision port, so `application` stops importing `toolchains/local` directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ⬜  | `oxlint` has failed a gate three times on a `dist/` file it should not have been reading; unexplained, and unreproduced by six tests of four candidate mechanisms named below, so `lint` now records the tree state when it fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ✅  | CI's database and HTTP/3 coverage: observed at last in run `38801883813` (2026-10-16), the first run in which the real-libuvcpp lane did anything — it reports `UVCPP_DB_ENABLE 1` and `UVCPP_HTTP3_ENABLE 1` in the install's config header, and both the h3 service and the probe's HTTP/3 exchange passed. See [below](#the-real-lane-s-first-run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ✅  | `npm run build:native-probe` builds the HTTP/3 exchange only when the install it is pointed at exposes the HTTP/3 C ABI, so a libuvcpp built without HTTP3/QUIC no longer costs the WebSocket half its native stack. The gate asks the compiler and names the third answer — an install that contradicts itself — instead of concluding "no HTTP/3" and dying in a header. See [below](#the-probe-s-http-3-build-gate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ⬜  | `tests/composition/runCancellation.test.ts` failed once in CI with `expected 'execution_failure' to be 'cancelled'` (run `38805381480`, job _Source tests_, 21.5 ms) and has passed on every run since, local and CI, including 300 standalone runs of that file on this host with none. That bounds how often it happens here rather than explaining it: the one occurrence was in CI, where the load and the image are things this host does not reproduce. See [below](#the-cancellation-flake)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ✅  | `tests/conformance/captureReplay.test.ts` has failed **four** times with `TransportFailure: socket hang up`, each from a request through a capture proxy: twice inside a full local gate (2026-10-16T05:59:33Z, 06:56Z) and twice from standalone runs on an idle machine, which ruled the gate's load out and settled that this row wanted a sample rather than a theory. The proxy's number had been handed out twice, and the client's global keep-alive pool still held a socket for that `host:port`; the mechanism is constructed rather than sampled below. Fixed at the reservation, where a number is now handed out once per process, with a test that measures its own strength. See [below](#socket-hang-up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ⬜  | `ubuntu-latest` starts moving to Ubuntu 26.04 on 2026-10-19 and the rollout is scheduled to finish by 2026-11-19 (`actions/runner-images#14748`), so for a month a run may land on either image. Two things about the new image come from its own software list rather than a guess: it ships **OpenSSL 3.5.5**, so the real lane's from-source 3.5.0 build becomes redundant rather than broken (it is cached and verifies itself with `nm`), and it ships **CMake 4.4.3**, which no longer accepts `cmake_minimum_required(VERSION < 3.5)` — every declaration in this repository is 3.16 or higher, so that break is not ours. The lane's `apt-get` list is unchanged on 26.04 (`libsqlite3-dev` is there; no `libuv` entry, as today, which is why `libuv1-dev` is installed explicitly). Everything else about running these lanes on a package set never rehearsed here is unknown until it happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ✅  | The runner warned that Node.js 20 was deprecated, naming five of the six actions pinned here by SHA. `runs.using` in each action's own `action.yml` read `node20` at all six pinned SHAs and `node24` at every major Dependabot proposed, which is how the sixth was counted without waiting for a warning about it, and all six are adopted in [the pins above](#action-pins). Two of the majors change more than their runtime, both read rather than assumed: `setup-node` v5 caches by itself when `package.json` declares a `packageManager`, which this one does and `.github/actions/npm-cache` already owns, so it is switched off at all 11 call sites; `download-artifact` v8 fails a run on a digest mismatch where it used to warn. `checkout` v7 refuses a fork's code under `pull_request_target` — the event `pr-readiness.yml` uses — but its guard reads the requested ref, repository and commit, and that workflow asks for the default branch and none of those.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ✅  | A CI test step that sets its own `--reporter` flags loses the skip list, because flags replace the config. `npm run verify:reporters` now fails any `run:` under `.github/` or any `package.json` script that replaces the reporters without naming the skip reporter, and asks `vitest/node` for the reporters a default run resolves to rather than searching the config's text. See [below](#the-skip-list)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ✅  | `uvp_assert_exchange`'s `results[]` carries `status: satisfied \| unmet \| undetermined` in place of `passed`, one row per assertion asked, and `not_evaluated[]` is gone: `satisfied + unmet + undetermined` is the row count, so a check nobody could evaluate is visible in the array rather than inferable from a counter. The vocabulary is declared once, in `src/domain/verdict.ts`, and `uvp_doctor`'s feature verdicts read it too. `uvp_verify` is unchanged — it has no per-check rows, and its third state reaches a caller through `unverified[]` and the coverage note. See [below](#assertion-third-state)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ✅  | A workflow job whose own `if:` is wider than its steps assume: `test` runs whenever the run is not cancelled, so that a failed shard still produces a merged report, but it downloaded `uvp-test-runtime`, which `build` uploads only when `code` or `package` is selected. Two documentation-only pushes (`315d494`, `0dcbd94`) went red in _Portable tests_ at `Download the built runtime` while every lane that job depends on was correctly skipped, and the guard the job does carry sits below the download. The three artifact steps are guarded on `code` individually, a step above them says which of the two cases the run is in, and `npm run verify:artifact-guards` now compares every reader's condition against its writer's as a logical implication. See [below](#artifact-guards)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ⬜  | The worked example in `docs/evidence.md` was hand-written, and every field it showed was wrong the same way: a `vb_`-prefixed `bundle_id`, `evidence_ids`, `unknown_ids`, and `members[]` entries carrying `subject`, `observed` and `derived`. No tool returns any of those; the page shows two captures of a real pass now. They settled the claim beside the example too, that the envelope holds references "so the bundle holds the detail". It does not: `toEvidenceRef` drops `subject`, `observed` and `derived`, the bundle carries the same references, and `digest` is computed _from_ the fields that were dropped, so a reader can compare two runs but not see what either observed. Making it reachable changes every tool's output, so it waits for the design discussion CONTRIBUTING requires. The same reading found one thing declared twice: `createEvidenceBundle` in `src/domain/evidence.ts` takes full `Evidence[]` records and has no production caller, while the shipped bundle is `verificationBundleSchema`. The unused one now says so in its own docblock, where it used to call itself "The deliverable" — a claim the contract's shape holds and this one does not, and its own docblock already said which two tools agree about it. Neither changed behaviour: the two differ in exactly one thing that matters, whether the records travel. **What is left is one decision, and it is not a documentation one:** delete the record-carrying pair (foreclosing the option) or adopt it (changing what every tool returns). So the row stays open, and it is now only the decision rather than the decision plus a false claim in the source. `uvp_build` and `uvp_verify` are unaffected either way. |

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
```

These three lines are one error from each of the three occurrences, and the block as
it stood read as one run's output — which no log that survives is. The two
occurrences that left a log, both from 2026-10-15, 18:16 and 18:58 local, each
contain a single one of those lines followed by `Found 22 warnings and 1 error.`,
and turbo's own summary for both reads `Failed: //#lint`: the open failure is the
`lint` task's only error and it is what turns the gate red. The `Found 26 warnings
and 1 error.` that stood under the three lines is the third tree's total — the run
that followed the third occurrence, above, reports 26 warnings and no errors — but
the third occurrence kept no log, so what its own summary said was not observed.

The two logs also settle what the section could only infer from the task graph:
`compile` really does run beside `lint` — `compile:` and `lint:` output interleaves
through both logs, and `clean-build-output.mjs` deleting `dist/` while `tsc` rewrites
it is what a walk would be racing.

Read the three lines as one phenomenon rather than three: the name tracks
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
all. For two of the three, re-running the identical gate on the identical tree
passed: 11 of 11 tasks with 22 warnings and 0 errors on one, and 617 tests on
the other.

So the honest state is: seen three times, not understood, not reproduced. Worth a
row because an intermittent gate teaches people to re-run until it is green, which
is how a real failure gets waved through — but the next person should start from
"it has happened three times and nobody knows why" rather than from a mechanism
this row invented. The three occurrences are alike enough to be one bug and alike
enough to be the same file, which is the most that can be said.

**Six more tests, of four mechanisms, all negative** (2026-10-16). Each was run
against the configuration as it is committed, and each is named so the next attempt
does not repeat it:

- **The walk entering `dist/`.** A file at `dist/zzz-probe.js` holding a deliberate
  `no-var` violation is not reported by a bare `oxlint`, and `oxlint
  dist/zzz-probe.js` — the same path as an argument — reports nothing either.
- **The walk racing the deletion.** Sixty runs of a bare `oxlint` with `dist/`
  renamed away at a random 20–600 ms into the run produced no failure. That is the
  method the three attempts above used, with a window that opens with a rename
  rather than after a build.
- **An ignore that depends on the walk root.** `oxlint` run with its cwd inside
  `dist/` answers `No files found to lint. Please check your paths and ignore
  patterns.` — the exclusion holds from there as well as from the root, so a run
  that somehow started below `dist/` is not it either.
- **An import resolved into the build output.** Exactly one file in the repository
  spells a `dist/` path in an import — `tests/boundary/process/fixtures/detachParent.mjs:1`,
  whose specifier is the very path two of the three errors name — and that is the
  shape worth suspecting, because a resolver opens a file rather than walking it.
  This `oxlint` resolves no specifiers at all: a temporary file importing a module
  that does not exist reports nothing, and one importing a `dist/` file carrying a
  `no-var` violation reports nothing from it.

What is left is narrower and still not a mechanism. Something opened one file under
`dist/` at a moment when it was not there; `compile` was deleting and rewriting
`dist/` at the time; and it is not the walk, not the race, not the walk root, and not
a resolution. Instrumenting the next occurrence is worth more than a seventh guess —
the error prints the path and nothing in the three logs says where the path came
from.

**The next occurrence will arrive with evidence** (2026-10-16). That is the
instrumentation the paragraph above asked for: `npm run lint` now runs
`scripts/lint.mjs`, which spawns oxlint unchanged and, on a non-zero exit only,
prints the tree as it failed — the argv oxlint was handed, its version, whether
`dist/` exists and how long ago it was written, the state of every path the run
named as unopenable, the newest files under `dist/`, and the build processes alive
in this repository with their ages. A passing run costs one process and prints
nothing new, which is why it can stay in the gate: the report speaks only when
there is something to say.

It exists for one gap in the three logs. Those logs prove `compile` runs beside
`lint` in the task graph, but not that it was running in the runs that failed,
because a log is a summary written after the fact — a snapshot taken at the
failure answers it for the run in hand, and "no build was running" is an answer
too, since it places the failure after `compile` finished rather than inside it.
The process list is read from `/proc` and filtered by working directory, so it is
this repository's builds rather than the machine's; where there is no `/proc` it
says so rather than printing an empty list, which would read as "nothing was
running". What it cannot do is say where the path came from: it sees a read that
failed, not the read that asked for it.

The report has been observed working — on a forced failure (`--deny-warnings`) and
against a live sibling process it correctly named with its age — but it has not
been observed on the failure it is for, which has not happened since. An
instrument that has never met its event is a plan, not a diagnosis, and the row
stays open until it does.

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

**Repetition here bounds the rate without reaching the cause.** Three hundred
standalone runs of `tests/composition/runCancellation.test.ts` on this host produced no
failure at all — with a handful of short runs of another lane alongside them, and no
gate. So whatever the CI run met, this host meets it less than once in three hundred.
That is the same shape as the socket hang-up below, and unlike that one it cannot be
settled by repeating here, because its only occurrence was on a runner whose load and
image are not this machine's. The row stays open on the terms it already had: the
assertion prints what the failure was, and nothing is changed for a mechanism nobody
has seen.

### A socket hang-up in the conformance lane {#socket-hang-up}

`tests/conformance/captureReplay.test.ts` has failed four times, on this machine,
each time the same way: one test ends with `TransportFailure: socket hang up` from
`src/application/httpClient.ts:414`. The first two were inside a full local gate —
`reports a body that changed as a difference, with the status still matching`
(2026-10-16T05:59:33Z) and `reports a status that changed even though the body did
not` (the same day at 06:56Z) — and both logs live outside the repository, so those
two runs are described rather than linked. The file's twelve tests take about 250 ms.

**Repetition is what it wanted, and that is measured now rather than guessed.** The
second occurrence was read here as leaving two answers open — "it wants the load of a
gate that is building C++ beside it, or it wants enough repetition that ten runs is
not yet a sample" — and repetition answered it. Two more failures, both from
standalone runs of the file on an otherwise idle machine: iteration 20 of one
300-run sweep and iteration 19 of another, with no gate and no CMake anywhere near
them. So the load of a gate is where the first two happened to be observed rather
than what produced them, and the rate is **two failures in thirty-nine runs** of the
file alone.

**The failures never repeat a test.** Four occurrences, four different tests — the
third and fourth each a test neither earlier one was. That is a shape rather than a
coincidence, and it is what a request that dies once, and only once, leaves behind.

**Both ends are Node's own defaults**, which is what makes this a class rather than a
one-off. uvp's client calls `http.request` with no `agent`, so it gets
`http.globalAgent`, keep-alive with no idle timeout since Node 19; the capture proxy
is `http.createServer(...)` with no `keepAliveTimeout`, so it advertises
`keep-alive: timeout=5`. Connections are reused, and a failure can therefore be a
socket rather than a connection.

**Eliminated: reusing a socket the server closed long ago — and why that was not
enough.** Against a Node server with the default idle close, a request issued six
seconds after the previous one did not reuse the dead socket at all — the agent
dropped it, opened a new one and answered 200. A sweep that lowered `keepAliveTimeout`
to sample the close cheaply said nothing, because below one second the server
advertises `timeout=0`, and the client reads that as "never reuse"; it is kept here
because "0 of 3000, so it is not the race" is the conclusion it invites and the wrong
one. With a server advertising `timeout=2`, reuse survives an 800 ms gap and is gone
by 1200 ms, so the client closes an idle pooled socket itself, a second before the
server would. Twenty concurrent requests to establish a pool, a gap swept over the
client's own close, then twenty more: 2400 of 4800 reused a pooled socket, and not one
failed.

Every one of those probes held constant the one thing this lane does not: **the same
server stayed behind the number.** A reused socket there was still pointed at the
listener it had been opened to, which is why nothing failed and nothing could have.
The class is not "a socket closed long ago". It is "a socket whose listener is gone
and whose **number has since been given to a different server**", and socket reuse is
only how it is reached.

**The mechanism, constructed rather than sampled.** A twenty-line script with no uvp in
it — server A on a number, one keep-alive request through the global agent, A closed,
server B bound to that same number, one request — answers `{"reused":true,
"code":"ECONNRESET"}`, message `socket hang up`, and the request after it is fine. Then
the same thing through this lane's own tools: `uvp_capture_start` on a reserved number,
one request through it, `uvp_capture_read {stop: true}`, and a second
`uvp_capture_start` **on that same number**, whose first request dies with the
identical `TransportFailure` while its second answers 200. The rare failure, on demand,
in about a hundred milliseconds.

**And the failing run now says so itself.** The reserved numbers were logged for the
length of one sweep — the logging was scratch and is not in the change — and five of
the nineteen runs before the fourth failure had handed one out twice. That failure's
own log carries both halves:

```
[freePort] REPEAT 32316 handed out again; issued so far: 32721,32612,…,32316
a request through the proxy to http://127.0.0.1:32316/hello failed: TransportFailure: socket hang up
```

The number handed out twice is the number the request died on, and it was handed out
twice in consecutive calls — a capture proxy given the number the capture before it
had just released. That is the construction above, arriving on its own.

**Why the number was handed out twice.** `freePort` probes a candidate and returns it;
a listener that has stopped makes its number genuinely free again, so the probe was
not wrong — but nothing in the file remembered that this process had already given
that number to someone. The window it walks is 512 numbers wide and this lane makes
dozens of calls per run, so a collision is ordinary rather than exotic.

**The fix is at the reservation, not in the transport.** `freePort` now remembers every
number it has handed out and never hands one out twice in a process: the walk skips a
number already issued the way it skips one already occupied. The client's pool is
untouched, because the pool is the product's and the defect was the harness giving one
identity to two servers. A test beside the lane draws eighty numbers with nothing bound
and requires all of them distinct — against the reservation with the exclusion removed,
**twenty of twenty runs fail**, and the walk simulated without it collides in 99.8% of
runs — while with the fix the walk cannot repeat at all until all 512 numbers are
spent. It skips, by name, where there is no window to walk, because a number drawn from
port 0 cannot be remembered.

**And the same sweep with the fix is clean.** Three hundred runs of the file, no
failure, and no log containing a hang-up at all, against two failures in the
thirty-nine runs before it. At the rate those thirty-nine measured, three hundred runs
with none is about a one-in-seven-million chance, so this is the exclusion rather than
the sampling.

**The diagnostic stayed, because it answered its question.** A failing request through
the proxy — and a replay that throws rather than returning an `outcome` — prints what
each fixture child was doing at that moment: `running`, `exited with code 0`, `killed
by SIGKILL`, with the last line the child said, capped and marked when truncated. The
fixture is a child process and nothing here read its exit or its output after startup;
its `stdout` and `stderr` are drained now, which also removes the case where an unread
pipe fills and blocks it. Verified against all three branches before being kept: a
healthy fixture says `running, last said "fixture listening …"`, one killed with
`SIGKILL` says `killed by SIGKILL`, and one stopped through `stop()` — which sends
`SIGTERM` and gets a clean exit — says `exited with code 0`. In the fourth failure it
reported both fixtures `running`, which ruled the target out and left the client and
the proxy; that is the half of the answer it was built for. The diagnostic is logged
and the error is rethrown unchanged, because a diagnostic that changed the error under
test would be a second defect.

**What was not done, and one thing left open.** The candidate named here before — one
connection per exchange — would remove the class by removing the pool, and would change
what `uvp_load_test` measures; that trade is not worth taking for a defect whose cause
is a harness handing one number to two servers, so the pool is untouched. A caller
still has the hazard: stop a capture and start another on the same `listen_port` while
holding a pooled client, and the first request through the new proxy can die the same
way, because nothing on the server side can tell a stale socket from a fresh one.
Retrying once on `req.reusedSocket` is the fix clients usually carry, and it would
change the transport's observable behaviour, so it is named for the design discussion
rather than taken here.

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

**What the bot did when the file landed.** Both ecosystems were read, by four
update runs that started within four seconds of the push and interleaved. The
`github_actions` half had six pull requests open by `21:41:58Z`, one per action:
`#1` upload-artifact 4.6.2→7.0.2, `#2` checkout 4.4.0→7.0.1, `#3` setup-node
4.4.0→7.1.0, `#4` cache 4.3.0→6.1.0, `#5` download-artifact 4.3.0→8.0.2, `#6`
github-script 7.1.0→9.0.0. The npm half followed within the minute with two more:
`#7` "bump the npm-minor group with 6 updates" and `#8` canonicalize 3.0.0→5.1.0.
Four things in that list are the configuration read back rather than assumed.
Every title is `chore(deps): bump …`, so the prefix that had to be set for
`pr-title.yml` is the prefix Dependabot emits. Every action title names the
release — `from 4.4.0 to 7.0.1` — which means the `# vX.Y.Z` comment was read; a
bare SHA would have made the same pull request read "from `11d5960a` to `…`". The
grouping behaves in both directions: `#7` carries six minor/patch updates in one
pull request, and `#8`, a major, arrives alone and named against a single
dependency rather than inside a group nobody read the order of. And the two
ecosystems took different paths to the same shape — `github-actions` had nothing
non-major pending, so its group is empty and no pull request exists, which is the
group working rather than the group failing.

**Every one of the six action bumps is a major, which is the pin earning its
keep.** The pins hold the major that was already in use, because a change that
pins references must not also change which code they run — so all six are one
major behind, and Dependabot says so in six reviewable pull requests instead of a
tag moving silently. Two of those bodies name Node.js 24 in their release notes
(`checkout` and `upload-artifact`); the other four say nothing either way, and a
release note's silence is not evidence.

**Which majors clear the Node.js 20 warning came from two files, not from a release
note.** The runner's own warning names the actions it is about, by the SHA pinned
here, and in run `38827824455` it named five of the six — `cache@0057852b`,
`checkout@11d5960a`, `setup-node@49933ea5`, `upload-artifact@ea165f8d`,
`download-artifact@d3f86a10`. That is a list of what ran rather than of what is
deprecated: `github-script@v7` is `node20` too and never appeared, because its one
job runs only on pull requests. The action's own manifest answers it without running
anything — `runs.using` is `node20` at all six SHAs the pins held and `node24` at all
six now adopted, read with
`gh api repos/<owner>/<repo>/contents/action.yml?ref=<sha>`. A configuration header
rather than a version number is the difference between knowing and inferring, and it
makes the answer **every one of the six, and none of them chosen from a release
note.**

**Adopting them was a human's decision, and the rehearsal was what put it in front of
one.** The six were rehearsed and reverted first: each SHA resolved from its tag and
agreeing with the pull request Dependabot opened, the replacement applied to all 40
references across the five files under `.github/` with a count per file,
`npm run verify:actions` green on the result (40 third-party and 10 local references,
one SHA per action), and every input this repository passes — `fetch-depth`, `ref`,
`persist-credentials`, `node-version-file`, `path`, `key`, `name`, `overwrite`,
`script`, `github-token` — still declared in the new major's `action.yml`. Adopting
them changes what code runs in CI with this repository's token, which is the kind of
change a pin exists to make visible rather than to make on someone's next push, so it
waited for the owner's decision and then landed as a change of its own.

**Two majors change more than their runtime, and both were read rather than assumed.**

- **`setup-node` v5 caches by itself when `package.json` declares a `packageManager`.**
  This one declares `npm@11.16.0`, so all eleven call sites would have started
  restoring and saving an npm cache of their own, keyed and saved by setup-node,
  beside the one `./.github/actions/npm-cache` already owns — two writers to one
  directory, and the second one's save policy is not this repository's. The input that
  turns it off, `package-manager-cache: false`, is declared in v5 through v7, and it
  is set at every call site with the reason beside it.
- **`download-artifact` v8 fails a run on a digest mismatch**, where v4 logged a
  warning and continued; `digest-mismatch` is the input that softens it. The artifacts
  this repository downloads are its own, built in the same run, so a mismatch is a
  fact about the transfer rather than about the content, and failing is the direction
  that does not hand a shard a half-restored `dist/`.

`checkout` v7's other change is a guard, not a behaviour: it refuses to check out
fork pull-request code under `pull_request_target` or `workflow_run`, which is the
event `pr-readiness.yml` uses. The guard is in
`src/unsafe-pr-checkout-helper.ts`, and it fires only for a fork PR _and_ a request
whose repository, ref or commit resolves to that fork — this workflow asks for
`refs/heads/<default branch>`, with no `repository` and no `commit`, so it returns
before the throw. That was read from the guard rather than inferred from the release
note, and `allow-unsafe-pr-checkout` is the input that would opt in.

**A rehearsal cannot run, and the runs are what settled it.** The push that carried
the bump started CI run `38854668506`, whose ten jobs all passed, and Documentation
build `38854668572`. Five of the six are exercised by name in a step log: the shard
jobs run `actions/checkout@3d3c42e5…`, `actions/setup-node@949feb24…`,
`Cache npm package downloads`, `Download the built runtime` and the built lane on
what it downloaded, every step successful — so `download-artifact` v8 delivered the
`dist/` the built lane ran on rather than being expected to. `github-script` is the
sixth, and its one job is on `pull_request_target`: `pr-readiness.yml` was dispatched
by hand (`38854711806`) against open pull request #8, and the script ran — it resolved
`require("node:url")`, imported `scripts/ci/pr-readiness.mjs` and read the body — then
failed the job with the same four declaration lines run `38852315799` produced before
the bump, which is the gate reading a Dependabot body rather than an action that
stopped working. Node 24 also needs a runner at `v2.327.1` or later, which the
GitHub-hosted labels here are; that far is the labels, and the runs are where it
stopped being a statement about them.

**And the warning the row was about is gone, counted rather than eyeballed.** Run
`38853786333`, the last before the bump, logs `Node.js 20 is deprecated` ten times,
naming the pinned SHAs; run `38854668506` logs it zero times, as does the dispatched
`pr-readiness` run against the one that logged it once. The only `DeprecationWarning`
left is `DEP0005` for `Buffer()`, which belongs to a dependency rather than a runtime.
The warning's own text is worth keeping for what it said: those actions were "being
forced to run on Node.js 24" already, so what the majors changed is the manifest
agreeing with what the runner was doing.

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
territory, so a change to the rule has to run the rule. Its first CI run
(`38811687534`, job _Static checks_) selected it and passed.

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
it is allowed to do. The Dependabot half is no longer in that position: GitHub
read the file and opened eight pull requests across both ecosystems, which is the
answer to whether it accepts the configuration, and it arrived from the update
runs this section said it would arrive from before those runs existed. What is
still not observed is the schedule: those runs were triggered by the file
appearing, not by the weekly timer, so "Mondays at 05:17 and 05:37 UTC" is a
statement about the configuration rather than a thing anyone has watched happen.
The first Monday that passes with the file in place is where that gets settled.

### Fuzzing the two parsers {#fuzzing}

Every parser test in this repository before this item was written from output
captured off a real tool, which is what makes those tests evidence about the tools
rather than about the parser's own shapes. Their limit is the other side of the
same coin: they cover the lines somebody thought of, and a parser's failure mode is
the line nobody thought of. `tests/support/fuzz.ts` draws those lines.

**Determinism is the contract, not a nicety.** A generator that redrew its inputs
on every run would turn a real defect into something that shows up once and cannot
be looked at again. The seeds come from a fixed list, each iteration is seeded from
the pair `(seed, iteration)` rather than from a stream that runs across iterations,
and a failure prints the seed and iteration that identify that case on its own —
replaying does not mean replaying four hundred cases to get back to it.
`UVP_FUZZ_SEED` draws different ones and `UVP_FUZZ_ITERATIONS` draws more, and every
run prints what it examined:

```
fuzz: build diagnostics, invariants — seed(s) 1, 2, 3, 4, 5, 6, 7, 8 × 200 iteration(s) = 1600 generated input(s)
```

That line is the same instinct as the skip reporter and the lane plan: a bounded
search that says nothing about its bounds reads like a proof, and "no case failed"
and "no case was tried" are different statements.

**No new dependency.** `fast-check` would be the obvious choice and is not here,
for two reasons that point the same way: an added top-level dependency is a design
discussion in this repository, and this is not a reason to have one; and the value
is reproducibility rather than statistical quality, so a fuzz whose seed handling
lives in someone else's upgrade path is a fuzz that stops reproducing on an
unrelated commit. Mulberry32 is fifteen lines.

**What it found, first run.** Every Windows GCC or Clang diagnostic was being
dropped. The file part of the format was "everything up to the first colon", and a
Windows path has a colon of its own, so `C:/Users/dev/src/main.cpp:12:5: error: …`
read as not a diagnostic at all while the same line with a POSIX path was read
fine. That is not hypothetical here — `LocalToolchainProvider` probes for `gcc` on
Windows as well as `cl`, so a MinGW or clang build there is a supported
configuration whose every compiler diagnostic uvp would have reported as nothing.
The fix is a `(?:[A-Za-z]:[\\/])?` prefix on the file part, and **a separator is
required after the colon** rather than a drive letter being enough on its own:
`C:main.cpp` is relative to a drive's current directory and does not appear in
build output, while `a:b.cpp:3:5: error: …` is text a build log can hold by
accident, and a bare letter-plus-colon rule would newly read it as a diagnostic.
The second finding is a `TypeError` made reachable: `transportFailureKind` read
`error.code` and called `.startsWith` on it, which throws for an error whose `code`
is a number. Node always sets a string, so nothing raised it today — but the
function runs _inside_ the `catch` blocks that report failures, where a throw does
not report the caller's failure, it replaces the caller's error handling with a
`TypeError` about a field nobody asked about. `errorCode()` at that boundary reads
a `code` that is not a string as one that matched nothing, which is what an absent
one already did.

**Two defects in the generator, found by using it**, and worth keeping visible
because they were both cases of a helper quietly disagreeing with its own
description. `pick()` threw when the value it drew was `undefined` — so it refused
to draw a legitimate element of a list that contains one, like "no `Content-Type`
header", and the emptiness of the array is what makes a draw impossible rather than
the value drawn. And `string()` indexed its alphabet as a string, which yields
UTF-16 code units, so an alphabet containing 🙂 let a draw take half a surrogate
pair; `Buffer.from(text, "utf8")` turns that half into U+FFFD, so the generator was
producing text that no caller could put on the wire. It spreads the alphabet into
characters now.

**Two things recorded rather than fixed, and both since fixed.** The lane asserted
them as they were, with the reasoning for leaving them, and each carried a row
above; neither assertion is in the lane any more, because neither behaviour is in
the code. A link failure had no diagnostic format here: `ld:`, `collect2:` and
`FAILED:` were dropped, and no test in this repository had ever captured a real link
failure, so writing a pattern from a log that looks plausible is how a parser starts
inventing diagnostics. That is what it took to close the row — captures, not a
pattern — and the captures are in [the section below](#link-failures). And
`decodeBody` called lossy UTF-8 decoding "text": a peer that declared `text/html`
and sent something else got `decoded_as_text: true` with replacement characters in
it, so a caller comparing the text against the response digest found a difference no
field explained. The obvious fix was wrong for a reason the lane had pinned —
refusing to call it text whenever a re-encode differs also catches a body truncated
through a multi-byte character, which is the ordinary case for `max_body_bytes` and
is not the peer's doing — so the two had to be told apart first, which is what
[the section below](#lossy-text) does: `text_lossy`, and the mutations each of its
guards was shown to fail under.

**And it corrected a comment rather than being satisfied by one.** The NUL guard in
`decodeBody` is applied to the first 1024 _characters_ of the decoded string while
its comment claimed the first kilobyte of bytes. Characters are never shorter than
bytes, so the real rule reaches at least the first kilobyte and further when the
body is multi-byte: a NUL at byte 2000 behind a thousand two-byte characters is
caught. The lane pins both ends, because "the first kilobyte" and "the first 1024
characters" are different claims and only one of them is true.

**What a fuzz does not establish.** A bounded search over generated inputs is a
statement about the cases it drew, never about the input space, and the printed
scope exists so that no reader has to work out which statement was made. The lanes
also do not replace the captured-fixture tests beside them: bytes a socket on this
host actually produced are evidence about Node and about the peer, and generated
bytes are not. The two files say which is which in their own headers.

### A body decoded as text is not the bytes {#lossy-text}

`decodeBody` hands a caller `text` with `decoded_as_text: true`, and a UTF-8 decode
of bytes that are not UTF-8 is lossy: `Buffer.from([0x48, 0x69, 0xff])` decodes to
`"Hi�"`, which re-encodes to three bytes that are not the three it was given.
Nothing in the output said so, so a caller who compared the text against the body's
`digest` had a mismatch and no field to account for it.

The obvious repair — refuse to call it text whenever a re-encode differs — is wrong,
and the fuzz lane had already pinned why: it also catches every body a cap stopped
inside a multi-byte character, which is what `max_body_bytes` does to any multi-byte
body whose byte length is not a multiple of the character width. That is the
caller's own doing and not a finding about the service, and collapsing the two sends
someone to debug a service that is fine. The row above waited on telling them apart.

**The distinction, and the one fact that decides it.** A trailing run of one to
three continuation bytes is a character that was cut — but only if a caller says it
cut the body. Nothing in the bytes can say it: `[0xe4, 0xb8]` arriving whole is the
peer's invalid bytes, and the same two bytes arriving after a cap are the cap's
loss. The caller states it (`cutShort`), naming the two caps that are the caller's
rather than the peer's — `max_body_bytes`, and the transport's own limit — and
`textLossiness` answers one of three things:

| answer         | means                                                                                                                      | whose it is              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| absent         | re-encoding `text` returns exactly the bytes that were decoded                                                             | —                        |
| `truncated`    | the only thing wrong with these bytes is that they stop inside a character                                                 | the cap that was applied |
| `invalid-utf8` | the bytes hold a byte no sequence begins with, a lone continuation, an overlong encoding, a surrogate, or nothing cut them | the peer                 |

Absent is the ordinary case, and it is the field that certifies the text against the
digest. The vocabulary is the WebSocket half's (`text_omitted`), reused rather than
respelled, because two spellings of one answer is how the two drift apart. `uvp http`
and `uvp soap` print it as one line above the body, since a terminal shows the text
and nothing else — that is the surface where a lossy decode is most likely to be read
as the response itself.

**One owner, three callers.** The rule is `textLossiness`, and every decode in the
web service calls it: the HTTP/1.1 path, the HTTP/3 path, and — found by inspecting
the consumers, which is what "told apart first" turned out to require — the SOAP
path, where the same bytes were decoded a second time to read a fault out of them.
That third instance was the same defect in a place the row had not named: the string
a fault was parsed from and the string handed to the caller were two answers about
one body. The SOAP path reports the same field now, and the HTTP/3 path does too —
without `cutShort`, because the probe hands a body over whole or not at all. Both
output schemas carry the field, so it is in the generated catalog as well.

**The rule was measured before it was trusted.** The fuzz lane carries nineteen
known answers — `[bytes, cutShort, expected]`, one shape each — and the table failed
on its first run: `needed = byte >= 0xf0 ? 4 : …` read `0xff` as a four-byte lead,
so a lone `ff` under a cap came back as the caller's cut rather than the peer's
bytes. The ranges are the encoding's now — `c2`–`df`, `e0`–`ef`, `f0`–`f4` — with a
comment saying why a bit test is not one: `f5`–`ff` carry a four-byte lead's length
bits and are not leads, and `c0`/`c1` cannot start a sequence that decodes to the
character they spell.

**Verified by eighteen mutations, each applied, run, and reverted.** The lanes are
`httpClient.fuzz.test.ts` (8 tests, the rule) and the socket lanes —
`httpBehaviour.test.ts` (12 tests) and `handlers.test.ts` (62 tests) — which are one
column here because the later mutations reach the SOAP tool and the renderers that
only those two exercise. Measured in one pass, against the current tests:

| mutation                                                | fuzz   | socket  |
| ------------------------------------------------------- | ------ | ------- |
| the round-trip check short-circuited to `undefined`     | 3 of 8 | 7 of 74 |
| the `cutShort` branch dead                              | 2 of 8 | 3 of 74 |
| `cutShort` forced true                                  | 2 of 8 | 2 of 74 |
| the lead-byte range loosened to `>= 0xf0`               | 1 of 8 | —       |
| the prefix round-trip skipped                           | 2 of 8 | —       |
| `decodeBody` computing the loss and dropping it         | 3 of 8 | 4 of 74 |
| the HTTP tool no longer passing `cutShort`              | —      | 1 of 74 |
| the renderer no longer printing the line                | —      | 1 of 74 |
| the lossy answer no longer carrying the bytes           | 3 of 8 | 4 of 74 |
| `base64` on every textual body, clean decodes too       | 3 of 8 | 1 of 74 |
| `base64` re-encoded from the text rather than the bytes | 3 of 8 | 3 of 74 |
| SOAP cutting characters again instead of bytes          | —      | 3 of 74 |
| SOAP measuring the loss on the whole body               | —      | 3 of 74 |
| the renderer no longer naming where the bytes are       | —      | 1 of 74 |
| the envelope cap fixed at 64 KiB again                  | —      | 1 of 74 |
| `truncated` measured against 64 KiB rather than the cap | —      | 1 of 74 |
| the SOAP digest taken over the prefix it hands over     | —      | 1 of 74 |
| the default cap moved from 64 KiB to 32 KiB             | —      | 2 of 74 |

The rows with a dash in the socket column are the rule's own cases — which byte may
start a sequence, whether the prefix before a dangling tail decodes cleanly — and the
fuzz lane's table is their owner: the socket lane's claim is the answers end to end,
not every shape the rule turns on. The rows with a dash in the fuzz column are the
same arrangement the other way round: the SOAP tool and the two renderers are not in
that lane at all, so a mutation to them has nothing there to fail, and the socket
column is where their evidence is.

The last four rows are the cap, and one or two tests each is the whole of their
evidence: the case that asks for three different amounts of one envelope, and the case
that measures the fixture's envelope against the default. That is thinner than the
rows above it and it is not thinner than the claim — what a mutation to the cap breaks
is an agreement between two answers about one body, which a lane comparing one answer
with itself could not see. The last row is the one about the number rather than the
mechanism: 64 KiB is not a preference here but the offset two fixtures are built to
straddle, so moving it fails the case that straddles it.

The third row is the one that changed something. It was caught by the fuzz lane and
missed by the socket lane, which had no route whose body stopped inside a character
with nothing having cut it — so the answer that exists to stop a caller blaming
their own limit for a peer's bytes was, over a real socket, untested. The fixture has
`/half-character` now, and that mutation fails both lanes. The first two rows are
mutations a run reports and the third is the reason to make them.

**Not claimed.** No capture from a real service is behind any of this. The answers
are asserted against a fixture written here, so what these lanes establish is this
client's rule and its three answers, not any real peer's behaviour; a peer that
sends something stranger than `ff fe` and a half-character is a case the fuzz table
covers by construction and no capture covers at all.

**The bytes travel with a lossy answer.** A caller whose text came back lossy used to
hold text that is not the response and nothing else: `decodeBody` answered with `text`
or with `base64` and never both, `text_lossy` named the loss, and `digest` is over
bytes that no longer travelled with the answer. The two travel together now, under a
rule written as an equivalence rather than a preference — `base64` is present exactly
when `text` is not the body's bytes — so "which do I read first" has an answer that
does not depend on reading a second field: the bytes when they are there, the text
otherwise. When both are present, `text_lossy` says why they differ, and the bytes are
the ones the text was decoded from: for a capped body that is the prefix the cap kept
rather than the body the peer sent, which is what makes the answer self-contained —
the text, the bytes and the reason they differ are one decode of one buffer. `bytes`
and `digest` stay the whole body's, and are the fields that say the prefix is not all
of it. A clean decode carries nothing extra, so the ordinary case costs a caller
nothing: a `base64` there would be a second spelling of a body they already hold.
`uvp http` and `uvp soap` name that the bytes came with the answer and leave them to
`--json` rather than printing a base64 blob under a body they have just shown as text.

**The SOAP cut moved to bytes, which is what let the pair be one decode.** The same
change closed a second defect, in the one path where the text a caller received and
the string the tool parsed were already two reads of one body. `uvp_soap_call` cut the
envelope at 64 Ki _characters_ after decoding it, so the string handed over, the decode
`text_lossy` was about, and the bytes `base64` would carry were three different ranges
of the body, and two things followed from cutting on code units. It could split a
surrogate pair, which is a loss no field here can name: each half re-encodes to a
replacement character and the pair is gone, so the same body would report
`invalid-utf8` for a cut the tool made. And it could report a loss where there was
none, because `truncated` already compared the body's byte length against 64 KiB: an
envelope of three-byte characters came back saying only a prefix was shown while every
character in it was whole. The cut is taken on the bytes now — 64 KiB by default, and
`max_body_bytes` when a caller names another number — which is the same buffer `text`,
`text_lossy` and `base64` are all made from and the same number `truncated` compares,
so the field and the cut agree rather than coinciding on ASCII. A byte cut can land
inside a character; nothing can avoid that, and saying so is what
`text_lossy: "truncated"` is for.

**The fault is read from the whole envelope, and that asymmetry is the point.** The
prefix handed over is evidence about this exchange's bytes; a fault is a finding about
the call. Reading the fault from the prefix would turn "the service answered with a
fault" into `success` whenever the fault sat past the cut — a claim the response does
not support, and the direction of error a caller acts on. So `fault` is parsed from
the whole body while the body shown is a prefix, and what tells a caller that is
`truncated` together with a `bytes` larger than the text. It is a real asymmetry
rather than a tidy one, and for one release it had a cost the row above carried: the
cap had no input, so a caller who needed the envelope a fault came from could not ask
for it. That row is closed next.

**The cap is the caller's, and the digest is the envelope's.** The row that asked
whether a `digest` over the whole body still answers a caller who asked for more was
answered by what the fields already were, which is the only reason closing it needed
no new vocabulary. `bytes` and `digest` are taken over the envelope as received and
never over the prefix handed over, so they name the response rather than the part of
it a cap let through: a caller who asked for 32 bytes holds a digest of an envelope
they have not seen the whole of, and asking again for the rest returns a body with the
same name — same `bytes`, same `digest`, more text. That is the shape `truncated`
already had, so the cap could become an input without any field changing what it
means. The alternative was the one worth refusing: a digest over the prefix would make
two calls about one envelope disagree about which envelope it was, and would make
`digest` a field about the cap rather than about the response.

Two smaller decisions came with it. The cap is a default and not a ceiling, because the
call reads the whole envelope whatever the cap says — it has to, since the fault comes
from all of it — so a caller asking for more is asking for bytes already in hand, and
there is nothing there to refuse; a request for a megabyte of a two-kilobyte envelope
is answered with the whole envelope and `truncated` false. And the name is
`max_body_bytes`, the one `uvp_http_request` uses, because the caller-facing question
is the same one even though the mechanics differ: there the cap also bounds what the
client reads, here it bounds only what is handed over. The difference is worth stating
in the contract rather than hiding behind a shared name, which is where it is stated.

**An additive field, and breaking anyway.** `text_lossy` is optional and every
previous answer is still valid, which is the shape a changelog would call a feature.
It is not one here: the catalog's objects are closed (`additionalProperties: false`
on the body of both tools), so a client that cached the previous output schema and
validates against it rejects a body that now carries the field — the exact reader
[`docs/releasing.md`](releasing.md#compatibility-promises) promises to keep working.
The commit is marked `!` with a `BREAKING CHANGE:` footer, and release-please takes
the major bump. What made this worth checking rather than assuming is that the
repository's own history has the other shape in it: additive fields landed without
the marker, which is a rule quietly not followed rather than a rule changed.

`base64` is the second instance of the same shape and the stronger one. It is
optional and absent from every clean answer, and it also does not exist in the
previous contract at all on `uvp_soap_call`'s body: a client that cached that schema
does not merely reject a body carrying a field it marked optional, it sees a field
the schema never declared, which is the same rejection for a different reason. Both
facts are the same fact about closed objects, and both are why this is one `!` rather
than a feature release and a note.

`max_body_bytes` on the SOAP input is the same rule read in the other direction, and
it is the weaker case of the three: an optional input field with a default equal to
the number that was fixed before it, so no call a caller already writes behaves any
differently, and every answer is byte-identical. It is still a change to an existing
tool's input schema, which is what `docs/releasing.md` calls breaking, and the honest
reason is the one a caller can act on: a client that cached the input schema and
compares it against the catalog now finds a property its copy does not have, and a
schema comparison that fails is a schema comparison that has to be looked at, whether
or not anything broke behind it. Marking it is cheaper than arguing that this instance
of the rule is the one that does not count, which is how a rule erodes.

### A link failure, from captures {#link-failures}

The build-output parser's header said "each format is matched, not approximated",
and the formats it matched were the compiler's, CMake's, and — for the drive-letter
fix — the compiler's on another platform. The linker's were absent, and the contract
had carried a `phase: "link"` since it was written with nothing ever producing it.
So a link failure came back as `succeeded: false` with an empty `diagnostics` list:
a build that failed with no stated cause, which sends a caller back to re-run a
compile that had already succeeded. Under `gold` it was worse than empty — gold
reports an undefined reference in **GCC's own shape**, so it was reported as a
_compile_ failure, which is the one thing it is not.

The row stayed open because the fix needed captures rather than a plausible-looking
log, and there were none. They were taken on 2026-10-16, on this host's **GNU ld
2.42** through the `g++` driver, in `Debug` and in `Release`, with GNU Make and
with Ninja, from a scratch project that links a library that is not installed,
calls a symbol nothing defines, or defines one twice:

```
/usr/bin/ld: cannot find -luvcpp: No such file or directory
/usr/bin/ld.gold: error: cannot find -luvcpp
/tmp/uvp-link-probe/src/main.cpp:2:(.text+0xe): undefined reference to `uvp_missing_symbol(int)'
main.cpp:(.text.startup+0xa): undefined reference to `uvp_missing_symbol(int)'
/tmp/uvp-link-probe/src/other.cpp:1: multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:/tmp/uvp-link-probe/src/main.cpp:1: first defined here
other.cpp:(.text+0x0): multiple definition of `uvp_duplicate()'; CMakeFiles/hello.dir/src/main.cpp.o:main.cpp:(.text+0x0): first defined here
collect2: error: ld returned 1 exit status
```

**What the captures decided, and what they corrected.** The pair the linker prints
under an object-and-function line is read as one diagnostic, from the second line —
it is the one that names a place in the caller's own source, and the first says
which object and which function, which the location below it says better. The
`Release` shapes are why the line number is optional and the section required: with
no debug information there is no line, and the location falls back to the basename
the compiler wrote into the object's symbol table, so the section is the only
locator left and is folded into the message (the contract has no field for a
link-time offset, which is the same choice the CMake diagnostic already makes with
the command it was running). And a multiple definition carries **one** location and
never two — a source line in `Debug`, a section without it — which is not the shape
of an undefined reference beside it. Writing one pattern for both was a defect this
file shipped for as long as it took to run it against these captures: the parser was
written, and then the captures were run through it, which is the order that finds
this and the order that a log-shaped guess does not.

**The summary line, held back rather than dropped.** `collect2: error: ld returned
1 exit status` is present for every GNU link failure, including the ones whose
linker message this parser does not know, so it cannot be ignored; beside the
linker's own complaint it describes the same event twice, so it cannot be reported
always. It is reported only when no linker diagnostic was found **anywhere** in the
log — a question about the whole scan, because the two streams are read in a fixed
order that is not the order the tools wrote them in. Two captures are the evidence
for both halves: `ld: unrecognized option '--bogus-option'`, where the linker's
words match nothing here and the summary is the only line that says the failure was
the link's, and gold's multiple definition, whose lines carry no location either.

**What is still not read.** Ninja's `FAILED: hello` names the target and not the
failure, and the command echo under it is the same step again; GNU Make's
`*** [CMakeFiles/hello.dir/build.make:97: hello] Error 1` is the same. Both stay
undropped but unparsed, and the lane pins that they do: inventing a `message` out of
a build system's own bookkeeping is how a diagnostic list fills with lines nobody
can act on. One limit is deliberate and stated in the code beside the pattern: a
`cannot find` operand containing a colon — a Windows path — is not matched, because
no capture of that shape exists here and a pattern written for it would be a guess.

**The other half, which the same captures found.** `ld` and GNU Make translate
their messages through gettext, so the format is only worth matching if the text is
the text the tool prints. Measured on this host with `LANG=zh_CN.UTF-8`, the same
failure reads:

```
/usr/bin/ld: 找不到 -luvcpp: 没有那个文件或目录
gmake[2]: *** [CMakeFiles/hello.dir/build.make:97：hello] 错误 1
```

— note the full-width colon in the make line, which no rule here matches either.
`noWorkWasDone` loses the same way and to the same tool: GNU Make's `Nothing to be
done for 'all'.` comes back as `make: 对“all”无需做任何事。`, which the pattern does
not recognise either. A
parser run against that reports nothing, and the result is indistinguishable from a
build that failed for no reason. `buildOutputEnvironment()` is now the environment
every build subprocess gets: `LC_ALL` emptied and `LC_MESSAGES=C`. `LC_ALL` is
emptied rather than set to `C` because a non-empty `LC_ALL` overrides `LC_MESSAGES`
_and_ the rest of the locale, and the character category is deliberately left alone
— `LC_CTYPE` still comes from the host, so a source file in a non-UTF-8 encoding
compiles as it did before. Both providers spread it from that one function rather
than restating it, the local one onto the compile as well as the configure (the
compile is the step the compiler and the linker print in), and the container one
into `-e` pairs. The recorded command carries it too, so re-running the line a
result printed re-runs it in the language its diagnostics were parsed in.

**Where it is tested.** `src/toolchains/diagnostics.test.ts` holds the captures and
the negative cases beside them; `src/toolchains/diagnostics.fuzz.test.ts` renders
link failures from the format and checks the parser reads each back — and, since
those lines are the last thing a build prints and therefore the first thing a byte
cap cuts, feeds mutated link output through the parser's invariants.
`tests/toolchain/buildFailure.test.ts` builds a generated workspace that declares a
symbol nothing defines and calls it, and asserts the failure comes back with
`phase: "link"`, the caller's own file and line, and the linker's words; a second
test runs the same failure with `LC_ALL=zh_CN.UTF-8` in the _caller's_ environment.

**What is not covered, and is not claimed.** None of these formats has been observed
on `lld`, on macOS's `ld`, or on MSVC's `link.exe` — whose `LNK2019` / `LNK2001`
failures name an object and a symbol and no source line, a shape no format here
matches, so a link failure under MSVC reports nothing today, exactly as a Linux one
did before this. The hostile-locale test probes the host before asserting the
contrast, and prints a named reason when this machine's `ld` does not localize
rather than passing as though it had shown something.

### A lane reading what the change never built {#artifact-guards}

The lane plan selects jobs; each job's own `if:` decides whether it runs; nothing
compared the two. `.github/workflows/ci.yml`'s `test` job runs whenever the run is
not cancelled rather than only when `code` is selected, and deliberately so: a
shard that failed has to still produce the merged report and the coverage
artifact, and a job whose `needs` failed is skipped under the default `success()`.
Its artifact steps, though, were written as if the job only ran for a code change.
`build` uploads `uvp-test-runtime` when `code` or `package` is selected.

So the first push whose range was documentation alone went red. Run `38812006721`
(2026-10-15T21:43:22Z, `315d494`) reported `plan: 1 changed file(s)`, `lanes:
docs`, and:

```
Portable tests               failure    (step: Download the built runtime)
Build package                skipped
Source tests                 skipped
Test shard                   skipped
Real libuvcpp lane           skipped
CI required                  failure    (step: Require every selected lane to pass)
```

Every lane the change did not need was skipped correctly. The failure is that one
job ran anyway and reached for an artifact nobody had built — and the guard that
job _does_ carry, `CODE_REQUIRED`, is asserted by a step further down, so it never
executed. `0dcbd94` repeated it exactly. The job cannot simply be skipped instead:
the merge is the reason it runs unconditionally.

**Why it had not fired before**, which is the part worth keeping. Earlier
documentation-only commits were green, and the mechanism is the lane plan's diff
range rather than those commits: `plan.mjs` compares the previous push's head with
the new one, so a push that carries one documentation commit over an earlier code
commit is a _code_ change. Run `38811687534` pushed `b508621`, whose own commit
touches only `docs/roadmap.md`, and reported `plan: 14 changed file(s)` — `lanes:
code, docs, package, toolchain, workflows` — so `build` ran, uploaded the runtime,
and the download found it. Run `38812006721` reported `1 changed file(s)`. Nothing
about the two commits differs; only the range does. The defect was live from the
moment those artifact steps landed and waited for a push whose range was
documentation and nothing else.

**The fix.** Each of the three artifact steps in `test` is guarded on `code`, and a
step above them prints which of the two cases the run is in — a guarded step that
silently does nothing reads exactly like one that passed, which is the failure mode
the skip reporter exists for. Per-step rather than one job-level guard, because a
job-level `if` cannot express "run for the merge, download only for a code change".
The same audit over all ten jobs found `test` to be the only one whose condition is
wider than what its steps assume, so this is one job and not a pattern.

**The check, shipped with the fix**, following `verify:actions` and
`verify:reporters`: a rule that lands without the check that enforces it is a rule
that lasts until the next edit. `npm run verify:artifact-guards` reads every
`actions/download-artifact` step, finds what uploads the artifact it names — the job
carrying the upload, conjoined with that step's own `if:` — and fails when the
reader's condition can be true while the writer's is false.

**Exact, not textual.** The obvious rule — require the reader to name every output
the writer names — rejects the correct `code ⇒ code || package`, which is the shape
the `test-shard` job next door actually uses. So both conditions are parsed (`||`,
`&&`, `!`, parentheses, `==`/`!=` against `'true'`/`'false'`, `always()`,
`cancelled()`) and checked by enumerating every assignment of the outputs they
mention, with a counterexample reported. Removing the guard from either download
step makes it say this, which is the whole point:

```
test → "Download the built runtime": reads uvp-test-runtime, uploaded by build
(needs.changes.outputs.code == 'true' || needs.changes.outputs.package == 'true'),
but this step runs when (!cancelled()) — the change code false, package false
selects this step and skips build
```

**Removing each guard in turn is what found the check's own bug.** It caught the
first download and passed the second, and the reason was not the download: the
artifact that step reads is uploaded by a step whose own `if:` is
<span v-pre>`${{ !cancelled() }}`</span>, inside a job gated on `code`. The first version of
`effectiveCondition` read a step's `if:` as _replacing_ its job's, so that artifact
looked unconditional — and an artifact that looks unconditional can never be too
narrow for the step that reads it, which is every violation there is. A step's
condition is the job's **and** its own; the two are conjoined, and a fixture in the
self-check now pins that, because a rule about who gates whom is exactly the kind
of thing that reverts quietly. Nothing but a mutation test would have found this:
on the workflow as it stands the check had already reported a clean file, and it
was still reporting one.

**Fail-closed, and never by accident.** A condition using anything outside that
grammar is reported as unreadable rather than read as one this file cannot judge,
and so is a line the scan cannot read at all. And a fixed list of the reads that
exist today fails if one stops being recognised — which is also what fails an empty
scan, since "nothing to complain about" and "read nothing" are the same output.
That list is what put the scan against the real workflow, and the first thing it hit
was `cannot read the step "changes"`: `needs:`' items are indented exactly like
steps, and refusing to read one is the only reason this was a failed run rather than
a `required` job holding two steps called `build` and `test`. The position rule — a
step is a step only inside `steps:` — is what the self-check's fixture now pins.

**What it does not check**, stated rather than left to be inferred. Only
`.github/workflows/ci.yml`, because that is where artifacts are passed between
jobs. Only `download-artifact` steps — and that limit has a named instance rather
than being theoretical: the step that merges the downloaded shard reports is also
guarded on `code`, removing _that_ guard is not caught, and telling a step that
consumes an artifact from one that only reports on the run is not something a rule
can do textually. An artifact three jobs upload and nobody ever reads —
`static-check-reports`, `test-results`, and `toolchain-lane-<n>` are collected by a
person after a failure — has no reader that could be too wide. And only conditions
that can affect a verdict: a step-output comparison such as
`steps.openssl-cache.outputs.cache-hit != 'true'` is recorded and not parsed, since
parsing it would make the check refuse to run on workflows holding expressions it
has no business judging.

### The commands that were not there, and the inventory nothing ran {#dependency-inventory}

Every other check in this repository reads a file. This one reads an
_instruction_, and nothing did: the pages were checked for facts about the code —
tool names, template ids, the libuvcpp floor — while the commands they told a
reader to run were taken on trust. Six of them did not exist, and they had not
existed since the framework was imported:

| Page                     | The script it named        | What has that name now                                                           |
| ------------------------ | -------------------------- | -------------------------------------------------------------------------------- |
| `CONTRIBUTING.md`        | `metadata:generate`        | `docs:generate` writes it; `metadata:check` verifies it                          |
| `CONTRIBUTING.md`        | `mcp-catalog:generate`     | `artifacts:tool-catalog`                                                         |
| `CONTRIBUTING.md`        | `docs:error-schema`        | `artifacts:error-schema`                                                         |
| `CONTRIBUTING.md`        | `mcp-catalog:check`        | `tool-catalog:check`                                                             |
| `docs/mcp-contracts.md`  | `tool-catalog:check:built` | `tool-catalog:check`, and it is the _source_ job, not a built lane, that runs it |
| `THIRD_PARTY_NOTICES.md` | `licenses:generate`        | nothing — the script it named was never defined                                  |

The table gives script names rather than command lines, which is a consequence of
the check it describes: a page naming a command that does not exist is what that
check refuses, this page included.

Measured rather than remembered: every markdown page in the repository was
scanned for `npm run <name>` and the names compared with `package.json#scripts`.
The import commit's `package.json` already had the `artifacts:*` names and none of
the four `CONTRIBUTING.md` names, so this is not drift that accumulated — the
prose arrived describing a `package.json` that was not the one in the commit, and
survived the 60 commits since — every full gate included, since none of them read
a page as an instruction — because a command a page names is only wrong when
somebody runs it.

**The inventory had the same cause and a longer reach.** `THIRD_PARTY_NOTICES.md`
told a reader to run `npm run licenses:generate` for a machine-checked inventory;
`scripts/licenses.mjs` exists, does that, supports `--check`, and is listed in
`knip.json` as an entry point — so it was maintained and reviewed. No npm script
ran it. The committed `licenses/npm-dependencies.json` therefore recorded 24
packages and 5 direct dependencies — `pino` 10.4.0, `incur` 0.6.1, `yaml` 2.9.1,
and a second `@modelcontextprotocol/server` at 2.0.0-alpha.4 — while the
`package.json` in the same commit declared three. The file was stale in the commit
that imported it and stayed stale, since `licenses:check` did not exist either.

The notices file was wrong in the same direction and about the same packages. Its
distributed-dependency table listed `incur` and `pino`, neither of which is a
dependency or appears anywhere in the tree, and gave the licence as MIT for
`canonicalize` and `@modelcontextprotocol/server` — two of the three cells — where
the lockfile and the installed `package.json` both record **Apache-2.0**. A reader
auditing the package for a library they care about was reading a list that named
code they will not get, and not reading the two they will.

**What landed.** `licenses:generate` and `licenses:check` exist now, under the
name the notices file already promised, and run inside `docs:generate` and
`docs:check` — which CI runs — so the inventory is regenerated and compared like
every other derived file. The inventory was regenerated (4 packages, 3 direct),
and both documents corrected. Two rules were added to `scripts/check-doc-facts.mjs`:
every `npm run <name>` in a page must be a script `package.json` defines, and the
distributed-dependency table must match `package.json` by name and the lockfile by
licence, `node_modules/<name>` being where a direct dependency resolves.

**Why each rule is shaped the way it is.** Names are compared across every
markdown page in the repository — all 24 of them, in both languages, with no list
of pages to maintain — because the six were spread across three files and a
curated list is exactly what would have missed them. The pages are the ones git
lists rather than the ones a directory walk finds: `dev.md` is a scratch file
under `.gitignore`, and a gate that fails on a page nobody committed is the sort
of false failure that gets a check disabled. git refusing to answer exits 2
rather than passing — scanning nothing finds nothing wrong, which is the one
reading that must not arrive by accident. Versions are not compared at
all: they are pinned in `package.json` and resolved in the lockfile, and the table
does not restate them. The licence is read from the lockfile entry npm resolved
rather than from the registry or from a table in a README, because the file the
version is resolved from is the file the licence belongs to. The development table
is not checked: it groups several packages into one cell (`vitest`,
`@vitest/coverage-v8`) and shortens scoped names, so reading it mechanically means
guessing, and a check that guesses reports failures a reader has to adjudicate.

**A check is only as good as what its cache key covers.** The gate is cached, and
`turbo.json`'s inputs for `docs:check` listed `package.json`, `docs/**` and
`README*.md` — not `CONTRIBUTING.md`, which the template-count rule in this same
file already read, nor `licenses/`, nor `AGENTS.md`. A page that changed without
the cache key changing is a page whose check was answered from a previous run, so
those three paths and `scripts/licenses.mjs` are inputs now, added in the same
change as the rules that read them.

**A dependency the lockfile records no licence for is a note, not a failure.** The
check names the package and says the cell was not checked, the same third state
the rest of this repository keeps for a probe that could not look. Verified: adding
a declared dependency with a lockfile entry carrying no `license` field exits 0
with the note printed, rather than passing silently or failing on a comparison it
could not make.

**Both rules fail open, so both are measured before they are trusted.** A pattern
that stops matching finds no rows and no commands, which reads exactly like
nothing being wrong — the shape of the VitePress page that rendered empty while
the build exited 0. So the two extractors run first against text whose answer is
known, and a rule that can no longer see what it is written to see stops the check
with exit 2. Writing them found a real defect in the second rule before it was
committed: `npm run --silent lint` captured `--silent` as the script name, which
would have reported a command no page ever meant; flags are stepped over now.

Each rule was then verified against mutations of this repository, one at a time: a
renamed script in a page, a dropped table row, an added row, a wrong licence cell,
a dependency with no recorded licence, the same dead command in an ignored page
and in a tracked one, and git unavailable. The first four and the tracked-page one
failed with a message naming the page and the disagreement; the ignored page and
the package with no recorded licence passed, the second with a note; git
unavailable exited 2. Five of the mutations were made in a copy that was then
discarded. They are not a lane, because what they establish is the check, not the
product.

**What this does not establish.** The scan reads one dialect — `npm run <name>` —
so a page that reaches a script another way (`npm exec`, `npx`, a script that
calls another) is not held to anything. A name existing is not the same as the
command doing what the page says it does; that remains a reader's question. And
the inventory says what the tarball installs, not what those packages do at
runtime.

`docs/testing.md` names both rules where it describes the gate.

### Pack reproducibility {#pack-reproducibility}

The tarball is the artifact a user installs, and `npm pack` is the last thing
between the source tree and `npm publish`. If those bytes depend on where the
checkout sits, when it was packed, or which directory received it, then the
digest a consumer can compute is not a fact about the source — so it cannot be
checked against a tag, and a release cannot be reproduced by anyone who wants to.
`npm run verify:pack-reproducible` states the claim in the one way that can be
tested: **packing the same contents twice, from two places, must produce the same
bytes.**

**The three packs, and the one thing each varies.** A second pack of the tree,
seconds later, into another directory: the moment and the destination are not
inputs. Then the first tarball's own contents, unpacked at a different absolute
path and depth with fresh mtimes: the path and the clock are not inputs. Then the
tree again, after all of that, which fails if packing has a side effect on what
it packs.

**Why the copy is an unpacking rather than a copy of "the inputs".** Which files
go into a tarball is npm's answer, from `files[]`, `.npmignore`, and npm's own
defaults. Copying the inputs would mean writing a second implementation of that
answer, and a second implementation drifts: the day `files[]` gains an entry, the
copy misses it and the check compares two trees that are no longer the same tree.
Unpacking the first tarball cannot drift, because it is the artifact's own
contents — and it asks the sharper question, that packing what the tarball holds
produces the tarball.

**The check had to be fixed before it was worth anything.** Its first version
packed two of the four into one directory. `npm pack` names the file after the
package, so the second pack replaced the first, and the comparison then read one
tarball twice: a check that reported agreement while never looking at the second
pack. Mutation testing found it — appending a newline to the unpacked copy failed
the run, and the failure was attributed to the _second destination_, which is
impossible unless the two are the same file. Each pack now has its own directory
and is digested where it lands.

**Measured, on 2026-10-16.** The digest is identical across repeated packs, across
destinations, across the contents being unpacked at another path and depth, and
across a clean rebuild of `dist/` between one run and the next (`npm run compile`
deletes and rewrites it). It is also identical with the `prepare` lifecycle and
without it, which is why all three packs pass `--ignore-scripts`: a copy of the
tarball's contents has no `node_modules` for `husky` to run in, and holding that
constant keeps one thing varying at a time.

**The check had a second claim to make, and it was found by fixing this one.** A
path named in `files[]` that no longer exists is ignored by npm in silence: the
tarball packs reproducibly, contains everything else, and simply lacks the file
the package promised. `THIRD_PARTY_NOTICES.md` was in exactly that state — the
document instructs a redistributor to keep it and the `LICENSE` alongside, and no
tarball had ever contained it — as was `licenses/npm-dependencies.json`. So the
same run now requires every `files[]` entry to be delivered: a file entry by
appearing in the listing, a directory entry by delivering something beneath it,
and an entry naming nothing in the repository a failure that prints the path.
Probed by adding an entry for a file npm does not pack (`package-lock.json`), by
adding an entry for a path that does not exist, and by adding an empty directory;
the first two named the entry, and the empty directory failed on delivering
nothing. The opposite direction — a file that should ship and is not listed — is
not decidable here, because no script knows which paths belong in the package, so
it stays a reviewer's question and is written down as one.

**What is not established, and what a pass therefore does not say.** Another
machine, another npm version, another filesystem: the unpacked copy is the
closest local stand-in for a different checkout and it is a stand-in, not a second
host. So the honest reading of a green run is "packaging is a function of the
contents on this toolchain", not "anyone can reproduce this digest". No lane
installs the tarball on a second platform, which remains a row above; what the
tarball _contains_ is no longer only a count, and is described
[below](#sbom).

### The bill of materials {#sbom}

A release artifact should carry a machine-readable inventory of what is in it.
This repository had two descriptions of its dependencies and neither could be read
by a tool: a hand-written table in `THIRD_PARTY_NOTICES.md` and a generated
`licenses/npm-dependencies.json` whose shape is this project's own. Nothing
produced CycloneDX or SPDX, so nothing could be handed to a scanner.

**The obvious implementation is `npm sbom`, and it was measured before it was
used.** On npm 11.19.0, with this repository's lockfile:

| Invocation                          | Components            | Root `dependsOn`         |
| ----------------------------------- | --------------------- | ------------------------ |
| `--omit dev` (reads `node_modules`) | 20, from a stale tree | `server`, `canonicalize` |
| `--omit dev --package-lock-only`    | 3                     | `server`, `canonicalize` |
| `--package-lock-only`, no omit      | ~300 dev tools        | 17                       |

Three separate problems, each enough on its own:

- **`--omit dev` drops `zod`.** `zod` 4.4.3 is in `package.json#dependencies`, its
  lockfile entry carries no `dev` flag, `@modelcontextprotocol/server` and
  `@modelcontextprotocol/core` both declare `zod: ^4.2.0`, and the installed
  `node_modules/.package-lock.json` agrees. It is absent from `components`, from
  every `dependsOn` edge, and from `dependencies` alike. An artifact bill of
  materials that omits a dependency the user installs is the one error this file
  could make that actively misleads. Why that flag drops it is **not**
  established — a minimal reproduction was not built, and the only correlate
  measured is that `zod` is the sole production package that dev-only packages
  also need.
- **Without `--omit dev`** it describes the build machine: every linter, test
  runner and docs tool, ~300 packages, none of which a user receives.
- **Reading a tree at all** describes this host's `node_modules`, which is stale
  here: it still lists `@modelcontextprotocol/client`, a package `npm ls` itself
  reports as `extraneous` and the lockfile no longer resolves.

There is a fourth, which decides the shape of the code rather than the choice of
producer: an npm without the subcommand — 9.2.0 at `/usr/bin/npm` on this host —
prints `Unknown command: "sbom"` **on stdout and exits 0**. So a generator that
shelled out would have to parse the output to know a document was produced, which
means it was already reading the document and not the exit status.

**So the producer is this repository's, and it shares the walk.** The closure
moved to `scripts/lib/productionClosure.mjs`, which both `scripts/licenses.mjs`
and `scripts/sbom.mjs` read. Two generators describing one set of packages with
two walkers is two answers waiting to disagree, and the disagreement would be
invisible: both files would still parse. The extraction is checked by the licence
file regenerating byte-identically, which it does.

**What the file says.** CycloneDX 1.5, in the field shapes `npm sbom` emits rather
than shapes invented here, so a consumer sees nothing unusual: a `metadata`
component for the root, one `components` entry per package with its `purl`,
distribution URL, SHA-512 and licence, and a `dependencies` edge list. Four
components, three of them direct. `purl` percent-encodes a scope's `@` and leaves
the `/` alone, which is the detail a hand-written encoder gets wrong; it is
asserted against a known input rather than checked by eye.

**Two fields make it reproducible.** `npm sbom` differs between runs in exactly
two places — `serialNumber` and `metadata.timestamp`. A committed generated file
that differs from itself cannot be checked by comparison, so neither is copied:
`metadata.timestamp` is omitted, and `serialNumber` is derived from the document's
own bytes (RFC 4122 §4.3 name-based, version 5, over the standard URL namespace).
The same closure always mints the same UUID; a changed closure always mints a
different one. Three consecutive runs produced the same SHA-256, measured rather
than asserted. What says _which_ tree the file describes is
`metadata.properties`, which records the lockfile's own SHA-512 and its
`lockfileVersion`.

**It found a packaging gap on the way.** `THIRD_PARTY_NOTICES.md` tells a
redistributor to keep the file and the `LICENSE` alongside it, and the file was
not in `files[]`, so no tarball had ever contained it. `licenses/npm-dependencies.json`
was missing for the same reason. Both now ship, measured with `npm pack --dry-run`
rather than assumed: 84 entries, all three present.

**The version coupling is a requirement on a lane that does not exist.**
`sbom.cdx.json` carries the version in four places, and two of them —
`metadata.component.bom-ref` and `.purl` — are compound strings that
release-please's `extra-files` `jsonpath` updater cannot write, since it replaces
the whole value at its path. So the file is deliberately absent from
`extra-files`, and the release PR is required to regenerate it. That is safe
rather than fragile: `docs:check` runs on every pull request and compares the file
byte for byte, so a version bump that skips `npm run docs:generate` is a red pull
request, not a released artifact describing a version it is not.

**Verified one mutation at a time:** a component dropped from the document, an
edge dropped so a component hangs off the graph, a duplicated `bom-ref`, a
`specVersion` that no longer matches the claim, a purl rule broken, the version
nibble of the derived UUID forced to 4, a manifest with no `name`, a lockfile with
no `packages` map, a component with no version, an empty closure, and `--check`
against a deliberately stale committed file. Each failed with a message naming the
disagreement, and an added stray top-level key still passed, which is the control
that says the guards are not simply refusing everything.

**That probing found a defect in the guard itself**, which is the part worth
recording. The first version of the structural check read the `components` array
the document was built _from_ rather than `document.components`, so the mutation
that dropped a component from the document passed a check that was supposed to
catch exactly that. The guard now reads the document it guards, and the mutation
that found it is in the list above. Writing the rules also surfaced a second
defect before anything was committed: `npm sbom --omit dev --package-lock-only`
takes 0.2 s here, so asking the tool and printing where it disagrees costs nothing
in generate mode — and the divergence is printed rather than asserted, because on
a host without the subcommand the answer is "not read", not "agreement".

**Schema validity was measured once, by hand, and is not a gate.** The document
validates against the published CycloneDX 1.5 JSON schema: `ajv-cli` in draft-07
mode, the three schema files fetched from `cyclonedx.org`, exit 0. It is not wired
into the gate because a JSON Schema validator is not a dependency of this
repository and the schema would have to be fetched, which no other check does. So
the in-repo checks are named as what they are — structural invariants a change is
likely to break, with `bom-ref` uniqueness and a dependency graph whose every
reference resolves among them — and a green gate says the document still has the
shape it was validated with, not that it is still schema-valid.

**What this does not establish.** The closure is the production npm dependencies
and nothing else: libuvcpp is deliberately absent, because uvp does not bundle,
link or redistribute it — the generated projects link an installation the user
supplies, which is `THIRD_PARTY_NOTICES.md`'s subject rather than this file's.
Edges are followed through `dependencies` alone, because
`optionalDependencies` are platform-conditional and the lockfile lists every
platform's build of a native package; a package that declares them is named in a
`properties` entry instead of being guessed at, and no package in the closure does
today. A package requested under an alias (`npm:other@1`) is recorded under the
name it installed at, which is read from the lockfile location, and no alias is
present today. The file describes what installing the package brings, not what
those packages do at runtime, and it is not a vulnerability report: nothing here
compares a component against an advisory database.

### A published page Vue rendered empty {#docs-interpolation}

The docs are VitePress pages, so a markdown file under `docs/` is compiled to a Vue
render function and its braces are code rather than prose. `docs/roadmap.md`
documented the artifact-guards fix of `b6aac39` and quoted the workflow expression
it had found the bug in — <span v-pre>`${{ !cancelled() }}`</span> — in an inline
code span. VitePress's server render threw `TypeError: _ctx.cancelled is not a
function`, printed it, and **exited 0**. Every job in CI stayed green, and the
published roadmap page was a shell with no content in it: 16 KB against 73 KB for
`testing.html`, the only page affected. A reader following the link from the row
above it got a blank page.

**It was found by weighing the pages, not by reading the source.** The docs build
was run for the pack-reproducibility check below, and listing each built page's
size made one of them stand out as the size of the home page. Nothing in the source
looks wrong: the line is valid markdown, valid text, and a correct quotation of a
workflow file. Only the output says otherwise.

**What each form does, measured rather than read.** One page per case, built with
`vitepress` 1.6.4 on 2026-10-16:

- <span v-pre>`` `{{ name }}` ``</span> in inline code renders as `Inline code: .` —
  the braces **and the text between them** are gone, silently, with no error at
  all. This is the worse of the two silent failures, because a page that has lost
  a sentence still looks like a page.
- <span v-pre>`` `${{ name }}` ``</span> renders as `Inline code: $ .` — the same,
  minus the literal `$`.
- <span v-pre>`` `${{ name() }}` ``</span> throws, which fails the whole page's
  render and leaves the shell above.
- Inside a fenced block it is the literal text: VitePress wraps fences in `v-pre`
  for you.
- Inside `<span v-pre>` … `</span>` it is literal too, which is the fix here.
- Inside a four-space **indented** block it is gone, silently. An indented block is
  not a fence and gets no `v-pre`, which is why this belongs in a check rather than
  in a style note: the form that most looks like a code block is one of the ways to
  lose the text.
- A lone closing brace is left alone, in code and in prose, so the check looks for
  the opening pair and says nothing about the closing one. Flagging both would have
  been the obvious guess and a false positive.
- An unclosed opening brace is a build **error** — `Interpolation end sign was not
  found`, exit 1 — so every silent case is one with a matched pair.

**The check.** `npm run verify:docs-interpolation` scans every markdown page under
`docs/` and fails one holding an unescaped opening brace outside a fence and
outside a `v-pre` element, naming the file, the line, and the three ways out
(wrap it, fence it, or say it without braces). Which files are pages is asked of
`docs/.vitepress/config.ts`'s `srcExclude` rather than restated, so
`docs/readme/README_zh.md` — the Chinese README, a GitHub page that no Vue
renders — is out of the scan. A config that cannot be imported, or a `srcExclude`
pattern this matcher cannot read, exits 2: without them the check cannot tell a
page from a file VitePress never builds, and would be reporting coverage it does
not have. The glob matcher moved to `scripts/lib/globs.mjs` in the same change,
because two checks now need the same answer and a second copy is a second thing to
drift.

**The check had the same hole as the page, and writing this section found it.** The
first version read each line as raw text: a `<span v-pre>` anywhere on it was taken
to protect the braces after it. Authoring the row above produced the shape that
mistake protects and the compiler does not, because the tag's own angle brackets
land inside a code span:

```
own `<span v-pre>`${{ !cancelled() }}`</span>` here
```

markdown-it escapes a tag written that way, so Vue sees no element, compiles the
interpolation, and the page throws again — while the scanner had passed the file.
It now reads inline code spans as CommonMark does, a run of N backticks to a run of
exactly N, and honours a `v-pre` tag only when it is outside one; a brace **inside**
a code span is still a violation, because that is measured to render as nothing. The
fixture for the shape is in the list below so it cannot come back, and the mutation
that proves it is the row above, restored to what went wrong.

**The rule's own controls run first**, fifteen fixtures taken from the measurements
above, and the suite fails with exit 2 if any of them stops behaving as measured.
The ones that pass without a mechanism — a fence, a tilde fence, a `v-pre` span that
ends before the rest of the line, a lone closing brace — are in the list beside the
failing ones, because a scanner that reported nothing at all would otherwise satisfy
the failing half.

**Verified by six mutations, each reverted.** The original defect, put back into
`docs/roadmap.md`, fails naming its line; the trap above — a `v-pre` tag inside a
code span, which the first version passed and the build rejects — fails too; braces
inside a real fence in `docs/testing.md` pass; braces added to the excluded Chinese
README pass, which is the control for the exclusion being read rather than the file
happening to be clean; a missing config exits 2; an unparseable `srcExclude` pattern
exits 2.

**What it does not check.** A Vue render error from any other cause — a component
reference, a bad `v-if` — is not covered here and is not covered anywhere else
either: the build logs it and still exits 0. And a fence is taken to be one whose
delimiter starts within three spaces of the line start, per CommonMark, so a fence
indented further inside a list item would read as prose and fail as a false
positive. This checks the one cause that has been observed.

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
