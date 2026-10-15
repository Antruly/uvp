import { describe, expect, it } from "vitest";

import { bundleDigest } from "./VerificationService.js";
import type { VerificationStatus } from "./VerificationService.js";
import { DIGEST_EXCHANGE_FIELDS, diffBundles } from "./bundleDiff.js";
import type { BundleDiff, ComparedBundle, ExchangeField } from "./bundleDiff.js";

/**
 * Comparing two verification passes.
 *
 * The property under test throughout is the one this module exists for: a
 * comparison must not report a difference that is not a change in the subject,
 * and must not hide a difference that is. Both directions cost something — a
 * diff that calls two equal passes "changed" is noise a caller learns to ignore,
 * and one that calls a moved assertion "identical" is a false all-clear — so the
 * fixtures mint a fresh id, timing, run id and port for every single pass, and
 * every test that expects `identical` is asserting that none of those is
 * compared.
 */

const DEFAULT_WORKSPACE = "wsp_abcdefghijklmnopqrstuv";

/**
 * The identifiers and clocks of both passes, minted from one counter so they
 * never collide, and never asserted on: a test that pinned them would be
 * describing the fixture rather than the comparison.
 */
let minted = 0;
const mintedNow = (prefix: string): string => `${prefix}_${String((minted += 1))}`;
let port = 8100;
const nextPort = (): number => (port += 1);

interface ExchangeSpec {
  readonly name: string;
  /** Absent means the request got no response at all, which is not status 0. */
  readonly status?: number | undefined;
  /** The version that answered. Absent for the same reason `status` is. */
  readonly http_version?: string | undefined;
  readonly passed?: number | undefined;
  readonly failed?: number | undefined;
  readonly failures?: readonly string[] | undefined;
}

interface PassSpec {
  readonly status?: VerificationStatus | undefined;
  readonly workspace_id?: string | undefined;
  readonly goal?: string | undefined;
  readonly build?: { succeeded: boolean; exit_code: number } | undefined;
  readonly ready?: boolean | undefined;
  readonly exchanges?: readonly ExchangeSpec[] | undefined;
  readonly unverified?: readonly { question: string; reason: string }[] | undefined;
  /** Supplied instead of the digest the contents produce, to build a broken record. */
  readonly digest?: string | undefined;
}

const pass = (spec: PassSpec = {}): ComparedBundle => {
  const status = spec.status ?? "verified";
  const exchanges = (spec.exchanges ?? []).map((entry) => ({
    name: entry.name,
    exchange_id: mintedNow("ex"),
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.http_version === undefined ? {} : { http_version: entry.http_version }),
    elapsed_ms: minted++,
    assertions_passed: entry.passed ?? 1,
    assertions_failed: entry.failed ?? 0,
    failures: [...(entry.failures ?? [])],
  }));
  const unverified = (spec.unverified ?? []).map((entry) => ({ ...entry }));

  return {
    ...(spec.goal === undefined ? {} : { goal: spec.goal }),
    workspace_id: spec.workspace_id ?? DEFAULT_WORKSPACE,
    bundle_id: mintedNow("bnd"),
    bundle_digest: spec.digest ?? bundleDigest({ status, exchanges, unverified }),
    status,
    build: spec.build ?? { succeeded: true, exit_code: 0 },
    service: {
      run_id: mintedNow("run"),
      ready: spec.ready ?? true,
      endpoint: `http://127.0.0.1:${String(nextPort())}`,
    },
    exchanges,
    unverified,
  };
};

/** A pass that asked exactly one request. */
const oneExchange = (entry: ExchangeSpec): ComparedBundle => pass({ exchanges: [entry] });

const compare = (
  before: ComparedBundle,
  after: ComparedBundle,
  includeUnchanged = false,
): BundleDiff => diffBundles(before, after, { includeUnchanged });

/** The exchanges of a result as compact tuples: what the report says about each. */
const shape = (entries: readonly { name: string; change: string }[]): [string, string][] =>
  entries.map((entry) => [entry.name, entry.change]);

/** The same, for the unanswered questions, which are keyed by the question. */
const asked = (entries: readonly { question: string; change: string }[]): [string, string][] =>
  entries.map((entry) => [entry.question, entry.change]);

describe("what is reported and never compared", () => {
  it("calls two passes that established the same things identical, whatever their ids and clocks say", () => {
    const before = oneExchange({ name: "hello", status: 200 });
    const after = oneExchange({ name: "hello", status: 200 });

    // The fixtures guarantee the difference: each pass carries its own bundle
    // id, exchange id, elapsed time, run id and endpoint.
    expect(before.bundle_id).not.toBe(after.bundle_id);
    expect(before.service.endpoint).not.toBe(after.service.endpoint);

    const result = compare(before, after);
    expect(result.outcome).toBe("identical");
    expect(result.comparable).toBe(true);
    expect(result.same_digest).toBe(true);
    expect(result.status_changed).toBe(false);
    expect(result.order_changed).toBe(false);
    expect(result.exchanges.unchanged).toBe(1);
    expect(result.exchanges.entries).toEqual([]);
    expect(result.limitations).toHaveLength(2);
  });

  it("names the fields it looked at and chose not to judge", () => {
    // The list is the answer to "why is this identical when the two files
    // differ?", so it has to be in the result rather than in the reader's head.
    const result = compare(pass(), pass());
    expect(result.not_compared).toEqual([
      "bundle_id",
      "exchange_id",
      "elapsed_ms",
      "service.run_id",
      "service.endpoint",
    ]);
  });

  it("reports the run id and the endpoint without letting them make a difference", () => {
    const result = compare(pass(), pass());
    expect(result.service.changed).toBe(false);
    expect(result.service.before.endpoint).toBeDefined();
    expect(result.service.after.endpoint).toBeDefined();
    expect(result.service.before.endpoint).not.toBe(result.service.after.endpoint);
    expect(result.outcome).toBe("identical");
  });
});

describe("the verdict and the evidence behind it", () => {
  it("reports a moved assertion as a change in the verdict", () => {
    const before = oneExchange({ name: "hello", status: 200, passed: 2, failed: 0 });
    const after = pass({
      status: "failed",
      exchanges: [
        {
          name: "hello",
          status: 200,
          passed: 1,
          failed: 1,
          failures: ["status_equals: expected 500, got 200"],
        },
      ],
    });

    const result = compare(before, after);
    expect(result.outcome).toBe("changed");
    expect(result.digest_consistent).toEqual({ before: true, after: true });
    expect(result.same_digest).toBe(false);
    expect(shape(result.exchanges.entries)).toEqual([["hello", "changed"]]);
    expect(result.exchanges.entries.map((entry) => entry.changed_fields)).toEqual([
      ["assertions_passed", "assertions_failed", "failures"],
    ]);
    expect(result.exchanges.entries.map((entry) => entry.verdict_changed)).toEqual([true]);
    expect(result.exchanges.entries.at(0)?.before?.assertions_passed).toBe(2);
    expect(result.exchanges.entries.at(0)?.after?.failures).toEqual([
      "status_equals: expected 500, got 200",
    ]);
    expect(result.status_changed).toBe(true);
  });

  it("reports a failure whose text moved as changed, and says the digest cannot see it", () => {
    // The digest covers the verdict and not the sentence explaining it, so this
    // is the case where `same_digest: true` sits beside `changed` — the one a
    // reader would otherwise read as a bug in the comparison.
    const before = pass({
      status: "failed",
      exchanges: [
        { name: "hello", status: 500, passed: 0, failed: 1, failures: ["status: got 500"] },
      ],
    });
    const after = pass({
      status: "failed",
      exchanges: [
        {
          name: "hello",
          status: 500,
          passed: 0,
          failed: 1,
          failures: ["status: the service answered 500 instead of 200"],
        },
      ],
    });

    const result = compare(before, after);
    expect(result.outcome).toBe("changed");
    expect(result.same_digest).toBe(true);
    expect(result.exchanges.entries.map((entry) => entry.changed_fields)).toEqual([["failures"]]);
    expect(result.exchanges.entries.map((entry) => entry.verdict_changed)).toEqual([false]);
    expect(DIGEST_EXCHANGE_FIELDS).not.toContain("failures");
    expect(result.limitations.some((line) => line.includes("digests agree"))).toBe(true);
  });

  it("calls two passes identical when the same assertion failed the same way", () => {
    const failures = ["status_equals: expected 200, got 500"];
    const result = compare(
      oneExchange({ name: "hello", status: 500, passed: 0, failed: 1, failures }),
      oneExchange({ name: "hello", status: 500, passed: 0, failed: 1, failures }),
    );
    expect(result.outcome).toBe("identical");
    expect(result.same_digest).toBe(true);
  });

  it("treats no response and status zero as the same finding, which is what the digest does", () => {
    // `bundleDigest` maps a missing status to 0, so the two are one verdict to
    // it and two different records to a reader. Both facts are reported instead
    // of one being chosen: `changed_fields` names `status` and `verdict_changed`
    // says the digest cannot see the difference.
    const result = compare(
      oneExchange({ name: "hello" }),
      oneExchange({ name: "hello", status: 0 }),
    );
    expect(result.outcome).toBe("changed");
    expect(result.same_digest).toBe(true);
    expect(result.exchanges.entries.map((entry) => entry.changed_fields)).toEqual([["status"]]);
    expect(result.exchanges.entries.map((entry) => entry.verdict_changed)).toEqual([false]);
    expect(result.exchanges.entries.at(0)?.before?.status).toBeUndefined();
    expect(result.exchanges.entries.at(0)?.after?.status).toBe(0);
  });

  it("reports the protocol two otherwise identical passes ran over", () => {
    // The read this field exists for. The same assertions, the same service, the
    // same verdict — reached once over HTTP/1.1 and once over HTTP/2. Nothing a
    // caller asserted moved, so the digest agrees; the transport did, so a reader
    // is told which side was which rather than having to go back to the two
    // command lines.
    const result = compare(
      oneExchange({ name: "hello", status: 200, http_version: "1.1", failures: [] }),
      oneExchange({ name: "hello", status: 200, http_version: "2.0", failures: [] }),
    );
    expect(result.outcome).toBe("changed");
    expect(result.same_digest).toBe(true);
    const [hello] = result.exchanges.entries;
    expect(hello?.changed_fields).toEqual(["http_version"]);
    expect(hello?.verdict_changed).toBe(false);
    expect(hello?.before?.http_version).toBe("1.1");
    expect(hello?.after?.http_version).toBe("2.0");
    // And the limitation says why the two digests agree, so `same_digest: true`
    // beside `changed` is explained rather than surprising.
    expect(result.limitations.some((line) => line.includes("digests agree"))).toBe(true);
  });

  it("does not read a request nobody answered as one answered over HTTP/1.1", () => {
    // Absent and `"1.1"` are different records: the first is a request that
    // completed in no protocol, the second is one that completed in a specific
    // one. Compared as the report states them, with no default filled in — the
    // same distinction `status` draws between absent and `0`.
    const result = compare(
      oneExchange({ name: "hello", status: 200 }),
      oneExchange({ name: "hello", status: 200, http_version: "1.1" }),
    );
    expect(result.exchanges.entries.at(0)?.changed_fields).toEqual(["http_version"]);
    expect(result.exchanges.entries.at(0)?.before?.http_version).toBeUndefined();
  });

  it("counts a missing status against a real status as a change in the verdict", () => {
    const result = compare(
      oneExchange({ name: "hello" }),
      pass({ status: "failed", exchanges: [{ name: "hello", status: 503 }] }),
    );
    expect(result.exchanges.entries.map((entry) => entry.verdict_changed)).toEqual([true]);
  });
});

describe("exchanges only one pass asked", () => {
  it("records an exchange the later pass added, with every field named as moved", () => {
    const before = oneExchange({ name: "hello", status: 200 });
    const after = pass({
      exchanges: [
        { name: "hello", status: 200 },
        { name: "bye", status: 200 },
      ],
    });

    const result = compare(before, after);
    expect(result.outcome).toBe("changed");
    expect(shape(result.exchanges.entries)).toEqual([["bye", "added"]]);
    expect(result.exchanges.entries.map((entry) => entry.changed_fields)).toEqual([
      ["status", "http_version", "assertions_passed", "assertions_failed", "failures"],
    ]);
    expect(result.exchanges.entries.at(0)?.after?.status).toBe(200);
    expect(result.exchanges.entries.at(0)?.before).toBeUndefined();
    expect([
      result.exchanges.unchanged,
      result.exchanges.before_count,
      result.exchanges.after_count,
    ]).toEqual([1, 1, 2]);
    // A different *set* is not a reordering. A line about order above a table
    // whose rows are named `added` would say nothing the rows do not.
    expect(result.order_changed).toBe(false);
  });

  it("records an exchange the later pass stopped asking as absent", () => {
    const before = pass({
      exchanges: [
        { name: "hello", status: 200 },
        { name: "bye", status: 200 },
      ],
    });
    const result = compare(before, oneExchange({ name: "hello", status: 200 }));

    expect(shape(result.exchanges.entries)).toEqual([["bye", "absent"]]);
    expect(result.exchanges.entries.at(0)?.before?.status).toBe(200);
    expect(result.exchanges.entries.at(0)?.after).toBeUndefined();
    expect(result.order_changed).toBe(false);
  });
});

describe("order", () => {
  it("reports a reordering of the same requests as a change, with no exchange marked different", () => {
    // The digest hashes the sequence, so ignoring order here would print
    // `identical` beside two different digests.
    const before = pass({
      exchanges: [
        { name: "first", status: 200 },
        { name: "second", status: 200 },
      ],
    });
    const after = pass({
      exchanges: [
        { name: "second", status: 200 },
        { name: "first", status: 200 },
      ],
    });

    const result = compare(before, after);
    expect(result.outcome).toBe("changed");
    expect(result.order_changed).toBe(true);
    expect(result.exchanges.entries).toEqual([]);
    expect([result.exchanges.unchanged, result.exchanges.before_count]).toEqual([2, 2]);
    expect(result.same_digest).toBe(false);
    expect(result.limitations.some((line) => line.includes("different order"))).toBe(true);
  });

  it("reports a reordering of the unanswered questions as a change too", () => {
    const one = { question: "Does /slow hold the connection?", reason: "not_attempted" };
    const two = { question: "Is the pool sized for the load?", reason: "no_basis" };
    const result = compare(pass({ unverified: [one, two] }), pass({ unverified: [two, one] }));
    expect(result.order_changed).toBe(true);
    expect(result.unverified.entries).toEqual([]);
    expect(result.outcome).toBe("changed");
  });

  it("does not treat a question the later pass added as a reordering", () => {
    const one = { question: "Is the pool sized?", reason: "no_basis" };
    const result = compare(
      pass({ unverified: [one] }),
      pass({ unverified: [one, { question: "Is /slow bounded?", reason: "not_attempted" }] }),
    );
    expect(result.order_changed).toBe(false);
    expect(asked(result.unverified.entries)).toEqual([["Is /slow bounded?", "added"]]);
  });
});

describe("unanswered questions", () => {
  it("reports a question only the later pass left open, with the reason it gave", () => {
    const result = compare(
      pass(),
      pass({ unverified: [{ question: "Is /slow bounded?", reason: "not_attempted" }] }),
    );
    expect(asked(result.unverified.entries)).toEqual([["Is /slow bounded?", "added"]]);
    expect(result.unverified.entries.at(0)?.after).toBe("not_attempted");
    expect(result.unverified.entries.at(0)?.before).toBeUndefined();
    // A pass that asserted less is not the same pass, and the digest says so.
    expect(result.same_digest).toBe(false);
  });

  it("reports a question whose reason changed as changed, not as two questions", () => {
    const result = compare(
      pass({ unverified: [{ question: "Is the pool sized?", reason: "no_basis" }] }),
      pass({ unverified: [{ question: "Is the pool sized?", reason: "not_attempted" }] }),
    );
    expect(asked(result.unverified.entries)).toEqual([["Is the pool sized?", "changed"]]);
    expect(result.unverified.entries.at(0)?.before).toBe("no_basis");
    expect(result.unverified.entries.at(0)?.after).toBe("not_attempted");
  });

  it("reports a question the later pass answered as absent", () => {
    const result = compare(
      pass({ unverified: [{ question: "Is /slow bounded?", reason: "not_attempted" }] }),
      pass(),
    );
    expect(asked(result.unverified.entries)).toEqual([["Is /slow bounded?", "absent"]]);
    expect(result.unverified.entries.at(0)?.after).toBeUndefined();
  });

  it("counts the questions that stayed open without listing them", () => {
    const question = { question: "Is the pool sized?", reason: "no_basis" };
    const result = compare(pass({ unverified: [question] }), pass({ unverified: [question] }));
    expect(result.unverified.unchanged).toBe(1);
    expect(result.unverified.entries).toEqual([]);
    expect(result.outcome).toBe("identical");
  });
});

describe("records that cannot be read as one subject", () => {
  it("refuses two passes made in different workspaces", () => {
    const after = pass({
      status: "failed",
      workspace_id: "wsp_zzzzzzzzzzzzzzzzzzzzzz",
      exchanges: [{ name: "hello", status: 500 }],
    });

    const result = compare(oneExchange({ name: "hello", status: 200 }), after);
    expect(result.comparable).toBe(false);
    expect(result.outcome).toBe("incomparable");
    expect(result.incomparable_because).toHaveLength(1);
    expect(result.incomparable_because[0]).toContain(DEFAULT_WORKSPACE);
    expect(result.incomparable_because[0]).toContain("wsp_zzzzzzzzzzzzzzzzzzzzzz");
    // What the outcome withholds is the reading of the fields, not the fields: a
    // record of what each pass said is still worth having.
    expect(shape(result.exchanges.entries)).toEqual([["hello", "changed"]]);
    expect(result.limitations.some((line) => line.includes("withholds"))).toBe(true);
  });

  it("refuses a bundle whose supplied digest does not describe its own contents", () => {
    // Equality between two such digests would be a coincidence, not a finding.
    const tampered: ComparedBundle = { ...pass(), bundle_digest: "0".repeat(64) };

    const result = compare(tampered, oneExchange({ name: "hello", status: 200 }));
    expect(result.digest_consistent).toEqual({ before: false, after: true });
    expect(result.comparable).toBe(false);
    expect(result.incomparable_because[0]).toContain("before bundle's supplied digest");
  });

  it("reports the digest comparison as absent rather than false when it could not be made", () => {
    // `false` would claim two digests were found different. They were not
    // compared at all, and the third state is the honest one.
    const result = compare({ ...pass(), bundle_digest: "f".repeat(64) }, pass());
    expect(result.same_digest).toBeUndefined();
  });

  it("refuses a pass that recorded one exchange name twice", () => {
    // Names key the comparison. A map would keep the last one silently, and a
    // report over a quietly shortened list is worse than a refusal.
    const doubled = pass({
      exchanges: [
        { name: "hello", status: 200 },
        { name: "hello", status: 500 },
      ],
    });

    const result = compare(doubled, oneExchange({ name: "hello", status: 200 }));
    expect(result.comparable).toBe(false);
    expect(result.incomparable_because).toHaveLength(1);
    expect(result.incomparable_because[0]).toContain("hello");
    expect(result.incomparable_because[0]).toContain("more than once");
  });
});

describe("the ask and the build", () => {
  it("reports a different goal without calling it a change in the findings", () => {
    const result = compare(
      pass({ goal: "the endpoint answers", exchanges: [{ name: "hello", status: 200 }] }),
      pass({ goal: "the endpoint answers quickly", exchanges: [{ name: "hello", status: 200 }] }),
    );
    expect(result.goal_changed).toBe(true);
    expect(result.before.goal).toBe("the endpoint answers");
    expect(result.after.goal).toBe("the endpoint answers quickly");
    expect(result.outcome).toBe("identical");
    expect(result.limitations.some((line) => line.includes("the ask rather than a finding"))).toBe(
      true,
    );
  });

  it("reports a build that failed after one that succeeded, which the digest cannot see", () => {
    // Both passes reached the same verdict — nothing was asserted, in both — so
    // their digests agree while the builds that produced them did not, and the
    // comparison is the only artifact that records the difference.
    const result = compare(
      pass({ status: "unknown", build: { succeeded: true, exit_code: 0 } }),
      pass({ status: "unknown", build: { succeeded: false, exit_code: 101 } }),
    );
    expect(result.build).toEqual({
      changed: true,
      before: { succeeded: true, exit_code: 0 },
      after: { succeeded: false, exit_code: 101 },
    });
    expect(result.outcome).toBe("changed");
    expect(result.same_digest).toBe(true);
    expect(result.status_changed).toBe(false);
    expect(result.limitations.some((line) => line.includes("digests agree"))).toBe(true);
  });

  it("reports a service that was ready and then was not", () => {
    const result = compare(pass({ ready: true }), pass({ ready: false }));
    expect(result.service.changed).toBe(true);
    expect(result.service.after.ready).toBe(false);
  });
});

describe("the reading the caller asks for", () => {
  it("lists every exchange when asked, marking the ones that did not move", () => {
    const before = oneExchange({ name: "first", status: 200 });
    const after = pass({
      exchanges: [
        { name: "first", status: 200 },
        { name: "second", status: 200 },
      ],
    });

    const result = compare(before, after, true);
    expect(shape(result.exchanges.entries)).toEqual([
      ["first", "unchanged"],
      ["second", "added"],
    ]);
    expect(result.exchanges.entries.at(0)?.changed_fields).toEqual([]);
    expect(result.exchanges.entries.at(0)?.before).toBeUndefined();
    // The counts are reported either way, so a difference filtered out of the
    // entries is never invisible.
    expect([
      result.exchanges.unchanged,
      result.exchanges.before_count,
      result.exchanges.after_count,
    ]).toEqual([1, 1, 2]);
  });

  it("still counts the questions it left out of the entries", () => {
    const question = { question: "Is the pool sized?", reason: "no_basis" };
    const result = compare(
      pass({ unverified: [question] }),
      pass({ unverified: [question] }),
      true,
    );
    expect(asked(result.unverified.entries)).toEqual([["Is the pool sized?", "unchanged"]]);
    expect(result.unverified.unchanged).toBe(1);
  });
});

describe("the comparison's own bounds", () => {
  it("calls two empty passes identical", () => {
    const result = compare(pass({ status: "unknown" }), pass({ status: "unknown" }));
    expect(result.outcome).toBe("identical");
    expect(result.exchanges).toEqual({
      unchanged: 0,
      before_count: 0,
      after_count: 0,
      entries: [],
    });
    expect(result.limitations).toHaveLength(2);
  });

  it("says of itself that it observed nothing", () => {
    // The one limitation every result carries: a difference here is between two
    // records, not a measurement of the subject now.
    const result = compare(pass(), pass());
    expect(result.limitations.at(0)).toContain("observes nothing itself");
  });

  it("never reports an identical outcome beside a digest it could not read", () => {
    // The invariant a caller reasons from: `identical` means two digests that
    // describe their own contents were found equal, so the outcome can never
    // rest on a digest that was never compared.
    const pairs: [ComparedBundle, ComparedBundle][] = [
      [pass(), pass()],
      [oneExchange({ name: "hello", status: 200 }), oneExchange({ name: "hello", status: 200 })],
      [pass({ goal: "one" }), pass({ goal: "two" })],
      [
        pass({ unverified: [{ question: "q", reason: "no_basis" }] }),
        pass({ unverified: [{ question: "q", reason: "no_basis" }] }),
      ],
      [{ ...pass(), bundle_digest: "0".repeat(64) }, pass()],
    ];
    for (const [before, after] of pairs) {
      const result = compare(before, after);
      if (result.outcome === "identical") expect(result.same_digest).toBe(true);
    }
  });
});

describe("the digest's coverage, checked against what the digest does", () => {
  /**
   * `DIGEST_EXCHANGE_FIELDS` is a hand-written claim about another module's hash,
   * and a claim like that is exactly the kind that goes stale. So it is checked
   * against `bundleDigest` itself: for each field the comparison reads, move that
   * field alone on a copy of an exchange and see whether the digest follows.
   */
  const BASE: ExchangeSpec = {
    name: "hello",
    status: 200,
    http_version: "1.1",
    passed: 1,
    failed: 0,
    failures: [],
  };

  const ALTERED: Readonly<Record<ExchangeField, ExchangeSpec>> = {
    status: { ...BASE, status: 500 },
    http_version: { ...BASE, http_version: "2.0" },
    assertions_passed: { ...BASE, passed: 2 },
    assertions_failed: { ...BASE, failed: 1 },
    failures: { ...BASE, failures: ["status_equals: expected 500, got 200"] },
  };

  const FIELDS_READ: readonly ExchangeField[] = [
    "status",
    "http_version",
    "assertions_passed",
    "assertions_failed",
    "failures",
  ];

  const base = oneExchange(BASE);
  const digestOf = (entry: ExchangeSpec): string => bundleDigest(oneExchange(entry));

  it.each(FIELDS_READ)("agrees with bundleDigest about whether %s is in it", (field) => {
    const digestFollowed = digestOf(BASE) !== digestOf(ALTERED[field]);
    // A field the digest does not read must leave it untouched; a field it does
    // read must move it. Anything else is a coverage claim nothing supports.
    expect(digestFollowed).toBe(DIGEST_EXCHANGE_FIELDS.includes(field));
  });

  it("names exactly the fields the digest reads", () => {
    expect(DIGEST_EXCHANGE_FIELDS).toEqual(["status", "assertions_passed", "assertions_failed"]);
    // And the fixture the check above rests on: moving `failures` alone leaves
    // the digest where it was, which is what makes the pairing in the tool's
    // output (`same_digest: true` beside `changed`) possible at all.
    expect(digestOf(BASE)).toBe(digestOf(ALTERED.failures));
    // `http_version` is the second such field, and the reason it is one: the same
    // assertions asked over HTTP/1.1 and over HTTP/2 reach the same verdict, so
    // they have to hash the same — while the comparison still reports that the
    // two passes were different experiments.
    expect(digestOf(BASE)).toBe(digestOf(ALTERED.http_version));
    expect(base.bundle_digest).toBe(digestOf(BASE));
  });
});
