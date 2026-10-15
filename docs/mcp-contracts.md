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
| `uvp_http_request`     | web       |     |     |  ●  |      |     |     ●     |
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

### Toolchain

**`uvp_doctor`** — Inspect toolchain readiness.
Reports the compiler, CMake, and libuvcpp build found on this machine, which
modules that build provides, and which capabilities each gap blocks. Run it
first; every other tool's failure is easier to read with its output in hand.
Takes an optional `features` list and an optional provider id.

### Workspace

**`uvp_workspace_create`** — Create a libuvcpp workspace.
Scaffolds a CMake project from one of five templates, at a path you name. It
writes files and starts nothing. Refuses to overwrite an existing workspace
unless told to.

### Build

**`uvp_build`** — Build a workspace.
Configures and compiles through CMake, using the toolkit and libuvcpp install
that `uvp_doctor` found. A compile failure is a normal result carrying
phase-tagged diagnostics, not an error — an agent can read the diagnostics and
try again. `untrusted` because compiler output is the compiler's words, not uvp's.

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
body, and timing as observed facts.

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
can be re-examined without re-issuing the request.

### Workflow

**`uvp_verify`** — Build, run, exercise, and report.
The whole closure in one supervised pass: configure, compile, launch, drive the
requests you describe, evaluate the assertions, stop, and return a bundle whose
status is `verified`, `partial`, `failed`, or `unknown`. See
[Evidence model](evidence.md#verification-status) for what each status requires.

**`uvp_bundle_diff`** — Compare two verification reports.
Takes two paths to reports `uvp_verify` wrote and says what moved between them:
the status, each request's verdict and failures, the questions left unanswered.
It reports separately what the pass's own `bundle_digest` covers and what falls
outside it — failure _text_, the build, the service state — because two reports
can share a digest while the sentence explaining a failure changed. It refuses to
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
npm run tool-catalog:check:built    # what CI runs; fails on a stale file
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
