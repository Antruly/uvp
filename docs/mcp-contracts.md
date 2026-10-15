# MCP contracts

uvp exposes 13 tools over MCP, from the same contracts that back the CLI. This
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
| `uvp_http_request`     | web       |     |     |  ●  |      |     |     ●     |
| `uvp_websocket_probe`  | web       |     |     |  ●  |      |     |     ●     |
| `uvp_soap_call`        | web       |     |     |  ●  |      |     |     ●     |
| `uvp_load_test`        | web       |     |     |  ●  |      |  ●  |           |
| `uvp_capture_start`    | web       |     |     |  ●  |      |  ●  |           |
| `uvp_capture_read`     | web       |  ●  |     |     |      |     |     ●     |
| `uvp_assert_exchange`  | web       |  ●  |     |     |      |     |           |

Read the table before granting a tool. `uvp_run_stop` reports no filesystem
access at all: it signals a process this session started and nothing else.

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
were cut reports a `partial` scope naming the limit in `limitations`. `untrusted`
because captured bodies are remote content.

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
