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
| ✅  | 13 tool contracts, shared by the CLI and MCP surfaces                                            |
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
| ⬜  | WebSocket frames: send, receive, expect, close codes                     |
| ✅  | SOAP envelopes with the raw body preserved alongside the parsed one      |
| ⬜  | Load testing with per-sample timings retained behind the percentiles     |
| ⬜  | Capture with an explicit, reported size limit                            |
| ⬜  | The native probe module (`uvcpp-probe.node`) over libuvcpp's C ABI       |

The probe module exists so that a WebSocket check goes through libuvcpp's own
stack rather than through a Node client that happens to speak the same protocol.
It reaches the C ABI (`UVCPP_ENABLE_CAPI=ON`), which is why that switch is on in
the toolchain CI lane.

## Milestone 2 — more providers

`local/` is the only provider implemented. The port was designed for more from
the start: `inspectAvailability` separate from use, gaps per capability rather
than all-or-nothing, and `ToolchainClient` apart from `ToolchainProvider` so an
inspection-only provider stays implementable.

|     |                                                                                              |
| --- | -------------------------------------------------------------------------------------------- |
| ⬜  | `container/` — build inside a pinned image, reporting the host-filesystem gap honestly       |
| ⬜  | `remote-ssh/` — build and run on another machine, with the provider identity on every result |
| ⬜  | A provider conformance suite both of them must pass                                          |

The conformance suite comes first. Two providers that pass the same suite are
swappable; two that merely both "work" are two code paths.

## Milestone 3 — depth

|     |                                                                       |
| --- | --------------------------------------------------------------------- |
| ⬜  | HTTP/2 and HTTP/3 end-to-end, template through probe                  |
| ⬜  | TLS with real certificates, including the failure paths               |
| ⬜  | Database-backed templates                                             |
| ⬜  | Replaying a capture as a regression suite                             |
| ⬜  | Comparing two evidence bundles by semantic digest to see what changed |

The last one is the reason `digest` is semantic rather than a record hash. Two
runs of the same check on the same subject produce the same digest, so a diff
between them is a change in the world and not in the clock.

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
| ⬜  | A cap on capture size enforced by the session, not only reported                                                                                                                      |

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
