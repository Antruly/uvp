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
> uvp is distributed from [uvp-labs/uvp](https://github.com/uvp-labs/uvp). The
> npm package name `uvp-agents` is reserved for the first release and is **not
> yet published** — until it is, install from a source checkout. A similar
> repository name or a copied README does not establish that a download is
> official.

---

uvp turns a description of a C++ web service into a real CMake project, builds it
against [libuvcpp](https://github.com/Antruly/libuvcpp), starts it, drives
requests at it, and hands back a report that separates what it **observed** from
what it **derived** and from what it could **not establish**.

It is one CLI and one MCP server. The same 13 tool contracts back both, so
an agent and a shell script get identical behaviour and identical evidence.

The generated code is not a uvp artifact. It is ordinary libuvcpp C++ that builds
with `cmake -S . -B build && cmake --build build` and nothing else installed. You
can walk away from uvp and keep the project.

## Quick start

### Requirements

- Node.js `^22.19.0 || ^24.11.0 || >=26.0.0`
- A C++14 toolchain (`g++` or `clang++`) and CMake 3.20+
- [libuvcpp](https://github.com/Antruly/libuvcpp) **1.7.0 or newer**, either
  `cmake --install`ed or unpacked from a release archive

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
git clone https://github.com/uvp-labs/uvp
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
uvp run ./svc --ready-port 8080
uvp http GET http://127.0.0.1:8080/items/1 --json
uvp stop --all
```

Or as one supervised pass that cleans up after itself:

```bash
uvp verify ./svc --port 8080 \
  --request GET /items/1 \
  --assert status=200 \
  --assert 'json:$.value=first'
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

| Task                                                           | Tools                                   |
| -------------------------------------------------------------- | --------------------------------------- |
| Check the toolchain and which libuvcpp modules are present     | `uvp_doctor`                            |
| Scaffold a buildable project (5 templates)                     | `uvp_workspace_create`                  |
| Configure and build with CMake                                 | `uvp_build`                             |
| Start a service and wait for it to actually answer             | `uvp_run`, `uvp_run_stop`               |
| Drive HTTP/1.1 and HTTP/2 requests, with timing and TLS detail | `uvp_http_request`                      |
| Probe a WebSocket endpoint                                     | `uvp_websocket_probe`                   |
| Post a SOAP envelope and read the reply                        | `uvp_soap_call`                         |
| Measure throughput and latency percentiles                     | `uvp_load_test`                         |
| Record a session of exchanges for later reading                | `uvp_capture_start`, `uvp_capture_read` |
| Evaluate assertions against a recorded exchange                | `uvp_assert_exchange`                   |
| Do all of the above as one supervised pass                     | `uvp_verify`                            |

Templates: `hello-http`, `rest-api`, `websocket-echo`, `soap-service`,
`static-files`.

Features: `tls`, `http2`, `http3`, `grpc`, `websocket`, `soap`, `db`. Each maps
to real libuvcpp CMake switches and configuration macros; the mapping is
documented, including the two features libuvcpp has no switch for.

<a id="current-status"></a>

## Current status

uvp is pre-1.0 and under active construction. Being precise about what that
means is more useful than a percentage:

**Working and verified.** The full closure — describe → generate → build → run →
probe → evidence — passes against a real libuvcpp 1.7.0 install for all five
templates. The generated projects build via `find_package(uvcpp 1.7.0 CONFIG)`
where a CMake package exists and via `pkg-config` where it does not, because the
prebuilt release archives ship the latter and not the former. The version floor
is enforced on both routes.

**In progress.** The CLI and MCP adapters, and the provider abstraction that
would let a build run in a container or over SSH rather than only on the local
machine. The provider _port_ is defined and the local provider implements it;
the other providers are not written.

**Not started.** Release automation, the container and remote toolchain
providers, and the C++ native probe module that would let a generated service
expose its own instrumentation over libuvcpp's C ABI.

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
package route works there. The uvp toolchain provider is currently local and
POSIX-oriented; a Windows provider is not written yet. The doctor reports this
rather than pretending otherwise.
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
- [Tool design](docs/tool-design.md) — how a uvp tool boundary is chosen
- [Testing](docs/testing.md) — test depths and real-toolchain lanes
- [Roadmap](docs/roadmap.md) — what is planned and what gates admission
- [Releasing](docs/releasing.md) — the release process
- [AGENTS.md](AGENTS.md) — repository rules for AI agents
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
