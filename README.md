<div align="center">

**English** · [简体中文](docs/readme/README_zh.md)

# uvp: libuv-powered, AI-native web framework

### One MCP for building, running, and verifying libuvcpp-powered C++ web services.

**Describe a service. Get C++ that builds, runs, and answers — with the evidence to prove it.**

[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![libuvcpp baseline](https://img.shields.io/badge/libuvcpp-1.7.0-2c3e50?style=flat-square)](https://github.com/Antruly/libuvcpp)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#requirements)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [How uvp works](#how-uvp-works) · [What uvp can do](#what-uvp-can-do) · [Current status](#current-status) · [FAQ](#faq) · [Documentation](#documentation)

<code>npx uvp-agents setup</code>

</div>

> [!IMPORTANT]
> uvp is distributed from [Antruly/uvp](https://github.com/Antruly/uvp). The
> npm package name `uvp-agents` is reserved for the first release and is **not
> yet published** — until it is, install from a source checkout. A similar
> repository name or a copied README does not establish that a download is
> official.

---

uvp turns a description of a C++ web service into a real CMake project, builds it
against [libuvcpp](https://github.com/Antruly/libuvcpp), starts it, drives
requests at it, and hands back a report that separates what it **observed** from
what it **derived** and from what it could **not establish**.

It is one CLI and one MCP server. The same 15 tool contracts back both, so
an agent and a shell script get identical behaviour and identical evidence.

The generated code is not a uvp artifact. It is ordinary libuvcpp C++ that builds
with `cmake -S . -B build && cmake --build build` and nothing else installed. You
can walk away from uvp and keep the project.

## Quick start

### Requirements

- Node.js `^22.19.0 || ^24.11.0 || >=26.0.0`
- A C++14 toolchain (`g++` or `clang++`; MSVC 2019+ on Windows, where CI has
  exercised Visual Studio 2026 / MSVC 14.51 only) and CMake 3.20+
- [libuvcpp](https://github.com/Antruly/libuvcpp) **1.7.0 or newer**, either
  `cmake --install`ed or unpacked from a release archive

On Windows, the archive route needs a real `pkg-config.exe` and a Release build;
[installation.md](docs/installation.md#windows-msvc)
has the exact steps.

Run the doctor first. It reports what is present, what is missing, and which
capabilities each gap actually blocks — rather than failing as one monolith:

```bash
uvp doctor --json
```

### Set up your agent

```bash
npx uvp-agents setup      # not yet published; see the note above
```

Until the first release, run from a checkout:

```bash
git clone https://github.com/Antruly/uvp
cd uvp
npm ci && npm run build:cached
node scripts/uvp.mjs setup
```

Setup prints every configuration change it intends to make and asks for approval
before writing anything. It backs up existing configuration.

### Ask your agent

> Build me a JSON API on port 8080 with an `/items` collection and a WebSocket
> echo endpoint. Then start it and prove `/items/1` returns 200 with the right
> body, and that the echo endpoint actually echoes.

The agent scaffolds the workspace, builds it, runs it, exercises it, and reports
back a verification bundle. If the build fails, the compiler diagnostics come
back as structured data and the agent can fix them.

### Use the terminal

```bash
uvp init ./svc --name svc --template rest-api --port 8080 --features websocket
uvp build ./svc
uvp run ./svc --port 8080
uvp http GET http://127.0.0.1:8080/items/1 --json
```

`uvp run` detaches by default: the service is still listening after the command
returns, and a later `uvp stop --all` starts a new CLI process whose registry is
empty, so it cannot see it. Stop the pid `uvp run` printed, or use the supervised
pass below, which starts, checks, and stops the service in one call.

Or as one supervised pass that cleans up after itself (one line, so it is
copy-pasteable in `cmd.exe` as well as a POSIX shell; double quotes keep the
JSONPath intact in every shell):

```bash
uvp verify ./svc --port 8080 --request GET /items/1 --assert status=200 --assert "json:$.value=first"
```

## How uvp works

Four stages, each of which produces evidence rather than an assertion.

**1. Describe.** You name a template, a port, and the transport modules you need.
Before anything is written, the requested features are checked against the
libuvcpp build you actually have — read out of its generated `uvcpp_config.h` and
its installed headers, never inferred from its version number. Two 1.7.0 builds
can differ in whether HTTP/3 was compiled in, so a version number is not
evidence.

**2. Generate.** uvp writes a complete CMake project. Where a requested module is
missing, the generated `main.cpp` carries a `#if` guard that names the CMake
option to rebuild libuvcpp with, so the failure is one readable line instead of a
cascade of unknown-identifier errors inside libuvcpp's own headers.

**3. Build and run.** CMake's output is parsed into structured diagnostics
tagged with the phase that produced them, so a header error is distinguishable
from a link error. The service starts under supervision and is considered ready
only when the readiness probe answers — never after a fixed sleep. The `ready`
field reports whether the probe succeeded or the timeout expired.

**4. Exercise and report.** Requests are issued over real sockets, assertions are
evaluated against the real response, and the result is a bundle whose status is
`verified` only when every step that was _attempted_ succeeded. Anything skipped
becomes a residual unknown with a reason attached. Missing coverage is reported
as `unknown`, never as `complete`.

That last rule is the one that shapes everything else. A tool that says
"verified" when it merely did not look is worse than one that says nothing.

## What uvp can do

| Task                                                        | Tools                                   |
| ----------------------------------------------------------- | --------------------------------------- |
| Check the toolchain and which libuvcpp modules are present  | `uvp_doctor`                            |
| Scaffold a buildable project (6 templates)                  | `uvp_workspace_create`                  |
| Configure and build with CMake                              | `uvp_build`                             |
| Start a service and wait for it to actually answer          | `uvp_run`, `uvp_run_stop`               |
| Drive HTTP/1.1, HTTP/2, and HTTP/3 requests, and report TLS | `uvp_http_request`                      |
| Probe a WebSocket endpoint                                  | `uvp_websocket_probe`                   |
| Post a SOAP envelope and read the reply                     | `uvp_soap_call`                         |
| Measure throughput and latency percentiles                  | `uvp_load_test`                         |
| Record a session of exchanges for later reading             | `uvp_capture_start`, `uvp_capture_read` |
| Replay a recorded session against a live target             | `uvp_capture_replay`                    |
| Evaluate assertions against a recorded exchange             | `uvp_assert_exchange`                   |
| Do all of the above as one supervised pass                  | `uvp_verify`                            |
| Compare two verification reports and see what moved         | `uvp_bundle_diff`                       |

Templates: `hello-http`, `rest-api`, `websocket-echo`, `soap-service`,
`static-files`, `http3-service`.

Features: `tls`, `http2`, `http3`, `grpc`, `websocket`, `soap`, `db`. Each maps
to real libuvcpp CMake switches and configuration macros; the mapping is
documented, including the two features libuvcpp has no switch for.

Most templates start a `uvcpp_web_app`. `http3-service` does not: it is written
against `uvcpp_http_server`, which is the only type in 1.7.0 that can open a QUIC
listener, and it serves one route table over TCP and HTTP/3 at once.

`db` is the one feature that changes what a template keeps. `rest-api` is the
only template with a store, so `--features db` writes it over libuvcpp's
connection pool — SQLite, MySQL or PostgreSQL, from `UVP_DATABASE_URL`, with a
SQLite file in the working directory as the default — in place of its in-memory
map. The routes, status codes and JSON are the same either way. Declaring `db` on
any other template is a build requirement, as every feature is, and no more.

<a id="current-status"></a>

## Current status

uvp is pre-1.0 and under active construction. Being precise about what that
means is more useful than a percentage:

**Working and verified.** The full closure — describe → generate → build → run →
probe → evidence — passes against a real libuvcpp 1.7.0 install for all six
templates. The generated projects build via `find_package(uvcpp 1.7.0 CONFIG)`
where a CMake package exists and via `pkg-config` where it does not, because the
prebuilt release archives ship the latter and not the former. The version floor
is enforced on both routes.

The CLI and the MCP server are both built, and both are exercised as processes
rather than as modules: `tests/boundary/cli/cliContract.test.ts` runs the CLI and
checks what it prints and what it exits with, and
`tests/boundary/mcp/mcpSurface.test.ts` speaks the stdio protocol to the server.
CI runs the same lanes on a clean machine, and its packaged lane also installs the
packed tarball into an empty prefix and runs the CLI's first commands and the MCP
handshake from the installed copy, which is where a file missing from `files[]`
shows up. What each CI lane has _actually_ reported is tracked in
[docs/roadmap.md](docs/roadmap.md) rather than assumed here: the first run that
reached a test at all found four defects and stopped there, and a lane whose
coverage is claimed and not yet seen is marked as such next to it.

The WebSocket probe runs on two stacks: a Node client by default, and libuvcpp's
own client through `uvcpp-probe`, a small C++ program that speaks the C ABI. That
second stack is what answers whether a service uvp generated talks to the stack it
was generated for, since two clients that both claim RFC 6455 can disagree about
everything the RFC leaves open. `uvcpp-probe` is built by `npm run
build:native-probe`, is a separate process rather than a module uvp loads, and is
depended on by nothing uvp generates. `tests/toolchain/nativeProbe.test.ts`
generates a workspace, builds it with the CMake uvp found, starts it, and probes
it with the real binary: what the run reports, what the stack refuses before
anything is spawned, and what a person reads without `--json`.

HTTP/3 is answered the same way, and for the same reason: Node's standard library
has no HTTP/3 client, so `uvp http --http-version 3` goes through `uvcpp-probe`'s
QUIC client — libuvcpp's own, which is the stack a generated service links
against. The same lane is what checks it, so the claim is that one implementation
agrees with itself across the wire rather than that two projects read a spec
alike. Three things this path will not do, and says so instead of guessing:
`http://` is refused because QUIC has no cleartext mode, `verify_tls` is refused
because that client verifies against a CA bundle it is handed or not at all, and
redirects are refused because the probe makes one request. The result reports
`verification: not_checked` rather than a certificate nobody examined, and names
the response headers it read rather than presenting them as the whole set. That
half of the probe exists only when the libuvcpp it was built against has the
HTTP/3 C ABI: without it the probe is still built, complete for WebSocket, and
`--version` reports which exchange is missing and what to change — the install,
not the probe build — so a host without HTTP/3 loses one transport rather than the
whole native stack. See
[the probe's HTTP/3 build gate](docs/roadmap.md#the-probe-s-http-3-build-gate).

The database-backed template is verified as a store rather than as a transport, and
the assertion is a restart: `tests/toolchain/database.test.ts` writes a value
unique to the run, stops the service, starts it again, and reads the value back —
which is the only thing that separates a store from a handler that answers
`{"stored":1}` and forgets. The lane exercises SQLite, the one dialect that needs
nothing else installed; MySQL and PostgreSQL go through the same generated code
and the same driver-loading path, and are not claimed as observed.

**In progress.** The web toolbox — request, WebSocket probe, SOAP call, load
test, capture, assertions — works against any service, not only ones uvp
generates. The toolchain provider _port_ has two implementations: `local` and
`container`. The `remote-ssh` provider is not written; it is blocked on a real
verification route rather than on appetite.

**In progress.** Release automation: `release-please-config.json`, the
conventional-commit gate on pull request titles, and the workflow that runs
release-please (`.github/workflows/release-please.yml`, added in #177 for #160)
exist, but no
version has been cut, so the package is installed from a clone or a tarball.
Regenerating the derived files on the release PR is still a maintainer step, by
the recorded decision on #160.

The Windows `local-msvc` lane has landed and runs in CI. It exercises the
database refusal case. The parser reads MSVC's `LNK` shape, but only against
documented examples — no test drives a real `link.exe` failure, and the two tests
that drive a real linker still skip there because their fixture is a GNU `ld`.
The rest of that list has landed and is checked: every action under
`.github/` is SHA-pinned with the release named beside it
(`npm run verify:actions`), the tarball packs to the same digest from the tree,
from an unpacked copy at another path, and after a clean rebuild of `dist/`
(`npm run verify:pack-reproducible`), and the release artifacts carry a
machine-readable inventory — `sbom.cdx.json`, CycloneDX 1.5 over the production
dependency closure, regenerated and compared byte for byte inside the gate, and
shipped in the tarball with the notices it agrees with.

See the [roadmap](docs/roadmap.md) for what is planned and the
[testing guide](docs/testing.md) for which lanes exist.

## Worked example

A generated `rest-api` workspace, verified end to end:

```bash
$ uvp verify ./svc --port 8091 --request GET /items/1 \
    --assert status=200 --assert 'json:$.value=first'
```

```
build      succeeded (Debug, unix-makefiles, 4.1s)
libuvcpp   1.7.0 via CMake package (/opt/uvcpp/lib/cmake/uvcpp)
service    listening on 8091, ready after 38ms
exchange   GET /items/1 -> 200 in 2ms
  status_equals 200          pass
  body_json_path_equals $.value=first   pass
status     verified
```

When something is skipped, it says so instead:

```
status     partial
unverified http2 responsiveness — requested feature http2 is not present in the
           installed libuvcpp build (UVCPP_NGHTTP2_ENABLE is 0)
```

## FAQ

<details>
<summary>Why TypeScript, if the output is C++?</summary>

Because the hard part is not the C++. It is the contracts, the code generation,
the diagnostic parsing, and the evidence algebra — all of which change often and
are painful to get right in C++. The C++ that uvp produces is ordinary C++ that
links libuvcpp directly; there is no uvp runtime library in the generated
project and nothing to install alongside it.

This mirrors the engineering split that makes REA work: a replaceable control
plane in TypeScript, with the substrate reached through a narrow, tested
boundary.
</details>

<details>
<summary>Why is a failing build not an error?</summary>

A build that fails is the tool working. The result is the diagnostics, and they
are structured, phase-tagged, and machine-readable. Only the inability to run the
toolchain at all is an error. Conflating the two makes an agent's fix-and-retry
loop indistinguishable from a broken installation.
</details>

<details>
<summary>What does "unknown" mean here?</summary>

It means uvp did not establish the answer, and knows it did not. Every
unestablished question is recorded with a reason — `toolchain_missing`,
`unsupported_by_build`, `cancelled`, `out_of_scope`, and so on. A coverage report
is `complete` only when uvp actually looked at everything in scope.

The distinction that matters: "the build lacks HTTP/2" and "uvp could not
determine whether HTTP/2 is available" are different findings, and only one of
them is true when a probe is missing.
</details>

<details>
<summary>What is the libuvcpp version floor, and why 1.7.0?</summary>

Generated projects require libuvcpp **1.7.0 or newer** through both discovery
routes. 1.7.0 is the most feature-complete release and is the baseline the
templates are verified against. It is a floor rather than a pin because the API
the templates use has been stable across the 1.x line, and pinning would force a
rebuild of libuvcpp for no benefit.

An older libuvcpp fails the check with the version it found named in the message.
</details>

<details>
<summary>Does uvp work on Windows?</summary>

The generated projects do — the CMake templates branch for MSVC and the CMake
package route works there. The `local` provider is exercised on Windows by the
`windows-toolchain` CI lane with MSVC, where the database refusal case runs.
MSVC `LNK` link failures have a parser format since #142, but it is checked
against documented examples only: no test drives a real `link.exe` failure, and
the two tests that drive a real linker skip there because their fixture is a GNU
`ld`. The doctor reports what it can and cannot establish rather than pretending
otherwise.
</details>

## Documentation

- [Installation and setup](docs/installation.md) — requirements, libuvcpp
  discovery, agent configuration
- [CLI and evidence](docs/cli.md) — every command, output shape, exit status
- [MCP contracts](docs/mcp-contracts.md) — the generated tool catalog
- [Architecture](docs/architecture.md) — layers, dependency direction, the
  provider port
- [Evidence model](docs/evidence.md) — observed, derived, unknown, and how to read
  a verification report
- [libuvcpp feature mapping](docs/libuvcpp-features.md) — what each feature needs
  from a libuvcpp build, verified against 1.7.0
- [First-release support matrix](docs/support-matrix.md) — what the CI lanes have
  observed, derived, and left unknown
- [Release notes](docs/release-notes.md) — what shipped in the first public
  release and what remains unknown
- [Tool design](docs/tool-design.md) — how a uvp tool boundary is chosen
- [Testing](docs/testing.md) — test depths and real-toolchain lanes
- [Roadmap](docs/roadmap.md) — what is planned and what gates admission
- [Releasing](docs/releasing.md) — the release process
- [AGENTS.md](AGENTS.md) — repository rules for AI agents
- [AI development workflow](docs/agent-workflow.md) — roles, ownership, review, and the approval gate
- [AI engineer operations](docs/ai-engineer-operations.md) — identity, task-taking, and hand-back rules
- [Current development plan](docs/work-plan.md) — current progress, open work, and directions
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution scope and AI governance

## Disclaimer

uvp generates and runs C++ web services on your machine, with your permissions.
Generated services listen on network sockets and, when you ask for it, make
outbound requests. It is your responsibility to know what you are building and
where it is reachable. See [DISCLAIMER.md](DISCLAIMER.md).

## Contributing

Bug fixes, documentation improvements, tests, and new templates are welcome.
uvp is an AI-native project and AI-assisted contributions are expected — every
contribution must still have a human owner who has read the diff and takes
responsibility for it. See [CONTRIBUTING.md](CONTRIBUTING.md) for the AI
contribution policy and [AGENTS.md](AGENTS.md) for the rules that apply to
agents specifically.

## License

[MIT](LICENSE). Third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
