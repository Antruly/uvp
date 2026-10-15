# Architecture

uvp is a TypeScript control plane that produces and drives a C++ data plane. This
page explains the split, the layer rules that keep it honest, and the one place
where the dependency direction had to be fixed rather than worked around.

## Why TypeScript drives C++

The output of uvp is C++. The tool itself is not, and that is a deliberate
choice.

The parts of uvp that change most — tool contracts, code generation, CMake
output parsing, the evidence algebra, the CLI and MCP surfaces — are exactly the
parts that are painful to iterate on in C++. They are also the parts where a
mistake is a wrong answer rather than a crash, which makes fast iteration and
easy testing more valuable, not less.

The parts that must be C++ are the parts that must actually be C++: the generated
service, and nothing else. There is no `uvp::core`, no `uvp::web`, no runtime
library linked into a generated project. A generated workspace depends on
libuvcpp and the standard library.

This is the same split that makes REA work: a replaceable control plane in
TypeScript, with an opaque substrate reached through a narrow boundary. In REA
the substrate is a decompiler; here it is a compiler, CMake, and a libuvcpp
install.

## Layers

Dependencies flow inward. A layer may import from the layers below it and never
from the layers above.

```
                 cli.ts / main.ts            adapters
                        │
                   composition/               wiring
                        │
        ┌───────────────┼───────────────┐
        │                               │
   toolchains/                     server/ + cli/    adapters
   (providers)                          │
        │                               │
        └──────────► application/ ◄─────┘            workflows
                          │
                     contracts/                      tool contracts
                          │
                       domain/                       pure semantics
```

**`src/domain/`** — pure semantics with no I/O: the error contract, the evidence
and unknown vocabularies, identity generation, the result algebra, and the
shared feature vocabulary. Everything here is cheap to test exhaustively, which
is why its coverage threshold is the highest in the project.

**`src/contracts/`** — the tool contracts. One `defineTool` call per tool, with a
Zod input schema, a Zod output schema, an effects declaration, and examples. This
is the single source of truth consumed by the MCP registrar, the CLI registrar,
the generated catalog, and the shipped skill.

**`src/application/`** — the workflows: creating a workspace, assessing a
toolchain, building, supervising a process, issuing requests, evaluating
assertions, assembling a verification bundle. This layer defines the ports it
needs (`ToolchainProvider`, `ProcessSupervisor`) and never knows which
implementation it was handed.

**`src/toolchains/`** — provider adapters. `local/` is the only one implemented.
A provider reports what it _can_ do before it is asked to do anything, and
reports per-capability gaps rather than failing as a monolith.

**`src/composition/`** — the one place where a concrete provider is bound to a
service. Nothing above this layer constructs a provider, and nothing below it
knows which one was chosen.

**`src/server/`, `src/cli/`** — the MCP and CLI adapters. Both read the same
contracts and call the same services. A behaviour that exists in one and not the
other is a bug in the adapter, not a design decision.

**`src/main.ts`, `src/cli.ts`** — the entrypoints.

### The rule, enforced

`src/domain/` may not import from `application`, `contracts`, `toolchains`, or
the adapters. `src/contracts/` may import from `domain` and nothing above it.
`src/application/` may not import from `toolchains`, `composition`, or the
adapters — it defines the ports it needs and is handed implementations.
All three are enforced by `no-restricted-imports` in `.oxlintrc.json`, so a
violation is a lint error rather than a review comment, and the rule covers
type-only imports as well as value ones.

The third rule is the newest, and it exists because of what its absence cost.
`application` imported `startSupervised` from `toolchains/local/processRunner`
for as long as `local/` was the only provider, and `sessionStore` imported that
module's `SupervisedProcess` type. Nothing was wrong with either line at the
time; what was wrong was that "run this service" quietly meant "run it on this
machine", in a layer that is not allowed to know which provider it is using. The
supervision port fixed it, and the lint rule is what will notice next time —
which is the point the roadmap made when it recorded the row: the refactor
without the rule is a fix, and the rule is the prevention.

The inverted import is worth reading as a case rather than an anecdote. It was
not a mistake about types or about the direction of the arrow; it was a
convenience that happened to be correct while there was one implementation, and
the layering rule was enforced only where its violation would have been obvious.
`contracts` importing `application` breaks immediately, because a vocabulary
would need a workflow. `application` importing `toolchains` breaks only when
somebody adds the second provider — that is, at exactly the moment the port was
supposed to pay off.

### The same species one layer down

Fixing the port left the module where it was, and the module was in the wrong
place for the same reason. `toolchains/local/processRunner.ts` was not about the
local provider: `toolchains/native/NativeProbeRunner.ts` already imported
`runProcess` from it, so the `local` in that path was already a lie. It is how
this host starts a process at all, which is what every provider needs to run a
compiler, a probe, or a service.

It now lives at `toolchains/processRunner.ts`, beside `toolchains/host.ts` — the
`whichOnPath` and `versionOf` that `local/` had kept private and that a
`container/` provider looking for `docker` needs just as much. `local/` imports
both rather than declaring its own, which is the part that matters: two
implementations of "is this command on the path" would eventually disagree about
`PATHEXT`, about an empty `PATH` entry, or about a file that exists and is not
executable, and the disagreement would surface as one provider finding a compiler
the other cannot — reading as a toolchain bug rather than a lookup bug.

The pattern to notice is that both cases looked like a private helper and were
really a shared capability filed under whichever provider needed it first. The
test is whether the module mentions the provider it sits under. Neither does.

Two more moved for the same reason once a container provider was being written:
`toolchains/diagnostics.ts`, which reads a build's failures out of CMake's and
the compilers' own output, and `toolchains/artifacts.ts`, which decides which
files a build directory produced. Both were under `local/`, and neither is about
the local provider — a container build that bind-mounts the workspace at the same
absolute path produces a build directory that is an ordinary host directory, so
it asks the same two questions with the same answers. The artifact heuristic
still uses `process.platform`, which looks local and is not: the files being
hashed are host files whichever side of the container boundary compiled them.

That is four modules in one change, which is worth saying plainly rather than
tidying into a single anecdote. The reason there were four is that "the local
provider" was the only provider for long enough that anything generic written
during that time landed inside it, and nothing distinguished a local fact from a
host fact because there was no second host.

The container provider then contributed a fifth, and it is the first one that was
never in the wrong place. `toolchains/libuvcppConfig.ts` was written at the
`toolchains/` root because by then the question had an obvious owner: which
`UVCPP_*` symbols a build defines, and where an installed config header lives, are
the same questions whoever compiles the code. What splits between the providers
is only the file read — `local` opens the header with `readFile`, `container`
`cat`s it inside the image — and the layouts are returned as _relative path
segments_ rather than joined paths, because the join is the one part that cannot
be shared: a Windows host joining them with `path.join` would hand a Linux image a
path full of backslashes. Getting that split right the first time is the
difference between a shared fact and a shared assumption.

`toolchains/diagnostics.ts` grew `noWorkWasDone` in the same period, for a reason
worth recording because the obvious version of it is wrong. A build that reports
itself as coming from a cache is reporting that no compiler ran, and the tempting
evidence is `Built target`, which GNU Make prints for every target on every
successful build — including a fresh compile that took a second and a half.
Matching it would label each of those as a cache hit, which is an invented fact
about work that plainly happened. Only the phrasings that mean exactly "nothing to
do" are matched, and they are matched in one place so that two providers cannot
disagree about whether the same output was a no-op.

## The container provider, and where it sits

`toolchains/container/` is a second implementation of the same port, and its
position in the layer graph is the only thing about it that is not interesting:
it sits beside `local/` and `native/`, imports `application` and `domain` and the
`toolchains/` root, and imports nothing from `local/`. That last one is the check
worth running when a provider is added, because the shared modules described above
are exactly what a new provider is tempted to reach into the previous one for.

Two decisions inside it are consequences of the layering rather than of
containers:

**uvp never pulls an image.** The caller names an image reference, the provider
requires it to be present locally, and its absence is a per-capability gap. uvp's
scope is building, running, and verifying on a machine the user controls;
acquiring a registry credential path as a side effect of being asked to compile
C++ would be a new authority nothing asked for. The refusal is a fact about the
provider that is checkable offline, and it is checked: the test asserts that when
the image is absent, exactly one command ran — the inspection — so nothing about
the image was attempted.

**The workspace is mounted at the same absolute path.** `-v /a/b:/a/b` rather
than `-v /a/b:/work`. Every path in a `BuildOutcome` — `buildDir`, each
diagnostic's `file`, each artifact's `path` — is then valid on the host as well as
inside the container, so `discoverArtifacts` reads the real files and a diagnostic
points at something the caller can open. Translating paths after the fact would be
a second interpretation of a string the caller already gave a meaning to, which is
what the rules in this document exist to prevent. It is also why `artifacts.ts`
could move to the `toolchains/` root unchanged: the build directory it is handed
is an ordinary host directory, whoever compiled what is in it.

## The case that shaped the rules: `UvpFeature`

The feature vocabulary — `tls`, `http2`, `http3`, `grpc`, `websocket`, `soap`,
`db` — is needed in three places at once:

- `contracts/` validates a caller's requested features against it.
- `application/templates.ts` is parameterised by it and emits `#if` guards.
- `application/ToolchainProvider.ts` maps each one to real CMake switches and
  configuration macros.

The obvious home was `ToolchainProvider.ts`, next to the mapping. That was wrong:
`contracts/` would then have to import from `application/`, inverting the
dependency direction to reach a shared vocabulary.

The fix was not a re-export or a type-only workaround. The vocabulary moved to
`src/domain/features.ts`, where a shared vocabulary belongs, and all three
consumers import from there. The bug that motivated the change is instructive: a
literal feature list in the contract was missing `soap`, so
`uvp_workspace_create` silently rejected a feature the rest of the system
supported. With one exported constant and `z.enum(UVP_FEATURES)`, that class of
drift is now a compile error.

## The provider port

```ts
interface ToolchainProvider {
  identity(): ToolchainIdentity;
  inspectAvailability(signal: AbortSignal): Promise<ToolchainAvailability>;
  findLibuvcpp(workspacePath: string | undefined, signal: AbortSignal): Promise<LibuvcppBuild>;
  createClient(): ToolchainClient;
}
```

Four methods, and the shape carries most of the design:

**Inspection is separate from use.** A provider can be asked what it has without
anything being built. This is what makes `uvp doctor` useful before a workspace
exists, and it is why the feature assessment can run before a single file is
written.

**Gaps are per-capability.** `ToolchainAvailability.missing` is a list of
`{id, requiredFor}` pairs, not a boolean. A container provider with no host
filesystem reports that it cannot read the host tree; it does not report itself
as unavailable. A provider that reports itself as a monolith forces every caller
to handle an all-or-nothing failure it does not actually have.

**Building is a separate capability.** `ToolchainClient` exists apart from
`ToolchainProvider` so an inspection-only provider — a report, a remote probe, a
test double — stays implementable without stubbing a `build()` that throws.

**A failed build is not an exception.** `BuildOutcome.exitCode !== 0` is a normal
return carrying diagnostics. Only the inability to run the toolchain at all is an
error, and that is a `UvpFailure`. Collapsing the two makes an agent's
fix-and-retry loop indistinguishable from a broken installation.

**A cancellation is not a finding.** Every method that can take time takes the
caller's `AbortSignal`, and a provider that sees it aborted rejects with
`cancelled` — it does not return what it had collected so far. The distinction is
not pedantic: the answers this port returns are the shapes that mean "this host
has no compiler" (an empty `compilers` list), "there is no libuvcpp here"
(`found: false`), and "this workspace does not build" (a non-zero exit). Each of
those makes a caller go and install something or rewrite something, and none of
them is what an interrupted run observed. The signal is checked before the work
starts as well as during it, so a call that arrives already cancelled starts no
process at all. The rule does not stop at this port: a workflow that waits on a
deadline — `uvp_run`'s readiness poll — honours the same signal, and stops the
service it had already started rather than leaving a listener on a port the caller
has stopped waiting for.

## Where libuvcpp facts live

Feature-to-switch mappings live in `application/ToolchainProvider.ts` as
`FEATURE_REQUIREMENTS`, and each entry records three things: the CMake options
that turn the module on in a source build, the `uvcpp_config.h` macros that prove
it is present in an installed build, and the header that proves the module ships.

Three facts about that table are load-bearing and are documented in place, in
[libuvcpp feature mapping](libuvcpp-features.md), and in `CONTRIBUTING.md`:

- WebSocket needs **both** `UVCPP_BUILD_WEB` and `UVCPP_BUILD_WEBAPP`. There is no
  standalone WebSocket switch.
- **gRPC has no switch at all.** Its headers install whenever they are present in
  the source tree, so `cmakeOptions` is empty and the check is header existence.
- The `UVCPP_*_ENABLE` macros are **always defined, to 0 or 1**, so
  `#if !UVCPP_OPENSSL_ENABLE` is a correct compile-time test and
  `#ifdef` would not be.

## Discovery: two routes, one floor

libuvcpp ships two ways and they are not interchangeable:

- `cmake --install` writes a CMake package config to `lib/cmake/uvcpp/`, giving
  `find_package(uvcpp CONFIG)` and the namespaced target `uvcpp::uvcpp` (the
  export set is installed with `NAMESPACE uvcpp::`).
- The prebuilt release archives ship **only** `lib/pkgconfig/uvcpp.pc`. There is
  no CMake config in them.

A generated `CMakeLists.txt` tries the CMake package first and falls back to
`pkg-config`, and enforces the version floor on both routes. Getting this wrong
produces the most confusing failure in the project's history: a project that
configures cleanly against one route and cannot find libuvcpp at all against the
other, with no error that names the reason.

## What is deliberately not here

- **A uvp runtime for generated code.** The generated project must stand alone.
- **A C++ MCP SDK.** The control plane is TypeScript; a second implementation
  would be a second source of truth.
- **A cache that survives a libuvcpp change.** A build cache key that does not
  cover the libuvcpp build is a cache that returns a wrong answer, which is worse
  than a slow one.
