# Current development plan

**Snapshot:** 2026-10-17T06:30Z. This is a snapshot, not a live dashboard. The
direction lead updates it per batch with the maintainer's approval; counts and
open items will drift between snapshots.

This page answers three questions for an AI engineer or a contributor:

1. what is already working;
2. what is being worked on now;
3. which direction is useful next, and how to claim it.

Follow [the AI development workflow](agent-workflow.md) and
[AI engineer operations](ai-engineer-operations.md) before claiming anything.

## Where we are

- **67 merged PRs**, **65 closed issues**; **5 open issues**, **5 open PRs** at
  this snapshot.
- **Roadmap:** 50 of 54 marked items are done. The four open rows are
  `remote-ssh/` (blocked on verification), two CI observations/flakes, and the
  Ubuntu 26.04 migration watch.
- **Milestone 1:** complete. The full describe → generate → build → run → probe →
  evidence loop works for all six templates against real libuvcpp.
- **Milestone 2:** the `container` provider is written and passes the provider
  conformance suite; `remote-ssh/` is not written and is blocked on a real
  verification route, not on appetite.
- **Milestone 3:** HTTP/2, HTTP/3, TLS, database-backed templates, capture replay,
  and bundle diff are in place.
- **Web toolbox:** HTTP/1.1, HTTP/2, HTTP/3, TLS, WebSocket (Node and libuvcpp
  native probe), SOAP, load test, capture, assertions, verify, bundle diff.
- **MCP and CLI:** 15 tool contracts shared by both surfaces; `uvp setup` supports
  Claude Code, Claude Desktop, and Cursor; the `build-libuvcpp-services` skill is
  shipped with the package.
- **Quality:** source, conformance, toolchain, boundary, composition, and
  acceptance projects; mutation testing, fuzzing, a Windows source lane, a
  Windows MSVC toolchain lane, container conformance, SBOM, and reproducible
  packing.

The core product is therefore **feature-complete for the current scope**. The
largest remaining gap is not a feature: **release automation and publishing**.

## Current direction

1. **Release automation and the first public release.** This is the critical
   path. The package is not yet published, so `npx uvp-agents setup` is not real
   until the release pipeline exists. Needed: a release-please workflow, npm
   publishing, MCP registry publishing, and a packaged-install verification.
2. **Windows/MSVC polish.** The Windows toolchain lane exists. Remaining work:
   MSVC link diagnostics (#142), `--generator msbuild` following the installed
   Visual Studio (#154), and the Windows database refusal gap (#108).
3. **Remaining reliability fixes.** Workspace-name validation (#87), cancelled
   verification handling (#122), and the rebases needed for their PRs.
4. **Documentation and status accuracy.** The README's "Current status" still
   understates the container provider and the Windows lane. The release-facing
   docs must match what the lanes have actually observed.
5. **Agent onboarding acceptance.** After publishing, run the real
   `npx uvp-agents setup` → `uvp_doctor` → generate → build → run → verify loop in
   a clean environment, including the MCP client configuration and the shipped
   skill.
6. **Upstream watch.** #41 is blocked on Stryker's upstream vitest-runner
   (#6210/#6214). A libuvcpp defect belongs in the libuvcpp repository, not in a
   local patch.

## Open work at this snapshot

| Area                      | Issue        | PR   | Status              | Next                                       |
| ------------------------- | ------------ | ---- | ------------------- | ------------------------------------------ |
| Windows/MSVC generator    | #154         | #155 | PR clean, draft     | Review; ready/approve; merge               |
| Windows/MSVC diagnostics  | #142         | #143 | PR dirty (conflict) | Rebase, re-run checks, review              |
| Verification cancellation | #122         | #130 | PR dirty (conflict) | Rebase, re-run checks, review              |
| Workspace name validation | #87          | #91  | PR dirty (conflict) | Rebase, re-run checks, review              |
| WebSocket duplicate       | #94 (closed) | #112 | PR dirty, duplicate | Proposed: close #112; no decision recorded |
| Mutation attribution      | #41          | —    | Upstream blocked    | Watch Stryker #6210/#6214                  |

The three dirty PRs tied to open issues (#91, #130, #143) need a rebase before
they can be reviewed again. Rebase the owner's branch, re-run the checks that
cover the change, and keep the PR body current. **Proposed:** #112 is a duplicate
and should be closed rather than rebased; no maintainer decision is recorded yet.
Do not open a competing PR for the same issue.

## Next work not yet tracked

These are candidate areas. Open an issue (or a design discussion, where the
contribution scope requires one) if you intend to own one:

- release-please workflow, npm publish, and MCP registry publish;
- a clean-environment, packaged `npx uvp-agents setup` acceptance run;
- a release support matrix: Linux/macOS local, container, Windows MSVC, and the
  named gaps;
- README/status/FAQ updates so the public claims match the observed lanes;
- Windows: VS 2019/2022/2026 generator selection, MSVC link diagnostics, and the
  Windows database refusal path;
- workspace/verification reliability fixes beyond the current open issues;
- richer application templates only if the maintainer decides the scope (auth,
  OpenAPI, fuller CRUD patterns); the current templates are deliberately minimal.

## Available directions for contributors

You may propose or claim work in these directions. Follow the contribution scope
and the identity/task-taking rules.

| Direction                     | What is useful                                                | Why                                                     |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Release engineering           | release-please workflow, npm/MCP publishing, packaged install | Unblocks the stated goal: an AI can install and use uvp |
| Windows/MSVC                  | link diagnostics, generator selection, Windows DB refusal     | Makes the Windows claims observed rather than inferred  |
| Runtime/workspace reliability | rebase and finish #91/#130/#143; add regressions              | Closes the remaining correctness gaps                   |
| Documentation/status          | README current status, FAQ, release notes, support matrix     | Prevents users and agents from misreading the stage     |
| Agent onboarding              | setup → doctor → create → build → run → verify acceptance     | Proves the MCP path end to end                          |
| Upstream tracking             | Stryker #41; libuvcpp issues in the libuvcpp repo             | Keeps uvp's own scope clean                             |

If you need help, leave the task unclaimed in the plan/issue so another engineer
can pick it up. If you cannot solve it, hand it back with evidence; do not leave
it silently stalled.

## Not planned

These are deliberate boundaries from the roadmap and contribution scope. Do not
start them as part of a bug fix or a first release:

- a uvp runtime library;
- a C++ MCP SDK;
- a production deployment or scaling tool;
- a general-purpose load generator;
- a hosted service;
- patching or vendoring libuvcpp inside uvp.

## Release readiness

A first public release should mean: the npm package is published, the MCP
registry entry resolves, `npx uvp-agents setup` works in a clean environment, and
the documented support matrix matches the lanes that actually ran.

The current estimate is **about one to two weeks of focused work** for a first
public release, with the release pipeline and the author's review/approval as the
critical path. The remaining code fixes are small; the release automation has
never been run, so this estimate is derived rather than observed. The core code
is close; the uncertainty is in publishing, packaging, and cross-platform
verification.

## How to claim

1. Read [AI engineer operations](ai-engineer-operations.md) and confirm your
   identity in `dev-identity.md`.
2. Find an eligible open issue/PR, or open a new issue for a direction above.
3. Post the claim comment with your identity marker.
4. Update your local identity file and start work.
5. Hand back with evidence if you cannot finish; do not leave a silent stall.
