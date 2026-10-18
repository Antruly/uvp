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

| Feature     | CMake switches                                               | Config macros                                                 | Header                    |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------- |
| `tls`       | `UVCPP_ENABLE_OPENSSL`                                       | `UVCPP_OPENSSL_ENABLE`                                        | `ssl/uvcpp_ssl_context.h` |
| `http2`     | `UVCPP_ENABLE_NGHTTP2`                                       | `UVCPP_NGHTTP2_ENABLE`                                        | `http2/uvcpp_h2_common.h` |
| `http3`     | `UVCPP_ENABLE_HTTP3`, `UVCPP_ENABLE_QUIC`, `UVCPP_BUILD_WEB` | `UVCPP_HTTP3_ENABLE`, `UVCPP_QUIC_ENABLE`, `UVCPP_WEB_ENABLE` | `http3/uvcpp_h3_common.h` |
| `websocket` | `UVCPP_BUILD_WEB`, `UVCPP_BUILD_WEBAPP`                      | `UVCPP_WEB_ENABLE`, `UVCPP_WEBAPP_ENABLE`                     | `web/uvcpp_ws_server.h`   |
| `soap`      | `UVCPP_BUILD_WEB`, `UVCPP_BUILD_WEBAPP`                      | `UVCPP_WEB_ENABLE`, `UVCPP_WEBAPP_ENABLE`                     | `webapp/uvcpp_web_app.h`  |
| `db`        | `UVCPP_ENABLE_DB`                                            | `UVCPP_DB_ENABLE`                                             | `db`                      |
| `grpc`      | _(none)_                                                     | _(none)_                                                      | `grpc`                    |

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

### HTTP/3, QUIC, and the web layer travel together

HTTP/3 is a dialect that runs over QUIC. `UVCPP_ENABLE_HTTP3` without
`UVCPP_ENABLE_QUIC` yields a build where the header is present and there is no
transport underneath it — the worst kind of failure, because everything compiles.

Three switches and three macros are required, and all three are checked.

The third is the one a reader would not expect. `UVCPP_ENABLE_HTTP3` and
`UVCPP_ENABLE_QUIC` turn on a QUIC stack with an h3 client, and the h3 _client_
headers (`http3/uvcpp_h3_common.h`, `capi/uvcpp_c_http3.h`,
`quic/uvcpp_quic_client.h`) install on a build with the web layer compiled out.
The only type in 1.7.0 that can open an h3 **listener**, though, is
`uvcpp_http_server`, and it lives behind `#if UVCPP_WEB_ENABLE`. A check that
stopped at HTTP3 and QUIC would call a build adequate and then fail to compile the
one line that listens.

#### Which template speaks HTTP/3

`uvcpp_web_app` — the type every other template starts — has **no** HTTP/3
listener. It documents `set_http2_enabled` and `set_h2c_enabled`, and notes that
HTTP/3 will be handled the same way _when there is h3_. So the two cases are
different, and both are stated rather than implied by the manifest:

- **`http3-service`** is written against `uvcpp_http_server`, which serves one
  route table over a TCP leg and a QUIC leg at once. It registers the QUIC
  context before `listen_quic`, installs the same certificate on both legs, and
  reads the UDP port back from `quic_listen_port()`. It also has no cleartext
  mode to fall back to, so every misconfiguration returns before a listener is
  opened.
- **Every other template**, asked for `--features http3`, asks the build for the
  module and emits its guard, and writes no HTTP/3 code.

Because the h3 leg is TLS-only, `http3-service` is also the one template that
turns on `set_http2_enabled` for its TCP leg rather than h2c: ALPN is how a TLS
client and this server agree on h2, and its only TCP listener has a TLS context
installed, so no cleartext connection could ever reach h2c's preface check.

#### Reading a request back

`uvp http --http-version 3` is answered by `uvcpp-probe`'s QUIC client — Node has
no HTTP/3 client — and the C ABI behind it reports a handshake and a response and
nothing underneath either. Two consequences a reader of a result has to know:
response headers are read **one name at a time** (`uvcpp_c_h3_response_header`,
which has no header-list counterpart), so `headers` in a result is the set that was
read rather than the set the peer sent, and the exchange says so beside it; and
there is no timing below the poll interval, because the h3 connection has no ready
callback.
It also verifies only against a CA bundle it is handed — there is no
system-trust-store path in that layer — which is why the request is refused
outright when `verify_tls` is on rather than answered with `verified`.

### HTTP/2 in the web-app layer

Two switches, two protocols, and neither defaults where you would guess:

| Call                | Default | What it does                                                     |
| ------------------- | ------- | ---------------------------------------------------------------- |
| `set_http2_enabled` | **on**  | Over TLS it puts `h2` in the ALPN list and falls back to h1.1    |
| `set_h2c_enabled`   | **off** | Cleartext HTTP/2 by prior knowledge; needs `http2_enabled()` too |

Both are only read at `start()`, so a call placed after the server is listening
compiles, runs, and changes nothing. Without nghttp2 compiled in,
`set_http2_enabled` records the intent as a no-op and `http2_enabled()` honestly
returns false — which is why a workspace that declares `http2` and is built
against such a library fails visibly rather than serving HTTP/1.1 quietly.

h1 and h2c share one port. They are told apart byte-exactly by the 24-byte
connection preface RFC 9113 defines, not by sniffing and not by `Upgrade: h2c` —
that mechanism was deleted in RFC 9113, so the request that used to be the
textbook h2c handshake is now the thing a service should not be sent. uvp's own
client speaks prior knowledge for `--http-version 2`, which is what makes
`uvp verify` able to establish that one port serves both rather than assuming it.

### TLS in the web-app layer

`enable_ssl(cert_file, key_file)` reads and validates the pair **where it is
called**, logs the reason under `log_category::SSL`, and marks the app
TLS-unavailable so `start()` then returns `UV_EINVAL`. The header is explicit
about why it refuses rather than degrading: serving cleartext instead is the worst
failure mode here, because nothing on the caller's side can tell. `ssl_error()`
reports what went wrong and is empty when nothing did, which is what a generated
service checks to print a reason instead of an `UV_EINVAL`.

| Call                           | Default | What it does                                                  |
| ------------------------------ | ------- | ------------------------------------------------------------- |
| `enable_ssl`                   | —       | Reads and validates at the call site; refuses on failure      |
| `enable_ssl_pem`               | —       | The same, from PEM text rather than from paths                |
| `enable_self_signed`           | —       | Generates one for tests and controlled intranets, not for use |
| `set_tls_handshake_timeout_ms` | `10000` | Bounds a handshake that never finishes                        |

The handshake timeout is the one worth knowing about without being told. The
framework hands a connection to the application only once the handshake is done,
and the idle scan walks the connections it was handed — so a peer that opens a
socket and dribbles bytes without ever completing the handshake is not covered by
`idle_timeout_ms` at all. The default applies whether or not it is set, so the
value is not the point; uvp's generated templates set it explicitly anyway, so a
reader of the generated source does not have to open the header to learn that the
bound exists. It must be called before `start()`, like the HTTP/2 switches.

`enable_self_signed` is documented for tests and controlled intranets, which is
what makes it the right _fallback_ for a freshly generated workspace and the wrong
default for a deployment: it is a certificate no client should accept without
being told to, and uvp's own client refuses it rather than trusting it.

### SOAP does not need WSDL

`UVCPP_ENABLE_WSDL` generates and parses service descriptions. A SOAP call that
writes its envelope — which is what uvp's `soap-service` template and
`uvp_soap_call` do — does not need it. `soap` therefore requires the HTTP stack,
not the WSDL module.

If you are building from source and want WSDL generation as well, add
`-DUVCPP_ENABLE_WSDL=ON` yourself. uvp will not turn it on for you, because a
feature that is not requested should not appear in your build.

### The db module backs exactly one template

`UVCPP_ENABLE_DB` compiles libuvcpp's database layer, and `uvcpp_db_pool` is what
a generated service opens. Of the seven templates, one has a store for it to back:
`rest-api`. `uvp init --template rest-api --features db` replaces that template's
in-memory map with the pool, and its routes, status codes and JSON stay as they
are. Declaring `db` on any other web template records the build requirement and
writes the same `#error` guard as any other feature, and nothing else — a
template with no store has nothing for a database to hold. That is stated here
rather than left to be found by diffing two generated projects.

One connection string reaches all three dialects:

| Dialect    | Connection string                   |
| ---------- | ----------------------------------- |
| SQLite     | `sqlite:///path/to/file.db`         |
| MySQL      | `mysql://user:pass@host:3306/db`    |
| PostgreSQL | `postgres://user:pass@host:5432/db` |

The driver is loaded at run time, which is why a generated project links `uvcpp`
and nothing else: with the drivers as `dlopen`ed modules, `libuvcpp.so` carries
no `NEEDED` entry for `libsqlite3`, `libmysqlclient` or `libpq`. It is also why
the client library has to be on the host rather than in the build, and why its
absence is `no_driver` at pool-init — naming the packages to install — instead
of a link error. SQLite is the one dialect that needs nothing else present,
because it is a library and not a server; uvp's lanes can only reach that one
end to end, and the generated README says so rather than implying the other two
were exercised.

Four properties of the layer shape what generated code can promise, and none of
them can be smoothed over from above:

- **Placeholders are dialect-native and are not translated.** `?` for SQLite and
  MySQL, `$1`…`$n` for PostgreSQL, passed to the driver as written. A generated
  statement carries whichever the connection string implies, and the README says
  which.
- **A statement is passed as written, trailing semicolon included**, which the
  dialects do not agree on accepting. The generated statements carry none.
- **A failed `execute` carries one status code.** `uvcpp_db_status` cannot tell a
  taken key from a dropped connection, which is why `rest-api --features db`
  creates with `POST` and reports a failed create, rather than offering the
  upsert that `PUT` would claim.
- **The asynchronous calls run on libuv's worker pool** — the same default four
  threads that serve `uv_fs_*` and DNS — so a statement that never returns holds
  a thread other work is queued behind. `UV_THREADPOOL_SIZE`, or
  `uvcpp_set_threadpool_size(n)` _before the first dispatch_, is the caller's
  lever; generated services set a 5 s statement timeout on each connection
  instead of resizing a pool that also governs file IO.

`acquire()` blocks and is for a thread that is not the loop's, which in a
generated service is no thread at all: a transaction needs acquire/release and
therefore belongs outside a request handler, and no template writes one.

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

The line uvp's own CI lane uses, and the one every generated template is built
against:

```bash
git clone --depth 1 --branch v1.7.0 https://github.com/Antruly/libuvcpp.git
cmake -S libuvcpp -B libuvcpp/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/path/to/prefix \
  -DUVCPP_BUILD_WEB=ON \
  -DUVCPP_BUILD_WEBAPP=ON \
  -DUVCPP_ENABLE_CAPI=ON \
  -DUVCPP_ENABLE_DB=ON \
  -DUVCPP_ENABLE_OPENSSL=ON \
  -DUVCPP_ENABLE_QUIC=ON \
  -DUVCPP_ENABLE_HTTP3=ON \
  -DOPENSSL_ROOT_DIR=/path/to/openssl-3.5-prefix
cmake --build libuvcpp/build --parallel
cmake --install libuvcpp/build
```

That is a floor for the templates, not a general-purpose build. The switches are
here because a template needs them:

- `UVCPP_BUILD_WEB` and `UVCPP_BUILD_WEBAPP` are what every template links
  against, and there is no separate switch for WebSocket — the server lives in the
  web layer and is routed in the web-app layer.
- `UVCPP_ENABLE_CAPI` is not needed by a generated project. It is on because
  `uvcpp-probe` — the program that answers the WebSocket probe's `libuvcpp` stack
  and the HTTP/3 probe's client — reaches libuvcpp through its C ABI rather than
  through C++ name mangling. It is built by `npm run build:native-probe`,
  separately from uvp, and is not needed to use any other tool. The probe's HTTP/3
  exchange needs the h3 C ABI as well, and its build compiles that one translation
  unit only when the install it is pointed at has it: without HTTP/3 the probe is
  still built, complete for WebSocket, and its `--version` says which exchange is
  missing and why.
- `UVCPP_ENABLE_DB` is off by default in libuvcpp. It is what gives `rest-api`
  its store when the workspace declares `db`, and a workspace that declares the
  feature against a build without the module fails to compile rather than
  falling back, because the generated code includes the module's header. The
  SQLite backend needs libsqlite3 at build time as well.
- `UVCPP_ENABLE_OPENSSL`, `UVCPP_ENABLE_QUIC` and `UVCPP_ENABLE_HTTP3` are the
  three behind `http3-service`: the serving half of HTTP/3 is
  `uvcpp_http_server`, which lives in the web layer, and h3 has no transport
  other than QUIC. QUIC is TLS 1.3 only, so it needs an OpenSSL **at or above
  3.2 with the QUIC API** — Ubuntu 24.04's 3.0.13 is not one, and libuvcpp's
  configure step says so and forces QUIC off rather than producing a library
  that cannot link against ngtcp2. That is why the CI lane builds OpenSSL 3.5.0
  from source into a prefix of its own and points `OPENSSL_ROOT_DIR` at it, which
  is what libuvcpp's own `quic` and `http3` CI legs do.

Which modules a build ended up with is the config header's answer and not the
command line's: a precheck that forces a switch off leaves the `-D` in
`CMakeCache.txt`.

```bash
grep -E '^#[[:space:]]*define[[:space:]]+UVCPP_[A-Z0-9_]+_ENABLE' \
  /path/to/prefix/include/uvcpp/uvcpp_config.h
```

The pattern matches the indented `#  define` lines this header is written with. An
anchored `^#define` matches none of them and prints nothing, which reads exactly
like a build with no modules enabled. Every macro that comes back is `0` or `1`,
with one exception the header explains in a comment: `UVCPP_HTTP_COMPRESS_ENABLE`
is the `||` of the two encoder switches, because compression is on when either
encoder is. That output is the same evidence the CI lane prints, and the same
evidence `uvp doctor` reads.

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
