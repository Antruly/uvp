# Repository Guidelines

Instructions for AI agents working in this repository. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md) first; the scope and ownership rules there
apply to agents too.

## Product and Authority

uvp generates, builds, runs, and verifies C++ web services that link against
libuvcpp. It is a local tool with shared CLI and MCP workflows. Distinguish
observations, derivations, inferences, and unknowns; preserve evidence
provenance and session semantics through both adapters.

The generated project is the deliverable. It must build with plain CMake against
an installed libuvcpp and nothing else. Never introduce a uvp runtime dependency
into generated code, and never make a generated project depend on a file uvp
writes outside the workspace.

Generated services listen on sockets and make outbound requests. Code that
starts a process, opens a listener, or contacts a network endpoint must say so in
its tool contract's `effects` block; an unlisted effect is a contract bug.

Follow the [contribution scope and fail-closed rule](CONTRIBUTING.md#contribution-scope).
Do not integrate capabilities while material scope, authority, side-effect, or
required-verification questions remain unresolved.

A defect in libuvcpp is fixed in libuvcpp. File the issue or fix PR there, link it
from the uvp issue, and let the maintainer decide whether uvp waits, works
around, or narrows the claim. Do not patch libuvcpp inside uvp or in generated
code. Other upstream dependencies follow the same rule; a uvp issue may track one
with an upstream link and a recheck condition.

## Architecture and Cleanup

Dependencies flow inward: `domain` semantics, then `contracts`, then
`application` workflows, then `toolchains` providers, then `composition`, then
the `server` and `cli` adapters. Keep toolchain-specific and protocol-specific
code out of `domain` and `application`. See
[docs/architecture.md](docs/architecture.md) when changing composition.

`contracts` may import from `domain` and never from `application`. A vocabulary
shared by contracts, templates, and the toolchain layer belongs in `domain` —
that is why `UvpFeature` lives there rather than beside the code that maps it to
CMake switches.

A tool contract is the single source of truth for a tool. The MCP registrar, the
CLI registrar, the generated catalog, and the shipped skill all read it. Never
hand-write a schema that a contract already declares, and never let catalog
ordering select an operation.

Give each interpretation and resource a clear owner. Consumers use the owner's
parsed facts rather than reinterpreting raw source. A `uvp.json` manifest is
read at one boundary and passed on; nothing else re-parses it.

Keep proof of ownership separate from validity. Retain ownership of resources
whose cleanup failed, and report a cleanup failure explicitly rather than
inferring success from a process's absence.

Normalize once, at the owning boundary, using a format-aware parser. CMake
output is parsed by the toolchain layer, not re-scanned downstream.

When fixing a bug, inspect the producing boundary and its consumers for
duplicated interpretation or unclear ownership, and complete directly related
refactoring in the same change. Passing regression tests alone does not
establish that the brittleness is resolved.

## Evidence and Honesty

This is the rule that matters most, and the one most easily violated by
plausible-looking code.

- Never report `complete` coverage for a scope that was not examined. Missing
  coverage is `unknown`, with a reason.
- Never report a feature as absent when the check could not run. An unavailable
  probe yields `undetermined`, not `unmet`.
- Never claim a runtime observation that was not observed. A simulated provider
  establishes the boundary, not real-toolchain behaviour.
- Never derive a capability claim from a version number when a configuration
  header or an installed header is available to check instead.

If you find yourself writing a fallback that converts "I could not look" into a
yes or a no, stop and model the third state.

## Performance

Design agent-facing tools for the whole task, including schemas, retries, and
follow-up calls. Return the smallest sufficient answer with the provenance and
limitations a caller needs to trust it, and keep the full evidence reachable
rather than inlined.

Bound what a tool holds: response bodies, build logs, and capture sessions each
have a stated limit, and truncation is reported rather than silent. Validate
cached results against the inputs that affect them; a build cache key must cover
the source, the toolchain, and the libuvcpp build.

## Development

Use [.nvmrc](.nvmrc) and `package.json#packageManager` for the pinned toolchain.

- `npm ci` — install locked dependencies.
- `npm run compile` — build the runtime into `dist/`.
- `npm run test:local -- PATH...` — source tests without building.
- `npm run test:focused -- PATH...` — exact tests with their required artifacts.
- `npm run check:fast` — cached typecheck and lint.
- `npm run docs:check` — validate generated documentation.

Use the checks relevant to the change. The complete local gate is
`npm run check:pr`.

`docs/public/tool-catalog.json` and `skills/` are generated outputs. Edit the
contracts in `src/contracts/`, then regenerate. Never commit `dist/`,
`node_modules/`, build directories, or downloaded libuvcpp trees.

## Tool and Test Changes

For tool design, follow [docs/tool-design.md](docs/tool-design.md): start from
the caller's question, reuse existing contracts, and return useful evidence
inline. Limits must follow real format, protocol, or resource constraints.

For test changes, use [docs/testing.md](docs/testing.md). Prefer a real
build-and-run workflow, then a production-boundary integration test, then a
producer golden. Keep module tests for semantics a stronger workflow cannot
reproduce. When a lane needs libuvcpp or a compiler that is absent, skip with a
named reason that appears in the output; a lane must not imply coverage it did
not have.

Use Conventional Commit subjects and PR titles. Mark breaking changes with `!`
or a `BREAKING CHANGE:` footer.

## Pull Request Readiness

Follow [human ownership and readiness](CONTRIBUTING.md#pull-request-ownership-and-readiness).
AI-assisted contributions are welcome, and a human must review and own the final
diff, check the validation evidence and its limits, and explicitly declare the
PR ready for initial maintainer review.

Leave the template's **Author readiness** declarations unchecked for the human
owner. Never attest to human review on their behalf, and never approve a change.
When your operator has granted standing authorization — this repository's
maintainer does, for the fixes they ask for — you may create the branch for a
tracked issue, named after it, push it, and open one PR against `main` from it; you
may merge that PR **only** after the owner has explicitly approved it on the PR,
since a green run is evidence rather than approval. Never push to `main` directly.
Keep the PR body and affected validation current as the work changes, and report
only checks that actually ran.

The operating workflow — roles, one owner per task, triage states, review, the
approval packet, and the author proxy assistant's limits — is defined in
[docs/agent-workflow.md](docs/agent-workflow.md). It is normative for every agent
here, and it does not change the human gate above: the author completes the
**Author readiness** declarations and is the only approver.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
