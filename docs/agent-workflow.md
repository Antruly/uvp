# AI development workflow

This page is the operating workflow for AI-assisted development in uvp. It is
normative for every agent and every human contributor who works with one. It
refines [CONTRIBUTING.md](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md) and [GOVERNANCE.md](https://github.com/Antruly/uvp/blob/main/GOVERNANCE.md);
it does not replace them. If this page and either of those documents disagree,
those documents win, and the disagreement is a bug in this page.

The repository's premise is that an agent may do the work, but a human owns the
result. The workflow below exists to make that true in practice: one owner per
task, one branch per issue, evidence instead of assertion, and a human approval
before anything reaches `main`.

## Roles

The roles are duties, not job titles. One person or agent may hold more than one
role in a small change, but the duties do not disappear when roles are combined.

| Role | Accountable for | May | Must not |
| --- | --- | --- | --- |
| **Author / maintainer** (human) | Scope, final direction, approval, and the human-owner declaration | Decide scope; review the final diff; approve a specific PR; complete the Author readiness declaration; merge or authorize a merge | Delegate the approval decision to an agent |
| **Direction lead** | Requirements, priority, decomposition, the work register, and cross-task conflicts | Triage issues; assign an owner; split a batch into module-sized tasks; record questions and decisions; propose a merge order | Approve, merge, check the Author readiness declaration, or take over another owner's branch |
| **Development agent** (`dev-ai-1`, `dev-ai-2`, `dev-ai-3`) | One assigned issue at a time: implementation, tests, evidence, and the PR | Create the issue's branch and draft PR; run validation; answer review findings; keep the PR body current | Work on an unassigned issue; edit another owner's branch; approve or merge; claim a result it did not observe |
| **Review agent** | An independent review of the diff against the issue and the repository rules | Read the diff and surrounding code; run checks; post blocking and non-blocking findings; request changes | Rewrite the implementation; approve; merge; take over the issue |
| **Author proxy assistant** | Collecting approval items for the author and carrying out the author's explicit decision | Prepare an approval packet; add required labels; report status; merge a specific PR after the author's explicit approval at the reviewed commit | Choose what to approve; approve or attest to human review; complete the Author readiness declaration; push to `main`; merge without a per-PR approval |
| **Contributor** (human or agent) | A proposed issue, design discussion, or PR | Propose work; comment with evidence; own a PR if a human accepts ownership | Bypass triage, ownership, review, or the human gate |

### The author is the only approver

The author is the human of record. An agent must not submit a GitHub review
approval, even when it operates the maintainer's account. A green CI run is
evidence; it is not approval.

### The author proxy assistant is the only approval collector

Other agents do not ask the author for a merge decision. They report a ready PR
to the direction lead and the proxy assistant. The proxy assistant is the single
queue that turns ready work into an approval packet for the author.

The proxy assistant may merge **only** after the author has explicitly approved
that PR, on that PR, at the commit the author reviewed. An approval does not
carry to another PR, and it does not survive a new commit. If the approval is
ambiguous, the assistant asks; it does not infer.

### The human-owner declaration stays human

The PR template's **Author readiness** declarations and the `Human owner:` line
are the author's. The author completes them. An agent must not tick them, fill
them in, or attest to human review on the author's behalf. This is the rule in
[CONTRIBUTING.md](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md#pull-request-ownership-and-readiness) and
the `readiness/human-owner` gate enforces it. If the author wants to change that
division, it is a governance change of its own — not a workflow shortcut.

## One owner per task, and no cross-task takeover

Every issue has exactly one owner. The owner is recorded on the issue, in the
work register, and on the PR. If two agents could plausibly own it, the
direction lead splits the issue until one owner can finish it.

A development agent works only on its assigned issue. This is deliberate: the
repository is small enough that uncoordinated parallel edits collide, and broad
enough that "everyone helps" produces duplicated interpretation and competing
PRs.

When an agent is affected by another owner's task, it may comment on that issue
or PR. The comment must:

- name the affected behaviour and the evidence, not a preference;
- name the owner and the specific decision or change needed;
- stop there.

The owner decides and follows up. The commenting agent does not edit the other
branch, open a competing PR, or take over the review. "I was affected" is not an
ownership transfer. If the owner is unavailable, the direction lead records the
blocker and escalates; another agent takes over only through a new assignment.

This rule applies to review as well. A review finding belongs to the PR owner to
fix, unless the owner and direction lead explicitly agree to reassign it.

## Task lifecycle

```
proposal -> triage -> assigned -> in progress -> in review
         -> awaiting author -> approved -> merged -> verified/closed
```

| State | Entry condition | Who moves it |
| --- | --- | --- |
| Proposed | An issue or design discussion exists | Anyone |
| Triaged | Scope, duplicate check, priority, and design need are recorded | Direction lead |
| Assigned | One owner and acceptance criteria are named | Direction lead |
| In progress | Branch exists; draft PR opens early | Owner |
| In review | Draft PR is ready for the review agent; validation evidence is current | Owner |
| Awaiting author | Review has no unresolved blocking finding; approval packet is complete | Proxy assistant |
| Approved | Author has explicitly approved that PR at that commit | Author |
| Merged | Proxy assistant merged under the recorded approval | Proxy assistant |
| Verified / closed | Post-merge checks on `main` passed; follow-ups filed; issue closed | Owner and direction lead |

A blocked task is still owned. Mark it blocked, record the reason and the next
probe, and keep the owner. Do not silently stall, and do not let another agent
"help" by pushing to the branch.

## Issue requirements

Use the repository's issue forms. An issue is ready for assignment when it has:

- one observable problem or one decision, not a bundle;
- the smallest reproduction or the source location that establishes the claim;
- the expected behaviour and the contract or rule it rests on;
- the affected layer and the expected effects;
- a named owner and an acceptance test;
- open questions recorded as questions, not converted into assumptions.

A bug fix must not smuggle in a scope change. New tools, providers, contract or
error-vocabulary changes, new effects, credentials, remote execution, and
breaking changes need a design discussion first. The fail-closed rule applies:
while a material scope, authority, effect, or verification question is open, the
change is not merged.

## Branch and pull request rules

- One branch per issue, named after it: `fix/<issue>-<slug>`,
  `feat/<issue>-<slug>`, `docs/<issue>-<slug>`, or `ci/<issue>-<slug>`.
- One PR per branch, against `main`. Never push to `main` directly.
- Open the PR as a draft as soon as the work has a shape. A draft is where an
  incomplete readiness declaration belongs.
- Use a Conventional Commit PR title: `type(scope): imperative outcome`.
- Link the issue with `Fixes #N` or `Closes #N`.
- Complete the PR template's sections. Leave the **Author readiness** section for
  the author. Mark anything not established as `unknown`; do not write
  "not applicable" unless it was established.
- Add the `ai-assisted` label when AI involvement is substantial.
- Add `Assisted-by: <tool-name>` to every commit produced with an agent.
- Keep the PR body and validation current as the work changes. A stale PR body is
  a false claim about the diff.
- If the scope grows, stop and split it into a new issue. Do not grow the PR.
- Do not force-push another owner's branch. If your own branch needs a rebase
  after another PR merges, rebase it and re-run the checks that cover the change.

## Review

The review agent reviews against the issue and the repository rules, not personal
style. A review is complete when it answers:

- Does the change solve the stated problem, and only that problem?
- Does the test fail without the change and pass with it?
- Is every claim labelled observed, derived, inferred, or unknown?
- Does a check that could not run report `undetermined`, rather than a fabricated
  yes or no?
- Are ownership, cleanup, bounds, and provenance preserved?
- Are the contract, generated catalog, schema, docs, and package metadata
  updated where the change requires them?
- Are effects, credentials, network exposure, and scope still within the
  contribution boundary?
- Is the diff free of secrets, unrelated cleanup, and unsupported claims?

Findings are posted on the PR as blocking, non-blocking, or question. A blocking
finding must be resolved or explicitly accepted by the author before the PR is
presented for approval. The review agent does not rewrite the code, does not
approve, and does not merge.

## Evidence and validation

The repository's evidence rules are not optional for agents:

- Never report `complete` for a scope that was not examined.
- Never report a feature as absent when the check could not run.
- Never claim a runtime observation that was not observed.
- Never derive a capability claim from a version number when a configuration
  header or installed header is available.
- Report the commands that actually ran, with their results. A command without a
  result is incomplete.
- A skipped lane names its reason. A skipped test and a passing test must not look
  alike.

For a bug fix, the PR states the reproduction on the base revision and the test
that is red before and green after. For a template or toolchain change, the
generated workspace is built and run against real libuvcpp, or the PR says which
lane could not run and why.

## Approval and merge

1. The owner opens a draft PR and keeps it current.
2. The review agent reviews. Blocking findings go back to the owner.
3. When the review is clean, the owner reports the PR to the direction lead and
   the proxy assistant.
4. The proxy assistant prepares an approval packet (template below) and adds any
   missing disclosure labels or trailers.
5. The author reviews the packet and the PR, completes the **Author readiness**
   declarations, marks the PR ready, and comments an explicit approval naming the
   PR and the reviewed commit, for example:
   `Approved for merge at <sha>.`
6. The proxy assistant merges that PR only, at that commit. If a new commit lands,
   the approval is stale and the author is asked again.
7. After merge, the owner verifies the relevant `main` lane, files follow-ups for
   anything out of scope, and the issue closes through the PR.

The proxy assistant must refuse to merge when:

- the approval is missing, ambiguous, or for a different commit;
- a blocking review finding is unresolved;
- a required check is red or still pending;
- the PR is still a draft without the author's readiness declaration;
- the diff changed after the approval;
- the merge would bypass branch protection or push to `main` directly.

## Upstream dependencies and libuvcpp

uvp is a control plane over libuvcpp; the two repositories have separate
ownership. When a defect is in libuvcpp itself:

- do not patch libuvcpp inside uvp, and do not vendor a modified copy into uvp or
  into generated code;
- file the issue or a fix PR in the libuvcpp repository, with the reproduction,
  the affected version, and the observation that establishes the defect;
- keep or open the uvp-side issue as the tracking record, link the upstream item,
  and state what uvp can still observe, skip, or work around;
- the maintainer decides whether uvp waits, works around, narrows the claim, or
  changes scope. An agent does not make that direction decision.

For any other upstream dependency (a Node package, CMake, a compiler, Stryker, an
operating-system behaviour), the same rule applies: the fix belongs upstream where
possible. A uvp issue may track it, with a link and a recheck condition, but uvp
does not fork or silently patch the dependency. If a local workaround is
unavoidable, it is an explicit, reviewed change that cites the upstream item and
states when the workaround can be removed.

## Blockers, dependencies, and merge order

The direction lead maintains a dependency map for PRs that touch the same file or
depend on the same interpretation. Common examples are two PRs that edit the same
module, one PR that needs another's type, and a PR that changes a generated
artifact another PR also regenerates.

When PRs overlap:

- record the dependency in both PRs and in the work register;
- decide the merge order before the author approves either;
- merge the first PR, then rebase the second and re-run its checks;
- the second owner does the rebase; the first owner does not merge the second PR.

A PR that is blocked on an upstream project is recorded with the upstream link
and a recheck condition. It is not "almost done", and no agent claims it as work
in progress.

## Status reporting

The direction lead keeps a work register with one row per issue/PR:
module, issue, PR, owner, state, checks, blocker, next action, and whether the
author must decide something.

The register is the shared answer to "what is done, what is in review, what is
blocked, and what needs the author". It is updated when a PR changes state, not
only at the end of a batch.

The proxy assistant reports the approval queue to the author. The review agent
reports the review queue to the direction lead. Development agents report status
on their own issue/PR; they do not broadcast to every other task.

## Definition of done

A task is done when:

- the issue is linked and closed by the PR;
- a test that fails without the change passes with it, or the PR explains why the
  stronger workflow was unavailable;
- the PR records the commands that ran and their observed results;
- the contract, generated metadata, docs, and package files are updated where
  required;
- no blocking review finding remains;
- the author has completed the readiness declaration and explicitly approved the
  merge;
- the relevant `main` lane is green after the merge;
- out-of-scope findings have follow-up issues rather than silent scope growth.

## Questions and feedback

Every unresolved question is recorded in the issue or PR that depends on it, with
the owner and what would answer it. If the question needs the author, the
direction lead labels it for the proxy assistant and includes it in the approval
packet. Decisions are recorded in the same thread; a decision made in a private
conversation is not a repository decision until it is written down.

## Templates

### Approval packet

```markdown
## Approval requested

- PR: #<number> — <title>
- Issue: #<number>
- Module: <domain | contracts | application | toolchains | CLI/MCP | CI/docs>
- Owner: <role / handle>
- Reviewed commit: <sha>
- Draft / ready: <state>

### Diff
- Files: <n> changed, +<additions>/-<deletions>
- Generated files regenerated: <yes/no + which>
- Contract or vocabulary change: <yes/no + migration>

### Evidence
- Checks: <green list; pending/red list>
- Review: <clean / blocking findings>
- Validation commands and results: <exact commands>
- Known gaps / unknowns: <list>

### Risk
- Scope or authority question: <none / decision needed>
- Effects: <read/write/process/listen/network/persist>
- Cross-PR dependency: <none / PR #, merge order>

### Decision requested
Author: <one or two sentences>

### Authorization
After reviewing, comment on the PR:
`Approved for merge at <sha>.`
The author completes the Author readiness declaration; the assistant does not.
```

### Work register

| Module | Issue | PR | Owner | State | Checks | Blocker | Next action | Author decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `module` | `#N` | `#N` | `role` | `state` | `green`/`pending`/`red` | `none`/`reason` | `action` | `yes`/`no` |

## Bootstrap checklist

When this workflow is introduced or a new agent joins:

- [ ] Read [CONTRIBUTING.md](https://github.com/Antruly/uvp/blob/main/CONTRIBUTING.md), [GOVERNANCE.md](https://github.com/Antruly/uvp/blob/main/GOVERNANCE.md),
  and [AGENTS.md](https://github.com/Antruly/uvp/blob/main/AGENTS.md) before this page.
- [ ] Confirm the repository's standing authorization for branches and draft PRs.
- [ ] Create or confirm the role labels (`agent:dev-ai-1`, `agent:dev-ai-2`,
  `agent:dev-ai-3`, `role:review`, `role:author-proxy`, `role:direction-lead`)
  and state labels (`status:in-review`, `status:awaiting-author`,
  `status:blocked`, `status:needs-decision`).
- [ ] Add `ai-assisted` and any missing `Assisted-by` trailers to existing
  agent-produced PRs.
- [ ] Assign every open issue to one owner, or mark it blocked or out of scope.
- [ ] Publish the first work register and approval packet.

## Scope of this page

This page defines how work is coordinated. It does not change the product,
the contribution scope, the error contract, the evidence model, or the release
process. Those changes follow their own review and design rules.
