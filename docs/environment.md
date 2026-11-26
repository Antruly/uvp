# Install the C++ toolchain

uvp is installed with npm, but a generated service needs libuvcpp and CMake.
`uvp env` installs both into a directory uvp owns, verifies every download
against a SHA-256 pinned in uvp, and selects the result for `uvp build` and
`uvp doctor`.

The only thing uvp does not install is the C++ compiler itself. On Linux a
`g++` or `clang++` from the distribution is enough. On Windows, install Visual
Studio's C++ workload for `--variant msvc-x64`, or a MinGW-w64 toolchain for the
default `mingw-x64` archive. uvp reports a missing compiler rather than
pretending the environment is complete.

## One command, defaults all the way

```bash
npm install -g uvp-agents
uvp env
```

`uvp env` with no action is the guided setup:

```text
uvp environment setup for linux-x64
Press Enter to accept the default, or type another value.
libuvcpp version [1.11.0]:
libuvcpp variant [linux-x64]:
CMake version [3.31.6]:
CMake variant [linux-x64]:
Install to /home/you/.uvp/toolchains and select both [Y/n]:
```

Pressing Enter at every question installs the newest supported libuvcpp and
CMake, selects both, and prints the next command. `--yes` runs the same defaults
without a terminal prompt; `--json` prints a machine-readable report and never
prompts.

## What is installed

```text
~/.uvp/toolchains/libuvcpp/<version>/<variant>/
~/.uvp/toolchains/cmake/<version>/<variant>/
~/.uvp/toolchains.json
```

The config is a selection, not an installation copy:

```json
{
  "schema": "uvp.toolchains/1",
  "mirrors": {},
  "selected": {
    "libuvcpp": { "version": "1.11.0", "variant": "linux-x64" },
    "cmake": { "version": "3.31.6", "variant": "linux-x64" }
  }
}
```

`uvp build` uses the selected CMake executable and passes the selected libuvcpp
prefix to CMake through the same binding `uvp doctor` reports. An explicit
`UVCPP_ROOT` still wins over the selection; the selection wins over conventional
discovery. uvp never edits a shell profile and never writes into `/usr` or
`Program Files`.

## Commands

```bash
uvp env                     # guided setup, Enter accepts every default
uvp env setup --yes         # defaults without prompting
uvp env status              # selection, host, and installed versions
uvp env list                # catalogued versions and variants, with * for installed
uvp env install libuvcpp@1.11.0 --variant linux-x64
uvp env install cmake@3.31.6
uvp env use libuvcpp@1.9.1:linux-x64
uvp env remove libuvcpp@1.9.1
uvp env mirror libuvcpp https://mirror.example/uvcpp/
```

A target is `tool[@version][:variant]`. Without a version the newest catalogued
release is used; without a variant the host default is used. Installing selects
by default; pass `--force` to replace an existing directory.

### Supported libuvcpp releases

`1.11.0`, `1.10.0`, `1.9.1`, and `1.7.0`, for `linux-x64`, `linux-arm64`,
`mingw-x64`, `mingw-arm64`, `msvc-x64`, and `msvc-arm64`.

### Supported CMake releases

`3.31.6` and `4.0.3`, for `linux-x64`, `linux-arm64`, `windows-x64`,
`windows-arm64`, and `macos-universal`.

### Variants are not host names

On Windows the default libuvcpp variant is `mingw-x64`, as requested for the
fast path. `--variant msvc-x64` selects the Visual Studio archive instead. On a
Linux host you can keep `mingw-x64` beside `linux-x64` and switch with
`uvp env use`; the archives do not overwrite each other.

macOS has no libuvcpp archive in this catalog. CMake is installable there, but a
libuvcpp build must be provided another way.

## Mirrors

The default libuvcpp base is the GitHub release:

```text
https://github.com/Antruly/libuvcpp/releases/download/v{version}/{asset}
```

The default CMake base is the Kitware GitHub release:
`https://github.com/Kitware/CMake/releases/download/v{version}/{asset}`.
A mirror can point at `https://cmake.org/files/v{major}.{minor}/{asset}` or an
internal copy; the pinned SHA-256 decides whether the bytes are the right ones.

A mirror is a base URL or a template. `{version}`, `{variant}`, `{asset}`, and
`{tool}` are replaced; a URL without `{asset}` gets the asset name appended.

```bash
uvp env mirror libuvcpp https://mirror.example/uvcpp/
uvp env mirror cmake https://mirror.example/cmake/{version}/
uvp env install libuvcpp@1.11.0 --mirror https://mirror.example/uvcpp/
```

`--mirror` also saves the value, so later installs use it. `UVP_LIBUVCPP_MIRROR`
and `UVP_CMAKE_MIRROR` can override it per process. A mirror changes where bytes
come from; it cannot change the SHA-256 they must match.

## Verification and failure

Every archive is checked for its exact byte count when the catalog records one,
then for its SHA-256, before extraction. It is extracted into a temporary
directory, checked for symlinks and the layout the tool must have, and only then
moved to its final path. A digest mismatch, a truncated download, a missing
`uvcpp.pc`, or a missing `cmake` executable fails with the release name and the
reason; nothing is selected.

Downloads are bounded and retried on 5xx/429, but a 404 is reported immediately.
On a host that reaches the network only through a proxy, start Node with
`NODE_USE_ENV_PROXY=1` or set the mirror to an internal one.

## Non-goals

- `uvp env` does not install a C++ compiler, Visual Studio, or system packages.
- It does not replace a system libuvcpp or CMake; it adds a managed copy.
- It does not change the generated project's libuvcpp floor (1.7.0). Selecting
  1.11.0 changes the build used here, not what a generated `CMakeLists.txt`
  requires.
