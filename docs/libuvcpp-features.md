# libuvcpp feature mapping

uvp generates C++ and drives a libuvcpp build. This page documents exactly how a
requested feature maps to real CMake switches and real configuration macros, and
where the mapping is not one-to-one.

Everything here was established by building and running against libuvcpp
**1.7.0**, not by reading documentation. Where the two disagree, the build wins
and this page is a bug.

## The baseline

|               |                                                           |
| ------------- | --------------------------------------------------------- |
| Version       | 1.7.0                                                     |
| License       | MIT                                                       |
| Upstream      | [`Antruly/libuvcpp`](https://github.com/Antruly/libuvcpp) |
| C++ namespace | `uvcpp` (everything, without exception)                   |
| Naming        | `snake_case`                                              |
| Link target   | `uvcpp::uvcpp`                                            |

uvp does not vendor libuvcpp and does not download it. It finds one you already
have. See [Installation](installation.md#libuvcpp) for the two install routes.

## The two install routes

libuvcpp reaches a machine in one of two shapes, and they are **not**
interchangeable:

**Built and installed with CMake.** `cmake --install` writes a package config to
`lib/cmake/uvcpp/`. `find_package(uvcpp CONFIG REQUIRED)` works, and so does the
namespaced target `uvcpp::uvcpp` — the export set is installed with
`NAMESPACE uvcpp::`.

**Unpacked from a prebuilt release archive.** These ship `lib/pkgconfig/uvcpp.pc`
and **no CMake config at all**. There is no `lib/cmake/uvcpp/` in them.
`find_package(uvcpp CONFIG)` fails outright.

A generated `CMakeLists.txt` handles both: it tries the CMake package, falls back
to `pkg-config`, and enforces the version floor on whichever route it lands on.
The version floor is checked on **both** routes, because a 1.6.0 installation
would satisfy `pkg-config` and then fail to compile.

If you see "libuvcpp not found" on a machine where `pkg-config --modversion
uvcpp` prints a version, the project was configured against the wrong route.
Run `uvp doctor --json` and read the `libuvcpp.route` field.

## Features and their switches

`FEATURE_REQUIREMENTS` in `src/application/ToolchainProvider.ts` is the source of
truth. This table is generated from it.

| Feature     | CMake switches                            | Config macros                             | Header                    |
| ----------- | ----------------------------------------- | ----------------------------------------- | ------------------------- |
| `tls`       | `UVCPP_ENABLE_OPENSSL`                    | `UVCPP_OPENSSL_ENABLE`                    | `ssl/uvcpp_ssl_context.h` |
| `http2`     | `UVCPP_ENABLE_NGHTTP2`                    | `UVCPP_NGHTTP2_ENABLE`                    | `http2/uvcpp_h2_common.h` |
| `http3`     | `UVCPP_ENABLE_HTTP3`, `UVCPP_ENABLE_QUIC` | `UVCPP_HTTP3_ENABLE`, `UVCPP_QUIC_ENABLE` | `http3/uvcpp_h3_common.h` |
| `websocket` | `UVCPP_BUILD_WEB`, `UVCPP_BUILD_WEBAPP`   | `UVCPP_WEB_ENABLE`, `UVCPP_WEBAPP_ENABLE` | `web/uvcpp_ws_server.h`   |
| `soap`      | `UVCPP_BUILD_WEB`, `UVCPP_BUILD_WEBAPP`   | `UVCPP_WEB_ENABLE`, `UVCPP_WEBAPP_ENABLE` | `webapp/uvcpp_web_app.h`  |
| `db`        | `UVCPP_ENABLE_DB`                         | `UVCPP_DB_ENABLE`                         | `db`                      |
| `grpc`      | _(none)_                                  | _(none)_                                  | `grpc`                    |

### The macros are always defined

Every `UVCPP_*_ENABLE` symbol in `uvcpp_config.h` is **defined unconditionally**,
to `0` or `1`. It is never absent.

This makes `#ifdef` useless and actively misleading: `#ifdef UVCPP_OPENSSL_ENABLE`
is true in a build with TLS compiled out. The correct form is the value test:

```cpp
#if UVCPP_OPENSSL_ENABLE
  // TLS is compiled in
#endif
```

The `#if !UVCPP_OPENSSL_ENABLE` form that uvp generates into every template is
therefore correct, and the `-Wundef` warning that would catch the mistake does not
fire here — the macro is defined, so nothing complains. This is written down
because it cannot be caught by a compiler.

### WebSocket needs two switches, not one

There is **no standalone WebSocket switch** in libuvcpp. `UVCPP_BUILD_WEBAPP`
does not build on its own either. A build with `UVCPP_BUILD_WEB=ON` and
`UVCPP_BUILD_WEBAPP=OFF` configures cleanly, produces a library, and has no
WebSocket server in it.

This is why `websocket` and `soap` both list two switches and two macros. A tool
that recorded only `UVCPP_BUILD_WEBAPP` would call a WebSocket-less build
adequate and the failure would surface as a link error in generated code the
agent cannot fix.

### gRPC has no switch

There is no `UVCPP_ENABLE_GRPC` option and no `UVCPP_GRPC_ENABLE` symbol in
libuvcpp 1.7.0. Searching the CMake surface for either returns nothing.

gRPC headers install whenever they are present in the source tree. There is no
build-time decision to read, so `cmakeOptions` and `configSymbols` are both empty
and the only evidence available is header existence. See
[Undetermined is a real answer](#undetermined-is-a-real-answer) below.

Do not add `UVCPP_ENABLE_GRPC` to a build in an attempt to satisfy this. CMake
warns about the unused variable and the request is silently ignored.

### HTTP/3 and QUIC travel together

HTTP/3 is a dialect that runs over QUIC. `UVCPP_ENABLE_HTTP3` without
`UVCPP_ENABLE_QUIC` yields a build where the header is present and there is no
transport underneath it — the worst kind of failure, because everything compiles.

Both switches and both macros are required, and both are checked.

### SOAP does not need WSDL

`UVCPP_ENABLE_WSDL` generates and parses service descriptions. A SOAP call that
writes its envelope — which is what uvp's `soap-service` template and
`uvp_soap_call` do — does not need it. `soap` therefore requires the HTTP stack,
not the WSDL module.

If you are building from source and want WSDL generation as well, add
`-DUVCPP_ENABLE_WSDL=ON` yourself. uvp will not turn it on for you, because a
feature that is not requested should not appear in your build.

## How a feature is decided

`assessFeatures(wanted, modules, probe)` compares the features a caller asked for
against the macros a build actually defines, and sorts each one into three
buckets:

**`satisfied`** — the build has it. For a switched feature, every required macro
was present.

**`unmet`** — the build does not have it, and we know why. Each gap records how
the absence was established:

- `detection: "config_symbol"` — the config header defines the macro as `0`. The
  record names the absent symbols and the CMake switches that would have turned
  them on.
- `detection: "header"` — libuvcpp has no switch, and the header was looked for
  and not found. `absentSymbols` and `cmakeOptions` are both empty, because there
  is no switch to name.

**`undetermined`** — the feature could not be decided at all, with a `reason`
saying why.

### Undetermined is a real answer

For a feature libuvcpp has no switch for, the header probe is the only evidence
that exists. The probe returns three states, not two:

```ts
type HeaderProbe = (header: string) => Promise<boolean | undefined>;
```

`true` is present. `false` is absent. **`undefined` means the probe could not
look** — an unreadable install root, a provider with no filesystem access, a
probe that was never wired up.

Collapsing `undefined` into `false` would turn every unanswerable question into a
fabricated absence: "uvp could not check" would be reported as "you do not have
gRPC", and an agent acting on that would go rebuild a libuvcpp it did not need
to. So it becomes `undetermined`, and it stays distinct all the way through the
report.

The same rule appears throughout uvp. A check that cannot run yields
`undetermined`, never a yes and never a no.

## Reading a doctor report

```bash
uvp doctor --json | jq '.libuvcpp'
```

The useful fields and what each one actually tells you:

| Field                            | Meaning                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| `route`                          | `cmake_package`, `pkg_config`, or `absent` — which discovery route answered |
| `prefix`                         | The install root, so you can inspect it yourself                            |
| `version`                        | Read from the package config or the `.pc` file, not from the library        |
| `modules`                        | The `UVCPP_*` symbols this build defines as exactly `1`                     |
| `features.satisfied`             | Features you asked for that this build provides                             |
| `features.unmet[].cmakeOptions`  | The switches that would fix it, verbatim                                    |
| `features.undetermined[].reason` | Why a feature could not be decided                                          |

The list is not only `*_ENABLE`: 1.7.0's header also carries
`UVCPP_ENABLE_MEMORY_POOL` and `UVCPP_DB_RUNTIME_LOAD`, and uvp reports the
symbols rather than filtering for a suffix. It excludes two kinds of line for the
same reason — `UVCPP_HTTP_COMPRESS_ENABLE (1||1)` and `UVCPP_UDP_GSO_ENABLE 0` are
not the value `1`, so neither proves a module is compiled in.

`modules` is the list as read from the build's generated `uvcpp_config.h`. It is
observed, not inferred from the CMake cache — a build directory whose cache says
`UVCPP_ENABLE_OPENSSL=ON` while the installed header says `0` is a real situation,
and the header is what the compiler will actually see.

## Building libuvcpp for uvp

The configuration the uvp toolchain CI lane uses, and the one all five templates
were verified against:

```bash
git clone --depth 1 --branch v1.7.0 https://github.com/Antruly/libuvcpp.git
cmake -S libuvcpp -B libuvcpp/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/path/to/prefix \
  -DUVCPP_BUILD_WEB=ON \
  -DUVCPP_BUILD_WEBAPP=ON \
  -DUVCPP_ENABLE_CAPI=ON
cmake --build libuvcpp/build
cmake --install libuvcpp/build
```

`UVCPP_ENABLE_CAPI=ON` is not needed for generated projects. It is on in CI
because `uvcpp-probe` — the program that answers the WebSocket probe's
`libuvcpp` stack — reaches libuvcpp through its C ABI rather than through C++
name mangling. It is built separately from uvp (`npm run build:native-probe`)
and is not needed to use any other tool.

To confirm what you built, ask the config header directly:

```bash
grep -E '^#define UVCPP_[A-Z0-9_]+_ENABLE' /path/to/prefix/include/uvcpp/uvcpp_config.h
```

Every one of those lines is defined, and every one is `0` or `1`. That output is
the same evidence the CI lane prints, and the same evidence `uvp doctor` reads.

## When something is missing

The failure modes you are most likely to hit, in the order they occur:

**`libuvcpp not found` at configure time.** Neither route answered. Check that
`CMAKE_PREFIX_PATH` contains the install prefix for the CMake route, or that
`PKG_CONFIG_PATH` contains `<prefix>/lib/pkgconfig` for the release-archive
route.

**Version too old.** The floor is enforced on both routes. `uvp doctor` prints
the version it found and where it read it from.

**A feature you asked for is `unmet`.** The gap record names the exact CMake
switches. Rebuild libuvcpp with them — they are not switches that can be applied
to the consuming project, because the module is compiled into libuvcpp itself.

**A feature is `undetermined`.** Nothing is wrong with your build as far as uvp
can tell. It means the check could not run. The `reason` field says which check.
