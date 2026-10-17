# Contributing to uvp

uvp welcomes focused bug fixes, documentation improvements, tests, new
templates, and verification lanes. For large contract or architecture changes,
open a design discussion first so the direction is agreed before the code.

uvp is an AI-native project: it exists to be driven by agents, and much of it is
written with them. That does not lower the bar — it raises it, because a
plausible-looking change that quietly reports success is the failure mode this
project is built to avoid.

## Choosing a contribution

Good first contributions:

- A new template that exercises a libuvcpp capability the existing five do not.
- A verification lane for a platform or toolchain uvp has only ever been run on
  locally.
- A libuvcpp feature whose real CMake switch or configuration macro is documented
  inaccurately. These are factual corrections and are especially welcome — see
  [Feature mappings](#feature-mappings).
- Documentation that describes a behaviour inaccurately, with the reproduction.
- A test for a distinct failure that the build-and-run workflow cannot reliably
  reproduce.

Changes that need a design discussion first:

- A new provider (container, remote toolchain, MSVC).
- A change to the error contract, the evidence algebra, or a tool's output
  schema.
- Anything that adds an effect to a tool: network, process, filesystem writes,
  mutation.
- A new top-level dependency.

## Reporting issues

Use the issue form that fits and keep it concise. For bugs, include the actual
result, the shortest reproduction you ran, the uvp version, your compiler and
libuvcpp versions, and the smallest useful output. Ground expected behaviour in
the documentation, the source, or a known-good version.

Incomplete reports are welcome. If a narrative answer or supporting evidence is
unavailable, write `NOT_ENOUGH_INFO` and explain the gap. Label source-only
findings and proposed checks; do not claim a runtime reproduction you did not
perform. A diagnosis or a fix is not required to report a problem.

Two facts are worth including whenever you have them, because they resolve most
toolchain bugs immediately:

- The output of `uvp doctor --json`, which names the compiler, CMake, and the
  libuvcpp build and its enabled modules.
- Whether libuvcpp was `cmake --install`ed or unpacked from a release archive.
  The two ship different discovery files, and several bugs are one of the two
  routes only.

## Pull request ownership and readiness

Every PR must have a human owner who takes responsibility for the complete
change — code, tests, documentation, and anything produced with AI assistance.
The PR author is the owner unless another human is named on the PR and
explicitly accepts ownership. This applies to maintainer-authored PRs too.

**One branch per issue, one PR per branch, and the owner's approval is what merges
it.** When the operator of an agent working here has granted standing authorization
— this repository's maintainer does, for the fixes they ask for — the agent may
create the branch for a tracked issue, named after it, push that branch, and open
one PR against `main` from it. It may merge that PR **only** after the human owner
has explicitly approved it on the PR: a green run is evidence, not approval, and an
approval on one PR does not carry to the next. Nothing is pushed to `main`
directly, by an agent or by a person. Without that grant, an agent writes no branch
and no PR and proposes the change to its operator instead.

The human owner must:

- Review the final diff and the surrounding code, and understand the change and
  its edge cases.
- Confirm the validation evidence supports the change as it now stands, and
  record the gaps that remain.
- Complete the **Author readiness** declaration in the PR template.
- Keep the PR body current as the work changes.
- Explicitly approve a PR an agent will merge. That approval is the merge gate,
  and CI is not a substitute for it.

Maintainers may return a PR to the author or close it when the problem is
unsupported, validation is missing, or the owner cannot explain the change.

## AI contribution policy

uvp uses an **AI-first, human-gate** model. The reasoning is simple: this project
is built for agents to drive, so refusing agent assistance would be incoherent —
but a repository where nothing is attested by a person degrades into
plausibility, and plausibility is exactly what uvp's evidence model exists to
reject.

**AI is a first-class tool.** Use it for code, tests, documentation, and review
passes. There is no expectation that any given file was typed by hand.

**A human is responsible for all of it.** The owner of a PR must be able to
explain what the change does, why the approach was chosen, and what could go
wrong. "The agent wrote it" is not an explanation.

**Agents act on the repository within that rule, and no further.** With its
operator's standing authorization an agent opens the branch and the PR for a
tracked issue, writes the PR description, answers review comments, and merges the
PR once the human owner has explicitly approved it. It never approves a change,
never attests to human review, never completes the **Author readiness**
declarations, and never closes a PR it did not merge — those stay the owner's, and
[one branch per issue](#pull-request-ownership-and-readiness) is the same rule read
from the agent's side.

The operating roles — direction lead, development agents, review agent, and
author proxy assistant — and the hand-off between them are defined in
[docs/agent-workflow.md](docs/agent-workflow.md). The author remains the only
approver, and the author completes the **Author readiness** declarations.

Per-engineer identity, task-taking, hand-back, and upstream rules are in
[docs/ai-engineer-operations.md](docs/ai-engineer-operations.md); the current
open work and direction are in [docs/work-plan.md](docs/work-plan.md).

**Disclosure is required, but light.** Add the `ai-assisted` label to a PR with
substantial AI involvement. If a specific passage is machine-generated and you do
not fully understand it, mark it in the diff — a comment is enough. There is no
need to annotate code you have read, understood, and can defend.

**Commit trailers.** When a commit was produced with an agent, add:

```
Assisted-by: <tool-name> (<ai-identity>)
```

The identity is the engineer's assigned identity, for example
`Assisted-by: Claude Code (Antruly-dev-1)`. An agent without an assigned identity
may name its role, for example `Assisted-by: Claude Code (direction-lead)`. The
tool name alone remains acceptable when no identity applies.

**Enhanced verification.** Changes to generated code, the toolchain layer, or
the evidence model need more than a passing test suite — see
[Validation](#validation).

## Contribution scope

uvp generates and runs network services. That is its purpose, and it is also
where its boundaries need to be explicit.

**In scope.** Code generation for libuvcpp services; building and running them
locally; driving requests at them; capturing exchanges; evaluating assertions;
reporting evidence. Tooling that checks a real libuvcpp build's actual
capabilities rather than assuming them.

**Needs review before integration.** Anything that makes uvp reach beyond the
local machine: remote toolchain providers, container execution with host
mounts, listening on a non-loopback interface by default. Anything that
introduces credentials. Anything that persists captured traffic containing
headers or bodies the caller did not intend to keep.

**Out of scope.** uvp does not generate services whose purpose is to attack,
scan, or degrade a system the caller does not control; it does not implement
load generation against a target the caller has not authorised; it does not
bundle exploit payloads. `uvp_load_test` exists to measure a service you are
developing, and its documentation says so.

This is a product boundary, not a judgment about a contributor's intentions.

**Upstream defects.** If a problem is in libuvcpp itself, report it or fix it in
the libuvcpp repository and link it from the uvp issue; do not carry a local
patch or a vendored copy. The maintainer decides whether uvp waits, works
around, or narrows the claim. Other upstream dependencies follow the same rule:
a uvp issue may track the problem with an upstream link and a recheck condition,
but the fix belongs upstream where possible.

### Fail-closed integration

If scope fit, authority boundaries, side effects, or the verification needed to
establish those boundaries remain materially unresolved, **do not merge or
enable the capability**. Keep the proposal pending, narrow it, or decline it.
Record unknowns explicitly rather than converting them into "none". Passing CI is
not scope approval.

### Feature mappings

uvp's feature table maps uvp feature names to real libuvcpp CMake options and
configuration macros. These are load-bearing facts, and a wrong one fails
silently: CMake warns about an unused `-D` and builds a library without the
module, and the generated service then fails to compile against headers that were
never installed.

If you change one, cite the file and line in libuvcpp that establishes it — a
`option()` declaration, a `#cmakedefine` in `cmake/uvcpp_config.h.in`, or the
installed header's existence. Documentation alone is not sufficient evidence;
libuvcpp's own README examples have drifted from its headers before.

Two known asymmetries, so you do not "fix" them:

- **WebSocket needs both `UVCPP_BUILD_WEB` and `UVCPP_BUILD_WEBAPP`.** There is no
  standalone WebSocket switch; the server lives in the web layer and the routing
  lives in the webapp layer.
- **gRPC has no switch at all.** Its headers install whenever they are present in
  the source tree, so the only honest check is whether `include/grpc/` exists.
  An empty CMake-option list for gRPC means "nothing to turn on", not "nothing
  needed".

## Development setup

```bash
npm ci
npm run check:fast        # typecheck and lint
npm run compile           # build dist/
npm run test:local -- src/application/templates.test.ts
```

`npm run build:cached` produces the runnable CLI and MCP server. After changing
`package.json` or a contract, regenerate the derived metadata:

```bash
npm run docs:generate
```

That one command regenerates every derived file — the package metadata, the tool
catalog, the shipped skills, the error-contract schema, the licence inventory and
the bill of materials — and `npm run docs:check` fails when any of them is stale.

**A Dependabot npm bump arrives stale, by construction.** The bot edits
`package.json` and `package-lock.json` and cannot run the command above, so
`licenses/npm-dependencies.json` and `sbom.cdx.json` stop matching the lockfile the
moment it pushes and `docs:check` refuses them — the first bump this happened to
was green on every other lane (#7, run `38852318351`). The remedy is one command
and one commit on the bot's branch:

```bash
npm run docs:generate
```

No workflow is given write access to a pull request branch to do it automatically;
that would be a scope decision of its own, and it has not been taken
([#17](https://github.com/Antruly/uvp/issues/17)).

### Working on the C++ side

The templates in `src/application/templates.ts` are verified by generating a
workspace and building it for real. That requires a compiler, CMake, and a
libuvcpp 1.7.0+ install. When they are absent the lane skips with a named reason;
it does not pass.

If you change a template, build and run the generated project by hand at least
once before opening a PR. Two mistakes are easy to make and are not visible from
the TypeScript:

- **libuvcpp types live in `namespace uvcpp`.** The library's own examples open
  with `using namespace uvcpp;`. Generated `main.cpp` files are translation
  units, so the directive is contained; do not remove it without spelling out
  every qualified name.
- **A static root resolves against the process working directory**, not the
  binary's location. A service started from elsewhere answers 500 on every static
  route with no explanation in the response.

## Documentation website

The site is built from `docs/` with VitePress:

```bash
npm run docs:dev
npm run docs:build
npm run docs:check
```

`docs/public/tool-catalog.json` is generated from the contracts. Never edit it by
hand — edit `src/contracts/` and regenerate.

## Generated files and command ownership

| Path                              | Owner                            |
| --------------------------------- | -------------------------------- |
| `docs/public/tool-catalog.json`   | `npm run artifacts:tool-catalog` |
| `src/generatedPackageMetadata.ts` | `npm run docs:generate`          |
| `skills/`                         | `npm run artifacts:skills`       |
| `docs/error-contract.schema.json` | `npm run artifacts:error-schema` |
| `licenses/npm-dependencies.json`  | `npm run licenses:generate`      |
| `sbom.cdx.json`                   | `npm run sbom:generate`          |

The licence inventory and the bill of materials describe the same set of
packages, so they share one walk over `package-lock.json` —
`scripts/lib/productionClosure.mjs`. Change it once, in one place; a second walk
is a second answer waiting to disagree.

`npm run docs:check`, `npm run tool-catalog:check`, `npm run licenses:check` and
`npm run sbom:check` fail when a generated file is stale, so CI catches a manual
edit.

## Validation

Report only commands that actually ran, with their observed results. A command
without a result is incomplete.

| Change                       | Minimum                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| Domain or contract semantics | `npm run test:local -- PATH...`, plus boundary cases across a port |
| Application workflow         | The workflow test, plus a real build-and-run case                  |
| A template                   | Generate, build, and run it against real libuvcpp                  |
| A tool contract              | `npm run tool-catalog:check`, plus the MCP boundary test           |
| Documentation                | `npm run docs:check` and `npm run docs:build`                      |
| Generated toolchain facts    | The file and line that establish them                              |

For an evidence-bearing change, state which claims are observed, which are
derived, and which remain unknown. Do not present a derived claim as an observed
one.

## Temporary files and diagnostics

Tests and verifiers create temporary directories. Resolve them through
`os.tmpdir()` and clean up on both the success and the failure path. Never write
scratch output into the repository. `*.tsbuildinfo`, `reports/`, `.cache/`, and
build directories are ignored — use them rather than tracked paths.

## Maintainer release checklist

See [docs/releasing.md](docs/releasing.md). In short: the Release Please PR is
reviewed like any other, and merging it starts publication. A release is not
complete when the tag exists; check the publication job and the published-package
verifier.
