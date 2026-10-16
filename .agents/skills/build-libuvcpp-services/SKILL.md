---
name: build-libuvcpp-services
description: Build, run, and verify C++ web services on libuvcpp with uvp. Use when asked to create a C++ HTTP, REST, WebSocket, or SOAP service, to compile or run one against a local libuvcpp install, to debug a libuvcpp build failure, or to prove a running service behaves as specified.
---

# Building libuvcpp services with uvp

uvp turns a description of a C++ web service into a CMake project, builds it
against the libuvcpp you have installed, runs it under supervision, drives real
requests at it, and returns evidence. This skill is about using it well — the
mistakes below are the ones that waste a session.

## Start with `uvp_doctor`, always

Before generating or building anything, call `uvp_doctor`. It reports what is
actually on the machine: the compiler, CMake, the libuvcpp build, which of its
modules are compiled in, and which of your requested features that build
provides.

Why first: two libuvcpp 1.7.0 installations can differ in whether HTTP/3 or TLS
was compiled in. The version number does not tell you, and neither does CMake
having configured successfully. Starting a build without this is how you end up
debugging a link error that was decided when libuvcpp was built.

The report separates three outcomes, and the difference matters:

- **satisfied** — the build has the feature.
- **unmet** — it does not, and the report names the CMake switches that would
  have enabled it. Those switches apply to a libuvcpp _source build_, not to the
  project you are generating. You cannot turn on a module that was compiled out.
- **undetermined** — uvp could not check. This is not a "no". Do not rebuild
  libuvcpp because of it; read the `reason` field.

## The two facts that cause the most wasted work

**WebSocket needs both `UVCPP_BUILD_WEB=ON` and `UVCPP_BUILD_WEBAPP=ON`.** There
is no standalone WebSocket switch. A build with only the second configures
cleanly and links, then fails in your code.

**libuvcpp's feature macros are always defined, to `0` or `1`.** `#ifdef
UVCPP_OPENSSL_ENABLE` is true even when TLS was compiled out. Every guard must be
a value test: `#if UVCPP_OPENSSL_ENABLE`. The templates uvp generates already do
this; hand-written code often does not.

There is also no `UVCPP_ENABLE_GRPC` option in libuvcpp 1.7.0. Passing it is
silently ignored.

## The loop

1. `uvp_doctor` — what is available.
2. `uvp_workspace_create` — generate. Pick the template closest to what you
   need; editing generated code is cheaper than writing from scratch.
3. `uvp_build` — configure and compile.
4. `uvp_run` — start it. It returns only once the readiness probe answers.
5. `uvp_http_request` / `uvp_websocket_probe` / `uvp_soap_call` — exercise it.
6. `uvp_run_stop` — stop it, or let the session end.

Or do 3 through 6 as one supervised pass with `uvp_verify`, which is what you
want when you have a goal and assertions rather than an exploration.

## A failing build is not an error

`uvp_build` returning non-zero is the tool working. The result carries
`diagnostics`, each tagged with the phase that produced it:

- `configure` — libuvcpp was not found, or the version floor was not met. Go
  back to `uvp_doctor`. Editing code will not help.
- `compile` — a real source problem. The diagnostic has the file, line, and
  message.
- `link` — a module is missing from the libuvcpp build. Check the feature
  assessment; this is the signature of requesting WebSocket from a build without
  `UVCPP_BUILD_WEBAPP`.

Read `phase` before reading the message. The three failures look similar in a
terminal and have completely different fixes.

## Assert, do not assume

`uvp_run` reporting that the service started is not evidence that it works.
`uvp_verify` with explicit assertions is.

```json
{
  "workspace": "./svc",
  "port": 8080,
  "requests": [{ "method": "GET", "path": "/items/1" }],
  "assertions": [
    { "kind": "status_equals", "expected": 200 },
    { "kind": "body_json_path_equals", "target": "$.value", "expected": "first" }
  ]
}
```

The bundle's status is `verified` only when every assertion actually ran and
passed. `partial` means something was not evaluated — a process that exited
early, a request that never came back. Do not report `partial` as success, and do
not retry on `unknown`: it means uvp could not check, not that the service is
broken.

Read `unknowns` and `limitations` on every result before concluding anything.
`limitations` is where truncation and timeouts are declared; a `verified` status
with a truncated body in `limitations` is a statement about a prefix.

## Building inside a container image

A workspace can pin the toolchain it is built with, in its `uvp.json`:

```json
{ "toolchain": { "kind": "container", "image": "localhost/uvp-base:12" } }
```

`uvp_build` then runs inside that image, which **starts a container on the
machine**. Two consequences you have to plan around, both reported in the
result's `limitations`:

- The artifact is linked against the image's libuvcpp at an in-image path
  (`RUNPATH=/opt/libuvcpp/lib`). `uvp_run` on this host fails with
  `error while loading shared libraries: libuvcpp.so` — that is the limitation,
  not a broken build. Run it inside the image.
- Only the workspace is mounted, at its own absolute path. Anything the build
  wrote elsewhere was discarded with the container.

The image must be present already: uvp never pulls one, so an image that is not
there is a refusal rather than a download. The image reference is the only place
a container is named — `uvp_build`'s `toolchain` takes `"container"` or
`"local"` and never an image. `"container"` requires one the workspace named;
`"local"` refuses one the workspace named, which is how you check a
container-declared workspace with this host's compilers. `uvp_verify` refuses a
container-declared workspace with `unsupported_toolchain` before compiling
anything, because a pass runs what it builds; pass `toolchain: "local"` to
verify on this host.

Check before you build. `uvp_doctor` with the workspace's path reads the same
declaration: the image's toolchain appears beside this host's, and a missing
runtime or a missing image is reported as the prerequisite it is — with the
libuvcpp and feature sections describing what the workspace will build against,
or saying that the image could not be examined. That is the answer to "can I
build this here" without starting a build to find out.

## Ports

`uvp_run` and `uvp_verify` need a port that is free. If you are starting several
services, give each one its own port — 8090 through 8094 is what the test suite
uses. Reusing a port across sequential runs mostly works and occasionally
collides with a socket still in `TIME_WAIT`, which produces a failure that looks
like a broken service and is not.

## Generated code is yours

The workspace uvp writes is an ordinary CMake project with no uvp dependency.
Edit it freely — `main.cpp`, `CMakeLists.txt`, anything. Re-running
`uvp_workspace_create` over it will overwrite, so once you start editing, stop
regenerating.

Build it yourself at any point:

```bash
cmake -S ./svc -B ./svc/build && cmake --build ./svc/build
```

If that works and uvp reports a failure, the difference is worth investigating
rather than working around.

## Tool reference

See [tools.md](reference/tools.md) for every tool with its effects, or read
`tool-catalog.json` from the package for the machine-readable form.
