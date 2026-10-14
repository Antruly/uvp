/**
 * Validate the author-readiness declaration on a pull request.
 *
 * This gate checks one thing: that a **human** has put their name on the change
 * and marked the readiness declarations. It deliberately does not check code
 * quality, does not read the diff, and does not care whether the work was
 * AI-assisted.
 *
 * The reason it exists at all is that the failure it prevents is invisible in a
 * green CI run. A change can compile, pass every test, and still be one nobody
 * has read. uvp's own evidence model treats "not examined" as unknown; this is
 * the same rule applied to a pull request.
 *
 * The gate does not run on draft PRs, because a draft is exactly the state where
 * the declaration is expected to be incomplete.
 */

/** The three declarations the human owner must make. */
const READINESS_ITEMS = [
  "I reviewed the final diff and relevant existing code, understand the change and its edge cases, and take responsibility for the complete PR, including AI-assisted work.",
  "I checked the evidence above, confirmed it supports the current change, and recorded meaningful validation gaps.",
  "I declare this PR ready for initial maintainer review.",
];

const OWNER_PATTERN = /^Human owner:\s*(?<owner>\S.*)$/mu;
/** A handle, not a placeholder. `<@GitHub-handle>` and `TBD` do not count. */
const OWNER_HANDLE_PATTERN = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

const normalize = (text) => text.replace(/\r\n/gu, "\n");

/** A checked item, tolerating the casing and spacing people actually type. */
const isChecked = (body, item) => {
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*[-*]\\s*\\[[xX]\\]\\s*${escaped}\\s*$`, "mu").test(body);
};

export const evaluateReadiness = (body) => {
  const normalized = normalize(body ?? "");
  const failures = [];

  const ownerMatch = OWNER_PATTERN.exec(normalized);
  const owner = ownerMatch?.groups?.["owner"]?.trim();
  if (owner === undefined || owner.length === 0) {
    failures.push("`Human owner:` is missing. Name the person accountable for this change.");
  } else if (!OWNER_HANDLE_PATTERN.test(owner)) {
    failures.push(
      `\`Human owner:\` must be a GitHub handle such as \`@octocat\`; found \`${owner}\`. ` +
        "A role, a team, or a placeholder does not identify an accountable person.",
    );
  }

  for (const [index, item] of READINESS_ITEMS.entries()) {
    if (!isChecked(normalized, item)) {
      failures.push(`Author readiness item ${String(index + 1)} is unchecked.`);
    }
  }

  return { ready: failures.length === 0, owner, failures };
};

const isDraft = (pullRequest) => pullRequest.draft === true;

export const runReadinessCheck = async ({ github, context, core }) => {
  const pullRequest = context.payload.pull_request;
  const number = pullRequest?.number ?? Number(context.payload.inputs?.pull_request_number);
  if (!Number.isInteger(number)) {
    core.setFailed("No pull request to check.");
    return;
  }

  const { data } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: number,
  });

  const { head } = data;

  if (isDraft(data)) {
    // A draft is where an incomplete declaration belongs. Report it, do not
    // block it: blocking a draft would push authors to declare readiness before
    // they are ready, which is the opposite of what this gate is for.
    await github.rest.repos.createCommitStatus({
      owner: context.repo.owner,
      repo: context.repo.repo,
      sha: head.sha,
      state: "success",
      context: "readiness/human-owner",
      description: "Draft PR; the author readiness declaration is not required yet.",
    });
    return;
  }

  const { ready, owner, failures } = evaluateReadiness(data.body);
  const description = ready
    ? `Owned by ${String(owner)}; author readiness declared.`
    : (failures[0]?.slice(0, 140) ?? "Author readiness is incomplete.");

  await github.rest.repos.createCommitStatus({
    owner: context.repo.owner,
    repo: context.repo.repo,
    sha: head.sha,
    state: ready ? "success" : "failure",
    context: "readiness/human-owner",
    description,
    ...(ready
      ? {}
      : {
          target_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/main/CONTRIBUTING.md#pull-request-ownership-and-readiness`,
        }),
  });

  if (ready) {
    core.notice(`Author readiness declared by ${String(owner)}.`);
    return;
  }

  core.setFailed(
    [
      "The author readiness declaration is incomplete:",
      ...failures.map((failure) => `  - ${failure}`),
      "",
      "This gate records that a person has taken responsibility for the change.",
      "It is not a judgment about how the change was produced. See CONTRIBUTING.md.",
    ].join("\n"),
  );
};
