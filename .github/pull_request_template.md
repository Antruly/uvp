<!--
PR title: type(optional-scope): imperative outcome
The title becomes the squash-merge commit subject and the generated changelog entry.

Agents: leave the Author readiness declarations for the human owner, and merge only
once the owner has explicitly approved this PR —
see CONTRIBUTING.md#pull-request-ownership-and-readiness.
-->

## Summary

<!-- What problem does this solve for a user, an agent, or a maintainer? Link the
issue with "Fixes #123" when applicable. Keep the prior behaviour, the expected
contract, and the new behaviour understandable without private context. -->

## Problem and expected behavior

<!-- For fixes, give the smallest trigger and the invariant it violated. For
features, describe the use case and the observable outcome. -->

## Change and scope

<!-- Explain the chosen approach, why it fits uvp's architecture, and what is
intentionally not included.

Read the contribution scope in CONTRIBUTING.md before filling this in.
Unresolved scope, authority, or side-effect questions block integration. A new
provider, or anything that reaches outside the local machine, needs an explicit
maintainer scope decision linked here; an ordinary fix within existing
boundaries may say "not applicable". Draft PRs may leave this pending. -->

## Contract and boundary impact

<!-- Short answers are welcome. Complete the applicable lines; mark anything you
did not establish as "unknown". Use "none" or "not applicable" only when you
established it. -->

- Earliest changed layer (`domain` / `contracts` / `application` / `toolchains` / adapters):
- Tool contract changes, and whether `docs/public/tool-catalog.json` was regenerated:
- libuvcpp feature mapping changes (which file and line establishes the new claim):
- Generated-code impact (templates, `CMakeLists.txt`, or the emitted `main.cpp`):
- Evidence, unknown, or error-contract semantics:
- Generated metadata, package, or installation impact:

Expected effects (check the ones this change can produce). Unchecked items do not
establish absence — leave uncertainty visible.

- [ ] Read files on the local filesystem.
- [ ] Write files, including generated workspaces and build directories.
- [ ] Compile or link C++ via CMake.
- [ ] Start or stop a process.
- [ ] Open a listening socket.
- [ ] Make an outbound network request.
- [ ] Record or persist captured traffic.
- [ ] Documentation or usability only; no runtime effect.
- [ ] Not sure yet; needs maintainer guidance.

## Evidence and regression coverage

<!-- State whether each claim is observed, derived, or proposed. For a fix, show
the original failure and explain how the regression would fail on the affected
base revision when practical. Include the most useful proof inline; link long
logs or artifacts. Documentation-only changes can cite the source or a rendered check. -->

- Tests added or updated:
- Base reproduction or other evidence:
- The exact command a reviewer can run to see this themselves:
- Remaining proof gaps:

For evidence-bearing changes:

- [ ] Observed, derived, and inferred claims remain distinguishable in the output.
- [ ] Coverage that was not examined is reported as `unknown`, not `complete`.
- [ ] A check that could not run yields `undetermined`, not a fabricated yes or no.
- [ ] Resource kinds and provenance survive the boundary unchanged.

## Validation performed

<!-- List only commands that actually ran, with observed results. A command
without its result is incomplete. If a real toolchain was unavailable, say which
lane was skipped and why rather than implying it passed. -->

- `command` — result

- [ ] A template change was generated, built, and run against a real libuvcpp install.
- [ ] Not applicable (no template or libuvcpp-facing change).

## Compatibility, safety, and release

<!-- Call out breaking changes, the libuvcpp version floor, platform limits,
network exposure, and meaningful proof gaps. -->

- Breaking changes or migration steps:
  <!-- For ! / BREAKING CHANGE: show a previously valid call or configuration, its
  new behaviour, and the migration. Every release increments minor while uvp is
  pre-1.0, including for breaking changes. See docs/releasing.md. -->
- libuvcpp version floor impact:
- New network exposure or listening behaviour:
- Package or release metadata impact:

## Author readiness

<!-- The human owner completes these declarations before requesting review. The
PR author is the owner by default; a different owner must explicitly accept
ownership on this PR.

Agents must leave these unchecked and must not dictate or attest to them. A
readiness check validates that the declarations were filled in; it cannot verify
that human review occurred. See CONTRIBUTING.md#pull-request-ownership-and-readiness. -->

Human owner: <!-- @GitHub-handle -->

- [ ] I reviewed the final diff and relevant existing code, understand the change and its edge cases, and take responsibility for the complete PR, including AI-assisted work.
- [ ] I checked the evidence above, confirmed it supports the current change, and recorded meaningful validation gaps.
- [ ] I declare this PR ready for initial maintainer review.

## Before merge

<!-- Draft PRs may leave pending items unchecked. -->

- [ ] This PR addresses a concrete problem or an agreed enhancement.
- [ ] Material scope and authority questions are resolved, and any required maintainer scope decision covers the final diff.
- [ ] The PR has one focused outcome and the title follows `type(scope): outcome`.
- [ ] Related issue is linked, or the reason for not linking one is stated above.
- [ ] Tests cover the changed observable behaviour and its meaningful failure paths.
- [ ] Owning docs, contracts, and generated metadata are updated where needed.
- [ ] User-visible CLI or MCP changes include representative output.
- [ ] I checked the final diff for secrets, unrelated cleanup, and unsupported claims.
