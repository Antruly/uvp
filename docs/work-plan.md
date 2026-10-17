# Current development plan

**Snapshot:** 2026-10-17T07:33Z. This is a snapshot, not a live dashboard. The
direction lead updates it per batch with the maintainer's approval; counts and
open items will drift between snapshots.

This page answers three questions for an AI engineer or a contributor:

1. what is already working;
2. what is being worked on now;
3. which direction is useful next, and how to claim it.

Follow [the AI development workflow](agent-workflow.md) and
[AI engineer operations](ai-engineer-operations.md) before claiming anything.

## Where we are

- **70 merged PRs**, **68 closed issues**; **9 open issues**, **3 open PRs** at
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
The first release-engineering tasks are now tracked as #160–#163.

## Current direction

1. **Release automation and the first public release.** This is the critical
   path. The package is not yet published, so `npx uvp-agents setup` is not real
   until the release pipeline exists. The tasks are:
   - #160 — release-please workflow;
   - #161 — npm publish;
   - #162 — MCP registry publish;
   - #163 — clean-environment `npx uvp-agents setup` acceptance.

   Dependency order: #160 → #161 → #162 and #163.

2. **Windows/MSVC polish.** The Windows toolchain lane exists. The remaining
   tracked work is MSVC link diagnostics (#142 / PR #143). The generator
   selection fix (#154 / PR #155) and the Windows database refusal path (#108)
   have landed.
3. **Remaining reliability fixes.** Workspace-name validation (#87 / PR #91) and
   cancelled verification handling (#122 / PR #130) need their owners to rebase
   and finish them.
4. **Documentation and status accuracy.** This refresh (#164), the README status,
   the release notes, and the support matrix must match what the lanes have
   actually observed.
5. **Agent onboarding acceptance.** #163 is the clean-environment proof of
   `setup` → MCP configuration → `uvp_doctor` → generate → build → run → verify.
6. **Upstream watch.** #41 is blocked on Stryker's upstream vitest-runner
   (#6210/#6214). A libuvcpp defect belongs in the libuvcpp repository, not in a
   local patch.

## Claimable first-stage tasks

These are the tasks that move the first public release forward. Claim one by
commenting with your identity, as described in
[AI engineer operations](ai-engineer-operations.md#task-taking-mode).

| Task                                                | Issue | Depends on        | Status          | Claim                  |
| --------------------------------------------------- | ----- | ----------------- | --------------- | ---------------------- |
| Release-please workflow                             | #160  | none              | Open, unclaimed | Claim now              |
| npm publish                                         | #161  | #160, release tag | Open, unclaimed | Claim after #160 lands |
| MCP registry publish                                | #162  | #161              | Open, unclaimed | Claim after #161 lands |
| Clean-environment `npx uvp-agents setup` acceptance | #163  | #161              | Open, unclaimed | Claim after #161 lands |

One active task per engineer. The claim comment is the ownership record until the
tracker assignment exists. The dependency order is deliberate: #160 and #161 must
land before #162/#163 can be observed.

## Open work at this snapshot

These are existing issues/PRs, not new claims. The PRs are owned by their authors
and need a rebase before they can be reviewed again.

| Area                      | Issue | PR   | Status              | Next                          |
| ------------------------- | ----- | ---- | ------------------- | ----------------------------- |
| Windows/MSVC diagnostics  | #142  | #143 | PR dirty (conflict) | Rebase, re-run checks, review |
| Verification cancellation | #122  | #130 | PR dirty (conflict) | Rebase, re-run checks, review |
| Workspace name validation | #87   | #91  | PR dirty (conflict) | Rebase, re-run checks, review |
| Mutation attribution      | #41   | —    | Upstream blocked    | Watch Stryker #6210/#6214     |

Rebase the owner's branch, re-run the checks that cover the change, and keep the
PR body current. Do not open a competing PR for the same issue. #112 (the
duplicate WebSocket PR) is closed.

## Next work not yet tracked

These are candidate areas. Open an issue (or a design discussion, where the
contribution scope requires one) if you intend to own one:

- a release support matrix: Linux/macOS local, container, Windows MSVC, and the
  named gaps;
- README/status/FAQ updates so the public claims match the observed lanes;
- a Windows VS-version coverage check after #154/#155 (which VS versions the lane
  actually exercised);
- workspace/verification reliability fixes beyond the current open issues;
- richer application templates only if the maintainer decides the scope (auth,
  OpenAPI, fuller CRUD patterns); the current templates are deliberately minimal.

The release-engineering directions are no longer untracked: they are #160–#163.

## Available directions for contributors

You may propose or claim work in these directions. Follow the contribution scope
and the identity/task-taking rules.

| Direction                     | What is useful                                                  | Why                                                     |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Release engineering           | #160–#163: release-please, npm, MCP registry, setup acceptance  | Unblocks the stated goal: an AI can install and use uvp |
| Windows/MSVC                  | #142/#143; VS-version coverage check                            | Makes the Windows claims observed rather than inferred  |
| Runtime/workspace reliability | rebase and finish #91/#130/#143; add regressions                | Closes the remaining correctness gaps                   |
| Documentation/status          | #164 and follow-ups: README, FAQ, release notes, support matrix | Prevents users and agents from misreading the stage     |
| Agent onboarding              | #163: setup → doctor → create → build → run → verify            | Proves the MCP path end to end                          |
| Upstream tracking             | Stryker #41; libuvcpp issues in the libuvcpp repo               | Keeps uvp's own scope clean                             |

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
public release. The critical path is #160 → #161 → #162/#163, plus the author's
review/approval. The remaining code fixes are the three dirty PRs. The release
pipeline has never been run, so this estimate is derived rather than observed.

## How to claim

1. Read [AI engineer operations](ai-engineer-operations.md) and confirm your
   identity in `dev-identity.md`.
2. Pick an eligible task; for #160–#163, respect the dependency order.
3. Post the claim comment with your identity marker.
4. Update your local identity file and start work.
5. Hand back with evidence if you cannot finish; do not leave a silent stall.
