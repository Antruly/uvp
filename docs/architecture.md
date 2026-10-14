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
needs (`ToolchainProvider`) and never knows which provider implements them.

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
Both are enforced by `no-restricted-imports` in `.oxlintrc.json`, so a violation
is a lint error rather than a review comment.

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
