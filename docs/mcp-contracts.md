# MCP contracts

uvp exposes 15 tools over MCP, from the same contracts that back the CLI. This
page is the reference: what each tool does, what it touches, and what a result
contains.

The catalog is generated from the contracts, so what is here and what an agent
sees cannot drift. A machine-readable copy ships at
`docs/public/tool-catalog.json`.

## Connecting

```bash
npx uvp-agents setup     # prints client configuration
```

The server runs over stdio. There is no uvp daemon listening on a port and no
network service of any kind — the transport is the parent process's standard
input and output.

The registry entry is `io.github.Antruly/uvp`; the npm package is
`uvp-agents`.

## The tools

`R` reads filesystem · `W` writes filesystem · `net` network · `proc` spawns a
process · `mut` can change state outside the workspace. `untrusted` marks a tool
whose results can contain bytes that did not originate with uvp.

| Tool                   | Kind      |  R  |  W  | net | proc | mut | untrusted |
| ---------------------- | --------- | :-: | :-: | :-: | :--: | :-: | :-------: |
| `uvp_doctor`           | toolchain |  ●  |     |     |  ●   |     |           |
| `uvp_workspace_create` | workspace |  ●  |  ●  |     |      |     |           |
| `uvp_build`            | build     |  ●  |  ●  |     |  ●   |     |     ●     |
| `uvp_run`              | runtime   |  ●  |  ●  |  ●  |  ●   |  ●  |     ●     |
| `uvp_run_stop`         | runtime   |     |     |     |  ●   |  ●  |           |
| `uvp_verify`           | workflow  |  ●  |  ●  |  ●  |  ●   |  ●  |           |
| `uvp_bundle_diff`      | workflow  |  ●  |     |     |      |     |           |
| `uvp_http_request`     | web       |     |     |  ●  |  ●   |     |     ●     |
| `uvp_websocket_probe`  | web       |     |     |  ●  |  ●   |     |     ●     |
| `uvp_soap_call`        | web       |     |     |  ●  |      |     |     ●     |
| `uvp_load_test`        | web       |     |     |  ●  |      |  ●  |           |
| `uvp_capture_start`    | web       |     |     |  ●  |      |  ●  |           |
| `uvp_capture_read`     | web       |  ●  |     |     |      |     |     ●     |
| `uvp_capture_replay`   | web       |  ●  |     |  ●  |      |     |           |
| `uvp_assert_exchange`  | web       |  ●  |     |     |      |     |           |

Read the table before granting a tool. `uvp_run_stop` reports no filesystem
access at all: it signals a process this session started and nothing else.
`uvp_websocket_probe` reports `proc` unconditionally, although only
`stack: "libuvcpp"` starts anything: the effect set is a closed set of booleans
and cannot say "sometimes", and a caller deciding whether to confirm is better
served by a yes it may not use than by a no that is not always true.
`uvp_http_request` is the same case: `http_version: "3"` runs `uvcpp-probe` as a
process, while the HTTP/1.1 and HTTP/2 spellings start nothing.

### Toolchain

**`uvp_doctor`** — Inspect toolchain readiness.
Reports the compiler, CMake, and libuvcpp build found on this machine, which
modules that build provides, and which capabilities each gap blocks. Run it
first; every other tool's failure is easier to read with its output in hand.
Takes an optional `features` list and an optional provider id.

Point it at a workspace and it reads the same `toolchain` declaration `uvp_build`
obeys: a workspace that names a container is reported with that image's toolchain
beside this host's, so a host with no container runtime says so before a build
rather than during one. The `libuvcpp` and `features` sections then describe the
toolchain the workspace named, because that is the one the build will use — and
when the image cannot be examined at all, they say so instead of answering from
this host. `uvp_doctor` never starts a build and never pulls an image.

### Workspace

**`uvp_workspace_create`** — Create a libuvcpp workspace.
Scaffolds a CMake project from one of six templates, at a path you name. It
writes files and starts nothing. Refuses to overwrite an existing workspace
unless told to.

### Build

**`uvp_build`** — Build a workspace.
Configures and compiles through CMake, using the toolkit and libuvcpp install
that `uvp_doctor` found. A compile failure is a normal result carrying
phase-tagged diagnostics, not an error — an agent can read the diagnostics and
try again. `untrusted` because compiler output is the compiler's words, not uvp's.

A workspace may declare where it is built, in its `uvp.json`:

```json
{ "toolchain": { "kind": "container", "image": "localhost/uvp-base:12" } }
```

That build runs inside the image, so it starts a container on this host — which
is why it is the workspace's file that says so and not an argument. `toolchain`
on the call requires a container or refuses one, and never names an image: a
`"container"` from a caller fails with `missing_requirement` when no workspace
named one, and a `"local"` checks a container-declared workspace with this host's
compilers. The result's `provider` is the toolchain that actually ran, so a
container build reports the image, and its `limitations` carry the two things
that follow: the artifacts are linked against the image's libuvcpp at an in-image
path and may not start here, and anything the build wrote outside the workspace
was discarded with the container. `uvp_verify` refuses a container-declared
workspace with `unsupported_toolchain`, because a pass runs what it builds.

### Runtime

**`uvp_run`** — Run a built service.
Starts the binary, waits until it is listening, and returns a handle plus the
startup output. The process is supervised by the uvp session: it is stopped when
the session ends, and `uvp_run_stop` stops it earlier. `mut: true` because a
running service listens on an interface and can act on requests.

**`uvp_run_stop`** — Stop a supervised service.
Signals a process this session started, by handle or all at once. It cannot
signal a process uvp did not start.

### Web

**`uvp_http_request`** — Send an HTTP request.
Method, URL, headers, body, redirect policy, timeout. Returns status, headers,
body, and timing as observed facts. `http_version` names the version to
_attempt_ — `auto`, `1.1`, `2`, or `3` — and the version the response actually
arrived in comes back as `http_version` in the result, spelled as the wire spells
it (`"1.1"`, `"2.0"`). `auto` negotiates and falls back; a pinned version the peer
does not answer in is `unsupported_target` rather than `endpoint_unreachable`,
because the service replied and the caller should not be sent to check whether it
is listening. `3` runs the native probe (`uvcpp-probe`) and is refused when this
uvp was built without it, when the URL is `http://` (QUIC has no cleartext
mode), when `verify_tls` is set, and when redirects are requested; each refusal
names its reason rather than answering over another transport.

Over TLS the result carries what the connection's certificate was, under `tls`:
protocol, cipher, subject, issuer, validity window, and `verification` — one of
`verified`, `not_checked`, `undetermined`, or `failed`, with `reason` naming
OpenSSL's own finding. It is an enum rather than a boolean because the boolean had
one value it could honestly take: `verified: false` with `errors: []` was written
for a plaintext request, for an exchange where the caller had turned checking off,
and for one whose certificate was rejected — three different facts, one record.
`not_checked` says the caller set `verify_tls: false`, and `reason` still reports
what OpenSSL found, because turning the check off is how a caller looks at a
certificate without accepting it. A certificate this client will not accept is
`target_unavailable` with `retryable: false` and the reason code in
`details.reason_code`, not `endpoint_unreachable`: the service answered, and its
certificate is the whole of what went wrong.

**`uvp_websocket_probe`** — Probe a WebSocket endpoint.
Performs the upgrade handshake, optionally sends frames, and returns the
handshake response and any frames received. A successful probe is a `101`, which
is reported as such rather than as an error. Each entry in `expect` is answered in
`expectations` against received frames only, with `matched_frame_index` naming the
frame that answered it; `expectations_met` is the verdict, and an unmet one is a
field rather than an error so the frame log that shows why comes back with it.

`stack` chooses the client that answers: `node`, or `libuvcpp` — the stack a
generated service links against, run as a separate probe process. The second one
sees less, and says so: `handshake` is absent rather than empty, the blind spots
are listed in `not_observable`, and `abandoned` marks a run whose report was
written without its client loop returning, which leaves everything after the last
recorded frame unknown rather than absent. What it cannot do at all — `wss://`,
request headers, subprotocols, a paced send — is `invalid_request`, decided
before anything is spawned. A host without the probe binary is
`toolchain_unavailable`, with `unavailable` and `undetermined` distinguished in
`details.state`.

**`uvp_soap_call`** — Invoke a SOAP operation.
Builds a SOAP envelope around a payload you supply and returns the parsed
response, with the raw body preserved alongside it.

**`uvp_load_test`** — Measure latency under concurrency.
Drives a fixed number of requests at a concurrency you set and reports
percentiles and error counts. The percentiles are `derived`; the individual
timings they came from are `observed` and are returned as `samples`, in order.
`max_samples` bounds how many are kept, `samples_dropped` reports the rest, and
the distribution is computed from exactly the samples returned. `mut: true`
because it puts load on a service, which is a real effect on the world even
though uvp writes nothing.

**`uvp_capture_start`** — Start capturing traffic.
Begins recording exchanges for a target. Records are held by the session.
`max_body_bytes` sets how much of each body is kept, per direction; it governs
what is recorded, never what is forwarded.

**`uvp_capture_read`** — Read captured traffic.
Returns recorded exchanges, with bodies cut to the session's `max_body_bytes`. The
limit is returned as `body_limit_bytes`, each exchange carries
`request_body_truncated` and `response_body_truncated`, and a read whose bodies
were cut reports a `partial` scope naming the limit in `limitations`. The session
also holds a bounded window — `max_retained_bytes` bounds the recorded bodies it
keeps, and a count ceiling bounds how many exchanges — so a read reports
`withheld_by_retention` for the exchanges that fell out of it, `retained_bytes`
and `retained_limit_bytes` for the bound itself, and `since_id_unknown` when the
cursor given is no longer held. `untrusted` because captured bodies are remote
content.

**`uvp_capture_replay`** — Replay a capture against a target.
Reads recorded exchanges back and issues the same requests again at a target you
name, so a capture taken against one build can be replayed against the next. It
is the one web tool that does not probe the subject: it probes the record, and
the target answers for it. Only `GET`, `HEAD`, and `OPTIONS` are sent —
re-issuing a recorded `POST` would turn a regression suite into a second write,
so those exchanges are `skipped` with the method named in `skipped_methods`.
Each exchange is `matched`, `differs`, `skipped`, or `not_comparable`, and the
run's `outcome` is `verified` only when every replayed exchange was compared and
matched: `partial` means fewer facts were compared than the record holds, and
`unknown` means nothing was compared at all, which is not a pass. Bodies are
compared by digest and never returned, and a side reports a digest only when that
side's bytes are whole. `network` because it contacts the target the caller
named; not `untrusted` because what comes back is a verdict, an outcome per
exchange, and the digests behind them.

**`uvp_assert_exchange`** — Assert over a recorded exchange.
Evaluates assertions against an exchange captured earlier — status, headers, a
JSON path, a body substring. Splitting assertions from requests means a failure
can be re-examined without re-issuing the request. Every assertion asked appears
once in `results`, in the order asked, carrying `status`: `satisfied`, `unmet`, or
`undetermined`. The third one is an assertion the record cannot answer — a header
the client never read, a body that was never recorded — and it is neither a pass
nor a failure: `satisfied + unmet + undetermined` is always the row count, and the
same check is also named in `unknowns` and counted as unexamined in the evidence's
`coverage`. The vocabulary is the one `uvp_doctor` reports feature availability
with, so the same question gets the same word in both places.

### Workflow

**`uvp_verify`** — Build, run, exercise, and report.
The whole closure in one supervised pass: configure, compile, launch, drive the
requests you describe, evaluate the assertions, stop, and return a bundle whose
status is `verified`, `partial`, `failed`, or `unknown`. See
[Evidence model](evidence.md#verification-status) for what each status requires.
Each request carries its own `http_version` to attempt, so one pass can put the
same question to the same service over two protocols; what came back is reported
per exchange as `http_version`, and a request that never completed reports none
at all rather than a default. A queued request that fails is named in
`unverified` with the client's own reason, so a transport refused by design is
distinguishable from a connection that dropped.

`verify_tls` defaults to `false`, the opposite of `uvp_http_request`, and the
reason is the subject of the pass: a verification is about the service's
behaviour, and the workspaces uvp generates for `--features tls` serve a
development certificate, so a pass that enforced by default would fail against
the workspace uvp had just generated. The certificate is reported either way —
each exchange carries `tls_verification`, and `tls_reason` when OpenSSL recorded
one — so the default is visible rather than silent. With `verify_tls: true` a
rejected chain ends the exchange like any other request that could not complete:
it lands in `unverified` with the reason code, the exchange reports no `status`,
and the pass is `unknown` rather than `failed`, because nothing was evaluated.

It takes the same `toolchain` as `uvp_build`, and answers it differently, because
a pass runs what it builds. A workspace that declares a container toolchain is
refused with `unsupported_toolchain` before anything is compiled — a binary built
inside an image carries an in-image RUNPATH and does not start here, and "the
service never came up" would be a verdict about a service. Passing
`toolchain: "local"` is the way past it, and the bundle then reports `local` in
its provider rather than the image.

**`uvp_bundle_diff`** — Compare two verification reports.
Takes two paths to reports `uvp_verify` wrote and says what moved between them:
the status, each request's verdict and failures, the questions left unanswered.
It reports separately what the pass's own `bundle_digest` covers and what falls
outside it — failure _text_, the protocol each exchange arrived in, the build, the
service state — because two reports can share a digest while the sentence
explaining a failure changed. It refuses to
read a difference as a change when the two reports are not comparable at all: a
different workspace is two subjects rather than two moments, and a supplied
digest that does not match the contents it arrived with is a record nothing can
be concluded from. Identifiers and the clock (`bundle_id`, `exchange_id`,
`elapsed_ms`, `service.run_id`, `service.endpoint`) are reported and never
compared, so a repeat pass over an unchanged service reads as `identical`.
`R` because it reads both files whole, and refuses a file above its size limit
rather than truncating it. Not `untrusted`: what comes back is the two reports'
verdicts, counts, and the same failure sentences `uvp_verify` already returns.

## Every result carries the same envelope

```ts
{
  tool: string,
  provider: { id: string, version?: string, platform: string },
  evidence: EvidenceRef[],
  unknowns: ResidualUnknown[],
  limitations: string[]
}
```

`provider` is present so a finding is attributable to a specific toolchain.
`evidence` holds references; the bundle holds the detail. `unknowns` holds the
questions that could not be answered, and a non-empty array is the report being
honest rather than a failure.

## Failures

A failed call returns `isError: true` with a structured error and **no
structured success content**. A caller therefore cannot mistake a partial failure
payload for a result — there is no result to mistake it for.

Errors carry a code from a closed set, a message, and where relevant the
offending field. Input that fails schema validation is reported as
`invalid_request` naming the field, not as a generic refusal.

## Generated catalog

The table above is prose generated from `TOOL_CONTRACTS`. The machine-readable
form ships two ways:

- `docs/public/tool-catalog.json` — served by the documentation site
- inside the npm package, so a client can read it without running the server

```bash
npm run artifacts:tool-catalog      # regenerate
npm run tool-catalog:check          # what CI runs; fails on a stale file
```

Each entry carries the tool name, title, description, kind, JSON Schema for input
and output, the effects block, the derived annotations, the
`returnsTargetContent` flag, and the examples. CI regenerates the catalog and
fails on a diff, so a contract change that did not update the catalog is a build
failure rather than a review comment someone has to remember to leave.

## Untrusted content

Tools marked `untrusted` can return bytes that originated elsewhere: a response
body, a captured frame, a compiler diagnostic. Clients should treat those fields
as data, never as instructions. A remote server that returns
`Ignore previous instructions…` in a body has returned a string, and uvp reports
it as one.

This is why the flag is on the contract rather than in the descriptions. It is a
property of the tool, decided once, and a client can gate on it mechanically.

## Effects are declarations, not enforcement

The `effects` block on a contract says what a tool will do. It is not a sandbox
and does not restrict anything. What it is for:

- A client can require approval for `mutatesTarget` tools and not for others.
- A review can see at a glance that a new tool starts processes.
- The annotations uvp sends to MCP clients (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) are derived from it, so the hints a client
  sees and the record in the code cannot disagree.

A tool whose declaration does not match its behaviour is a bug of the same
severity as a wrong result. See [Tool design](tool-design.md).
