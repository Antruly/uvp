# First-release support matrix

This page records what the first release's CI lanes have actually established.
Every row names the lane, run, or test behind it and says whether the fact is
**observed** (a lane ran it), **derived** (it follows from an observed fact plus a
rule in this repository), or **unknown** (nothing examined it, and the reason is
given).

An `unknown` is not a refusal. It means no observation exists, so the matrix does
not say the configuration fails — it says this repository has not looked.

## The evidence runs

The rows below cite one run on `main` at `933217f`, which exercised every lane
they depend on:

| Run                                                                    | Head      | What it exercised                                                       | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [39015162211](https://github.com/Antruly/uvp/actions/runs/39015162211) | `933217f` | Real libuvcpp, both Windows MSVC generator routes, Windows source gates | [117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136) (Linux), [117345769135](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769135) (Windows ninja), [117345769140](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769140) (Windows default), [117345685736](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345685736) (Windows source) |

The workflow is [`.github/workflows/ci.yml` at `933217f`](https://github.com/Antruly/uvp/blob/933217f/.github/workflows/ci.yml).
`windows-latest` is a moving label, so the runner image and toolset below are
properties of that run, not constants of the repository.

## Host platforms

| Host        | Status   | Evidence                                                                                                                                                                                                                                                                                                                          | Limit                                                                 |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Linux x64   | Observed | Source tests, built test shards, and the real libuvcpp lane on `ubuntu-latest`; six generated workspaces built and run ([job 117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136))                                                                                                             | Ubuntu only; no other distribution or architecture is exercised       |
| Windows x64 | Observed | `windows-source` runs the TypeScript gates; `windows-toolchain` builds and runs all six templates with MSVC in both generator routes ([job 117345685736](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345685736), [job 117345769140](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769140)) | Windows Server 2025 runner image only; no client Windows is exercised |
| macOS       | Unknown  | No lane runs on macOS                                                                                                                                                                                                                                                                                                             | Nothing has been observed about a macOS host or an Apple compiler     |

## Compilers and generators

| Surface                                       | Status                                                       | Evidence                                                                                                                                                                                                                 | Limit                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GCC 13.2.0 (`g++` from Ubuntu 24.04)          | Observed                                                     | Real libuvcpp lane installs `g++` and builds six workspaces ([job 117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136))                                                               | One GCC version only                                                                                                                                                  |
| MSVC 14.51.36231 (Visual Studio 2026 18.10.3) | Observed                                                     | The lane log reports `** Visual Studio 2026 Developer Command Prompt v18.10.3` and `...\VC\Tools\MSVC\14.51.36231\...\cl.exe`; see also [#168](https://github.com/Antruly/uvp/issues/168)                                | One toolset only; see the Visual Studio row below                                                                                                                     |
| Clang                                         | Unknown                                                      | No lane uses `clang++`                                                                                                                                                                                                   | The README names Clang as a requirement; no lane has observed it                                                                                                      |
| Ninja                                         | Observed on Windows; Unknown for generated projects on Linux | The Windows `ninja` route passes `--generator ninja` and builds the six templates ([job 117345769135](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769135))                                         | On Linux, Ninja is installed for libuvcpp's own build, but the lane passes no `--generator` to `uvp build`, so the generated workspaces do not name it                |
| Visual Studio generator (CMake default)       | Observed                                                     | The Windows `default` route omits `-G`, lets CMake choose, and builds and runs the six templates ([job 117345769140](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769140))                          | Only the image's installed Visual Studio is sampled                                                                                                                   |
| Unix Makefiles                                | Derived                                                      | The Linux lane passes no `--generator`, and CMake's default on Linux is Unix Makefiles; the templates configure and build ([job 117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136)) | No lane names `--generator unix-makefiles` explicitly, so the value is derived from CMake's default rather than read from a configure line                            |
| Visual Studio 2019                            | Unknown                                                      | The Windows lane uses `vswhere -latest` and every recorded run used Visual Studio 2026                                                                                                                                   | The README's MSVC 2019+ floor is **inferred** from the generated CMake and the provider; it is not an observation ([#168](https://github.com/Antruly/uvp/issues/168)) |

## libuvcpp discovery

| Route                 | Status                                         | Evidence                                                                                                                                                                                                                                                                                                                    | Limit                                                                                                                                    |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CMake package config  | Observed (install shape); Derived (route used) | The Linux lane installs with `cmake --install` and the log records `installed: /tmp/uvcpp-prefix/lib/cmake/uvcpp/uvcppConfig.cmake` ([job 117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136)); the generated project's `uvp: libuvcpp via ...` line was not retained in that job's log | Which route the generated workspace took is derived from the fallback order and the successful configure                                 |
| `pkg-config` fallback | Observed (install shape); Derived (route used) | The Windows release archive ships `lib/pkgconfig/uvcpp.pc` and no CMake package; the lane requires `pkg-config.exe` and checks `uvcpp.pc` ([`.github/workflows/ci.yml`](https://github.com/Antruly/uvp/blob/933217f/.github/workflows/ci.yml))                                                                              | The CMake route cannot answer without a config file, so the route used is derived rather than read from the generated project's own line |
| libuvcpp 1.7.0 floor  | Observed                                       | Both lanes pin the `v1.7.0` tag or the `msvc-x64` 1.7.0 archive; the generated project enforces the floor on both routes                                                                                                                                                                                                    | A newer libuvcpp was not sampled, so "1.7.0 or newer" is a floor, not an observation about any newer release                             |

## Features

Feature mapping is [libuvcpp feature mapping](libuvcpp-features.md); this table
records what the lanes exercised, not what the mapping allows.

| Feature      | Status                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      | Limit                                                                                                                                       |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TLS          | Observed                              | The Linux lane builds OpenSSL 3.5.0 with the QUIC API and an `http3-service` completes a native exchange; the Windows archive defines `UVCPP_OPENSSL_ENABLE=1` and its `http3-service` starts with a certificate ([job 117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136), [job 117345769140](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769140)) | No standalone TLS test outside the h3 service is in these lanes                                                                             |
| HTTP/2       | Unknown                               | The Linux build records `#  define UVCPP_NGHTTP2_ENABLE 0`; the Windows archive records `UVCPP_NGHTTP2_ENABLE` as enabled, but the toolchain lane asserts no HTTP/2 exchange. `tests/acceptance/http2.test.ts` is not part of the toolchain lane and skips in the shards when no libuvcpp is installed                                                                                                        | No lane has observed a request arriving over HTTP/2                                                                                         |
| HTTP/3       | Observed on Linux; Unknown on Windows | The native probe reports `"exchanges":["websocket","http3"]` and `nativeProbe.test.ts` completes an h3 exchange with libuvcpp's own QUIC client on Linux; on Windows the probe is not built and its five tests skip by name                                                                                                                                                                                   | The Windows `http3-service` row observes the template building, starting both legs, and answering on the route table — not the h3 transport |
| WebSocket    | Observed                              | `websocket-echo` completes the upgrade and echoes a frame on both lanes; libuvcpp's own WebSocket client exchange is observed on Linux through the probe                                                                                                                                                                                                                                                      | On Windows the native WebSocket client exchange is not observed (probe skipped)                                                             |
| SOAP         | Observed                              | `soap-service` returns an envelope for a call on both lanes                                                                                                                                                                                                                                                                                                                                                   | One template shape only                                                                                                                     |
| Static files | Observed                              | `static-files` serves its document root on both lanes                                                                                                                                                                                                                                                                                                                                                         | One template shape only                                                                                                                     |
| DB           | Observed (SQLite)                     | `database.test.ts` stores a value, restarts the service, and reads it back on both lanes                                                                                                                                                                                                                                                                                                                      | See the dialect table below                                                                                                                 |
| gRPC         | Unknown                               | libuvcpp 1.7.0 has no gRPC build switch; only header existence is checkable, and no lane exercises an RPC                                                                                                                                                                                                                                                                                                     | Not claimed                                                                                                                                 |

## Database dialects

libuvcpp loads its database drivers at run time, so all three dialects share the
same generated code. Only SQLite is exercised end to end.

| Dialect    | Status   | Evidence                                                                                                                                                                                                                                                                                        | Limit                             |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| SQLite     | Observed | `database.test.ts` writes a value, restarts the generated service, and reads it back on both lanes ([job 117345769136](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769136), [job 117345769140](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769140)) | A file-backed store, not a server |
| MySQL      | Unknown  | No server or client library is present in the lanes; only the refusal path for a missing driver is tested                                                                                                                                                                                       | Not claimed                       |
| PostgreSQL | Unknown  | Same as MySQL                                                                                                                                                                                                                                                                                   | Not claimed                       |

## Providers

| Provider     | Status        | Evidence                                                                                                                                                                                                                                  | Limit                                                            |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `local`      | Observed      | The Linux and Windows toolchain lanes drive it end to end                                                                                                                                                                                 | See the host and compiler limits above                           |
| `container`  | Unknown in CI | `containerConformance.test.ts` needs a container runtime and an image that is already present; without them seven obligations skip by name ([job 117345769140](https://github.com/Antruly/uvp/actions/runs/39015162211/job/117345769140)) | A host with `UVP_TEST_IMAGE` set can observe it; no CI lane does |
| `remote-ssh` | Unknown       | Not written                                                                                                                                                                                                                               | Not claimed                                                      |

## The Windows lane in detail

The run above used the runner image `windows-2025-vs2026` (build
`20261007.264.1`), Visual Studio 2026 `18.10.3`, and MSVC `14.51.36231`. Both
generator routes passed all six templates. The default route's job also reported,
by name:

- five `nativeProbe.test.ts` tests skipped because no native probe exists on that
  host — the Windows lane has no `npm run build:native-probe` step, and the
  archive has no `lib/libuvcpp.so` for the probe's build gate;
- three `nativeProbeGate.test.ts` tests skipped for the same reason;
- two `buildFailure.test.ts` tests skipped because MSVC `LNK2019`/`LNK2001`
  diagnostics are deliberately unmatched;
- seven `containerConformance.test.ts` obligations skipped because the
  conformance image is absent.

`windows-source` is the TypeScript half only. It establishes generation, parsing,
and the providers' decisions on Windows; it does not build C++.

## What this matrix does not say

- It does not say an unlisted platform, compiler, generator, or feature fails.
  `unknown` means unexamined.
- It is a snapshot. If a later run observes one of these rows, cite that run and
  update the row rather than widening the claim from the version number.
- It does not establish behaviour for macOS, Clang, Unix Makefiles, Visual Studio
  2019, HTTP/2, MySQL, PostgreSQL, gRPC, the container provider in CI, or
  `remote-ssh`.

## Reproducing an observation

```bash
# The six-template build, start, and answer lane, against an installed libuvcpp.
npm run test:toolchain

# HTTP/2, when the installed libuvcpp was built with nghttp2.
LIBUVCPP_ROOT=/path/to/libuvcpp npm run test:focused -- tests/acceptance

# The container provider, against an image that is already present.
npm run build:conformance-image
UVP_TEST_IMAGE=<image> npm run test:toolchain
```

See [Testing](testing.md#windows) for what each lane does and does not cover.
