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

> [!NOTE]
> `uvp-agents` was first published on 2026-10-17; the version the commands above
> install is `0.2.0`. To run the latest unreleased `main` instead, use a clone:
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

A local install does not make `uvp` a shell command. npm links the package's
executable into `./node_modules/.bin` and leaves `PATH` alone, on every platform,
so `npx uvp doctor` — the line above, and the same in PowerShell, cmd, and a Unix
shell — is how that project runs it. npm's Windows layout also puts a shim at
`.\node_modules\.bin\uvp.cmd` for a direct call.

### From GitHub Packages (mirror)

A separate dispatch publishes the same release to GitHub Packages as
`@antruly/uvp-agents`. GitHub Packages requires an authenticated token to
install, even when the package is public, so this route is for environments that
already consume from it. npmjs remains the install above that needs no token.

```ini
# ~/.npmrc
@antruly:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
export NODE_AUTH_TOKEN=<classic PAT with read:packages>
npm install --global @antruly/uvp-agents
uvp --version
```

The mirror is a distribution of the canonical package: `uvp --version` reports
`uvp-agents <version>`, and `uvp mcp setup` recommends the npmjs install. See
[publishing the GitHub Packages mirror](releasing.md#github-packages-mirror) for
what the publish does and does not establish.

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
each switch costs. Those three also decide whether the probe can run its HTTP/3
exchange: without them it is still built, complete for WebSocket, and `--version`
reports the missing exchange with the reason.

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

#### Windows (MSVC)

The `msvc-x64` release archive is the same route with Windows paths and a real
`pkg-config` executable. Download and unpack it from PowerShell:

```powershell
Invoke-WebRequest -Uri 'https://github.com/Antruly/libuvcpp/releases/download/v1.7.0/libuvcpp-1.7.0-msvc-x64.zip' -OutFile libuvcpp.zip
Expand-Archive -Path libuvcpp.zip -DestinationPath "$HOME\libuvcpp"
$prefix = "$HOME\libuvcpp\libuvcpp-1.7.0-msvc-x64"

# Discovery and the generated project's pkg-config fallback.
$env:UVCPP_ROOT = $prefix
$env:PKG_CONFIG_PATH = "$prefix\lib\pkgconfig"

# uvcpp.dll and the OpenSSL DLLs load from here at run time.
$env:Path = "$prefix\bin;$env:Path"
```

The archive ships `lib/pkgconfig/uvcpp.pc` and no CMake config, so the generated
project's pkg-config fallback is the route that runs. That fallback needs a real
executable: CMake's `FindPkgConfig` looks for `pkg-config.exe` or `pkgconf.exe`
and does not accept a `.bat` wrapper. Check it in the same shell, after the
settings above:

```powershell
(Get-Command pkg-config -ErrorAction SilentlyContinue).Source   # must end in .exe
pkg-config --modversion uvcpp                                   # should print 1.7.0
```

If `pkg-config --version` answers but `uvp build` fails during configure with
CMake's `Could NOT find PkgConfig (missing: PKG_CONFIG_EXECUTABLE)`, the
`pkg-config` on
`PATH` is a script — the Windows runner has Strawberry Perl's
`pkg-config.bat`, which is exactly that case. Install an executable one, for
example with `choco install pkgconfiglite`. The installer adds its shim to the
machine `PATH`, which a shell opened before the install does not see. Open a new
shell and re-apply the three session settings from above — they were `$env:`
values and do not survive the reopen — then verify:

```powershell
$prefix = "$HOME\libuvcpp\libuvcpp-1.7.0-msvc-x64"
$env:UVCPP_ROOT = $prefix
$env:PKG_CONFIG_PATH = "$prefix\lib\pkgconfig"
$env:Path = "$prefix\bin;$env:Path"
(Get-Command pkg-config).Source   # must end in .exe
pkg-config --modversion uvcpp     # should print 1.7.0
```

Build generated workspaces in Release against this archive. It is a Release
build with the release CRT; a Debug build against it mixes the two CRTs on
Windows. Name Ninja explicitly — it is one of the two routes the Windows lane
verifies (the other is the default Visual Studio generator):

```powershell
uvp init .\svc --name svc --template hello-http --port 8090
uvp build .\svc --generator ninja --build-type Release
uvp run .\svc --port 8090
```

`uvp doctor --json` should report the prefix, the version, and the modules the
archive's `uvcpp_config.h` defines.

### Route 3 — install a distribution package (RPM, deb)

The 1.7.4 release page also publishes RPM and deb packages, split the way
distribution packages usually are. **uvp needs the development package.** The
runtime package carries the shared library and nothing to compile against:

| Package                             | Carries                                                          | Enough for uvp |
| ----------------------------------- | ---------------------------------------------------------------- | -------------- |
| `libuvcpp1-1.7.4-1.x86_64.rpm`      | `libuvcpp.so.1` and `libuvcpp.so.1.7.4`                          | no             |
| `libuvcpp-devel-1.7.4-1.x86_64.rpm` | `uvcpp_config.h`, `uvcppConfig.cmake`, `uvcpp.pc`, `libuvcpp.so` | yes            |
| `libuvcpp1_1.7.4-1_amd64.deb`       | the same two shared-library files                                | no             |
| `libuvcpp-dev_1.7.4-1_amd64.deb`    | the development files, under `/usr/lib`                          | yes            |

`uvp doctor` reads `uvcpp_config.h` for the module list, and a generated project
needs the CMake package or the `.pc` file. Installing only the runtime package
is a natural mistake because its name looks like the library's; `uvp doctor`
reports `found: false` in that state and names the shared library it found,
along with the development package to install.

Install the development package with your distribution's package manager:

```bash
sudo dnf install ./libuvcpp-devel-1.7.4-1.x86_64.rpm
sudo apt install ./libuvcpp-dev_1.7.4-1_amd64.deb
```

The files land under `/usr`, which is one of the roots uvp searches by default,
so no `UVCPP_ROOT` or `CMAKE_PREFIX_PATH` is needed. `uvp doctor --json` reports
the prefix, the version, and the modules the installed `uvcpp_config.h` defines.

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

The configured command is `npx -y uvp-agents@<version> mcp`, pinned to the
version you ran. The tool set is part of the interface, so an unpinned `npx`
would silently upgrade the server under a configuration you wrote months
earlier; run `uvp setup --write` again after upgrading uvp to move the pin.

`--write` merges. Every other server in the file is kept, every other top-level
key is kept, and only uvp's own entry is replaced. A file that exists and does
not parse is refused — the command exits 2 and leaves the bytes exactly as they
were — because that is more often someone's half-finished edit than a file to
clean up. It writes no backup copy of the file; what it protects is the content
it does not own, by keeping it in place.

`--client` chooses `claude-code` (the default), `claude-desktop`, or `cursor`;
`--path` writes somewhere other than `./.mcp.json` in the working directory.

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

**`uvp: command not found` after `npm install uvp-agents`.** Without `--global`
the install is local: npm links the executable into `./node_modules/.bin` and does
not add that directory to `PATH`. On Windows the shell reports this as `'uvp' is
not recognized as an internal or external command` (or the localized equivalent).
From that project, run `npx uvp doctor`, or call the linked executable directly —
`.\node_modules\.bin\uvp.cmd doctor` on Windows, `./node_modules/.bin/uvp doctor`
on Unix-like hosts. A global install is what puts `uvp` on `PATH`.

**`uvp: command not found` after a global install.** The npm global executable
directory is not on `PATH`. `npm config get prefix` prints the prefix; what has to
be on `PATH` is `<prefix>/bin` on Unix-like hosts, and the prefix directory itself
on Windows — commonly `%APPDATA%\npm`.

**`libuvcpp not found` at configure time.** Neither discovery route answered.
`CMAKE_PREFIX_PATH` for a CMake install, `PKG_CONFIG_PATH` for a release archive.

**`uvp doctor` names a shared library and still reports `found: false`.** The
runtime package is installed without the development one — `libuvcpp1` rather
than `libuvcpp-devel` on RPM distributions, `libuvcpp1` rather than
`libuvcpp-dev` on Debian and Ubuntu. Install the development package; Route 3
above has the contents of each.

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
- [First-release support matrix](support-matrix.md) — what the lanes have
  observed, derived, and left unknown
- [Release notes](release-notes.md) — what shipped and what remains unknown
- [MCP contracts](mcp-contracts.md) — what each tool does and touches
