# Installation and setup

uvp runs on your machine and drives the tools you already have. Installing it
does not install a compiler, CMake, or libuvcpp, and it never invokes `sudo`.

## Requirements

|               |                                                     |
| ------------- | --------------------------------------------------- |
| Node.js       | `^22.19.0`, `^24.11.0`, or `>=26.0.0`               |
| CMake         | 3.20 or newer, on `PATH`                            |
| C++ toolchain | A C++14 compiler: GCC, Clang, or MSVC               |
| libuvcpp      | **1.7.0 or newer**, installed where uvp can find it |

Node is the only hard requirement for the CLI and MCP server to _start_.
`uvp doctor` exists precisely because the other three are often incomplete, and
its whole job is to say which one is missing before you find out from a
compiler error.

## Try it without installing

```bash
npx uvp-agents --help
npx uvp-agents doctor
```

`npx` fetches the package into a cache and runs it. Nothing is added to your
`PATH` and nothing is written outside the npm cache.

> [!IMPORTANT]
> `uvp-agents` is not yet published to npm. Until it is, run from a clone:
> `git clone https://github.com/Antruly/uvp && cd uvp && npm ci && npm run build && node scripts/uvp.mjs doctor`.

## Install

```bash
npm install --global uvp-agents
uvp --version
```

Or keep it project-local:

```bash
npm install --save-dev uvp-agents
npx uvp doctor
```

## libuvcpp

uvp does not vendor libuvcpp, download it, or build it for you. It finds one you
have. There are two install shapes and a generated project handles both, but
`uvp doctor` reports which route answered and it is worth knowing the difference.

### Route 1 — build and install from source

The configuration the uvp test suite is verified against:

```bash
git clone --depth 1 --branch v1.7.0 https://github.com/Antruly/libuvcpp.git
cmake -S libuvcpp -B libuvcpp/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$HOME/.local" \
  -DUVCPP_BUILD_WEB=ON \
  -DUVCPP_BUILD_WEBAPP=ON \
  -DUVCPP_ENABLE_CAPI=ON \
  -DUVCPP_ENABLE_DB=ON
cmake --build libuvcpp/build
cmake --install libuvcpp/build
```

This writes a CMake package config to `$HOME/.local/lib/cmake/uvcpp/`, which is
what `find_package(uvcpp CONFIG)` needs. Point CMake at it:

```bash
export CMAKE_PREFIX_PATH="$HOME/.local:$CMAKE_PREFIX_PATH"
```

`UVCPP_BUILD_WEB=ON` and `UVCPP_BUILD_WEBAPP=ON` together are what provide the
WebSocket and web-app modules the `websocket-echo`, `soap-service`, and
`rest-api` templates need. There is no standalone WebSocket switch. See
[libuvcpp feature mapping](libuvcpp-features.md#websocket-needs-two-switches-not-one).

Two of the flags are for uvp rather than for the templates. `UVCPP_ENABLE_CAPI`
is the C ABI `uvcpp-probe` reaches libuvcpp through — without it the probe does
not build and `npm run test:toolchain` skips the half of itself that talks to
libuvcpp's own client stack. `UVCPP_ENABLE_DB` is **off by default** upstream;
without it the `db` feature reads as unavailable and a rest-api workspace that
declares it fails to compile rather than falling back to memory. Add OpenSSL,
QUIC and HTTP/3 as well if you want `http3-service`, which needs an OpenSSL at or
above 3.2 built with the QUIC API — [libuvcpp feature
mapping](libuvcpp-features.md#building-libuvcpp-for-uvp) has that recipe and what
each switch costs.

### Put the prefix on the loader path

A source install links libuv, libllhttp, libssl/libcrypto and libsqlite3
dynamically and gives `libuvcpp.so` no `RUNPATH` of its own:

```bash
export LD_LIBRARY_PATH="$HOME/.local/lib:$LD_LIBRARY_PATH"
```

Without it a generated service starts and dies with `libllhttp.so.9.2: cannot
open shared object file`, with that file in the very directory the service's own
`RUNPATH` points at — a binary's `RUNPATH` resolves its own direct dependencies
and is not consulted for theirs. `uvp doctor` reporting the install is not a
statement that a service built against it can start; this entry is what makes the
difference. The prebuilt release archives do not need it: their `libuvcpp.so` is
self-contained.

### Route 2 — unpack a prebuilt release archive

Release archives for 1.7.0 ship **only** `lib/pkgconfig/uvcpp.pc`. There is no
CMake config in them, so `find_package(uvcpp CONFIG)` fails. Point `pkg-config`
at them instead:

```bash
export PKG_CONFIG_PATH="/path/to/libuvcpp-1.7.0-linux-x64/lib/pkgconfig:$PKG_CONFIG_PATH"
pkg-config --modversion uvcpp     # should print 1.7.0
```

Generated projects try the CMake package first and fall back to `pkg-config`,
and enforce the version floor on both routes. A 1.6.0 install would satisfy
`pkg-config` and then fail to compile, which is why the floor is checked rather
than trusted.

### Confirm it worked

```bash
uvp doctor --json
```

The `libuvcpp` object reports the route, the prefix, the version and where the
version was read from, the modules the build actually sets to `1`, and the
features it therefore provides. If you asked for features, the report separates
the ones this build has from the ones it does not, naming the CMake switches that
would fix each gap.

`uvp doctor` reads the installed `uvcpp_config.h`, not the CMake cache. A build
directory whose cache says `UVCPP_ENABLE_OPENSSL=ON` while the installed header
says `0` is a real situation, and the header is what the compiler will see.

## Set up your agent

```bash
npx uvp-agents setup
```

This prints the configuration block for your client and, with `--write`, adds it
to the client's config file. The server runs over stdio; there is no port and no
daemon.

### Claude Code

```bash
claude mcp add uvp -- npx -y uvp-agents mcp
```

### Claude Desktop, Cursor, and other stdio clients

```json
{
  "mcpServers": {
    "uvp": {
      "command": "npx",
      "args": ["-y", "uvp-agents", "mcp"]
    }
  }
}
```

### Verify the connection

Ask the agent to run `uvp_doctor`. A working connection returns the toolchain
report; a broken one returns nothing at all, which is the useful failure — the
server either starts or it does not, and there is no half-connected state.

## First run

```bash
uvp doctor --json
uvp init ./svc --name svc --template rest-api --port 8080 --features websocket
uvp build ./svc
uvp run ./svc --port 8080
uvp verify ./svc --port 8080 --request GET /items/1 --assert status=200
```

`uvp verify` does the last three in one supervised pass and returns a bundle.
Either path leaves you with an ordinary CMake project — walk away from uvp and
`cmake -S . -B build && cmake --build build` still works.

## Troubleshooting

**`uvp: command not found` after a global install.** The npm global bin directory
is not on `PATH`. `npm config get prefix` prints it; `<prefix>/bin` is what needs
to be on `PATH`.

**`libuvcpp not found` at configure time.** Neither discovery route answered.
`CMAKE_PREFIX_PATH` for a CMake install, `PKG_CONFIG_PATH` for a release archive.

**A feature is reported `unmet`.** The build genuinely lacks it. The gap record
names the exact CMake switches, and they have to be applied to a libuvcpp
**source build** — a module is compiled into libuvcpp, so it cannot be retrofitted
into an installed library.

**A feature is reported `undetermined`.** Nothing is known to be wrong. It means
the check could not run; the `reason` field says which one.

**Node version rejected on install.** uvp requires `^22.19.0`, `^24.11.0`, or
`>=26.0.0`. `.nvmrc` pins `24` for work on uvp itself.

**A generated project fails to find libuvcpp on another machine.** Versions
differ. Pin the libuvcpp prefix with `-DCMAKE_PREFIX_PATH=` when configuring, and
re-run `uvp doctor` there.

## Next

- [CLI and evidence](cli.md) — the command surface and how to read its output
- [libuvcpp feature mapping](libuvcpp-features.md) — what each feature needs
- [MCP contracts](mcp-contracts.md) — what each tool does and touches
