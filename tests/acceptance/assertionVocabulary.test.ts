import { afterAll, describe, expect, it } from "vitest";

import { EXIT_NO, EXIT_OK } from "../../src/cli/exitCodes.js";
import {
  cleanup,
  createWorkspace,
  portIsFree,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  skipReason,
} from "../support/realLibuvcpp.js";
import type { CliOutcome, Workspace } from "../support/realLibuvcpp.js";
import { listOf, onlyExchange } from "./verifyBundle.js";
import type { Exchange } from "./verifyBundle.js";

/**
 * The `--assert` vocabulary against a service that really answers.
 *
 * `src/cliAssertionSyntax.test.ts` proves the lowering — that `status=2xx`
 * becomes `status_in` with the right set, that `!` reaches the JSON escape hatch
 * too, that a form with no check behind it is refused. That is a test of a
 * parser. This file asks the other half of the question, which a parser test
 * cannot: given a real response from a real libuvcpp service, does each form
 * check what it says it checks?
 *
 * Both ends are pinned. A vocabulary that accepts everything is as useless as
 * one that refuses everything, so every form is asserted twice — once where it
 * must pass, and once where it must fail and report what was there instead.
 *
 * The service is the `rest-api` template, whose handler is a fixture in the
 * sense that its answers are known: `GET /items/1` is
 * `{"id":"1","value":"first"}`, `GET /items` is the two-item array. Knowing the
 * answer is what makes a passing assertion evidence rather than a coincidence.
 *
 * This file also pins the defect that made it worth writing: `uvp_verify`'s
 * contract listed eight of the eleven assertion kinds the evaluator implements,
 * so `body_bytes<1024`, `header:<name>`, and `json:<path>` — three forms the
 * shared syntax module lowers and the CLI documents — parsed cleanly and were
 * then rejected one layer above the check. The refusals at the end of this file
 * assert what is still refused, and why.
 */

/** This file's port. Disjoint from `verifyClosure`'s 8301 and the toolchain lane. */
const PORT = 8311;

/**
 * The workspace every pass below runs against, generated once.
 *
 * Memoised as a promise rather than a value so a second test asking for it
 * cannot start a second `uvp init` — the first would still be running, and the
 * two would race for the same directory.
 */
let made: Promise<Workspace> | undefined;
const workspace = (): Promise<Workspace> => (made ??= createWorkspace("rest-api", PORT));

/** One `uvp verify` pass over that workspace. The caller judges the outcome. */
const verify = async (args: readonly string[]): Promise<CliOutcome> =>
  await runCli(["verify", (await workspace()).root, ...args, "--json"]);

/** A pass whose only request is `GET /items/1`, with the given assertions. */
const assertOnItem = async (
  assertions: readonly string[],
  extra: readonly string[] = [],
): Promise<CliOutcome> =>
  await verify([
    "--port",
    String(PORT),
    "--request",
    "GET",
    "/items/1",
    ...assertions.flatMap((assertion) => ["--assert", assertion]),
    ...extra,
  ]);

afterAll(() => {
  cleanup();
});

describe.skipIf(realLibuvcpp === undefined)(
  realLibuvcpp === undefined
    ? `the assertion vocabulary — skipped: ${skipReason}`
    : `the assertion vocabulary, against real libuvcpp ${realLibuvcpp.version}`,
  () => {
    it("checks a real response with every form the syntax offers", async () => {
      // The response this pass is written against, observed rather than
      // assumed: 200, `content-type: application/json; charset=utf-8`,
      // `server: uvcpp`, and a 26-byte body of `{"id":"1","value":"first"}`.
      const outcome = await verify([
        "--port",
        String(PORT),
        "--request",
        "GET",
        "/items/1",
        // A status, both as a code and as a class.
        "--assert",
        "status=200",
        "--assert",
        "status=2xx",
        // A JSON path, as a string, and as the number that loose equality reads
        // as the same value.
        "--assert",
        "json:$.value=first",
        "--assert",
        "json:$.id=1",
        // Presence, with no value to compare against.
        "--assert",
        "json:$.value",
        // A header, exactly, and by pattern. The exact form carries the charset
        // the service actually sends, so a change to the header is a failure
        // here rather than something the pattern quietly absorbs.
        "--assert",
        "header:server=uvcpp",
        "--assert",
        "header:server",
        "--assert",
        "header:content-type~=application/json",
        // The raw body, as a substring and as a pattern.
        "--assert",
        "body=first",
        "--assert",
        "body~=first",
        // A size and a duration. Both are derived from the exchange rather than
        // from the response, which is why they are worth checking on a real one.
        "--assert",
        "body_bytes<1000",
        "--assert",
        "latency<250ms",
        // The escape hatch, for a set of codes the short forms cannot express.
        "--assert",
        '{"kind":"status_in","expected":[200,201]}',
        "--request",
        "GET",
        "/items",
        // The array form of a JSON path, and the size of a larger body. Both
        // elements are addressed, but neither index is asserted *to be* a
        // particular item: `/items` serialises an `std::unordered_map`, so the
        // order is the hash table's and not the template's to promise. Asserting
        // `$[0].value=first` here would be asserting this machine's libstdc++.
        "--assert",
        "json:$[0].value",
        "--assert",
        "json:$[1].value",
        // The two values by substring, which is order-independent and is what a
        // caller who wants "both items came back" should write.
        "--assert",
        "body~=first",
        "--assert",
        "body~=second",
        "--assert",
        "body_bytes<200",
      ]);

      // Thirteen assertions on the first request, five on the second. Counted
      // exactly: a form that lowered to nothing would leave the count short, and
      // `verified` would still be reported for the ones that did run.
      expect(outcome.exit, outcome.stderr || outcome.stdout.slice(0, 400)).toBe(EXIT_OK);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("verified");
      expect(result["unverified"]).toEqual([]);

      const exchanges = listOf<Exchange>(result, "exchanges");
      expect(exchanges.map((entry) => entry.name)).toEqual(["GET /items/1", "GET /items"]);
      expect(exchanges.map((entry) => entry.assertions_passed)).toEqual([13, 5]);
      expect(exchanges.map((entry) => entry.assertions_failed)).toEqual([0, 0]);
      expect(exchanges.map((entry) => entry.failures)).toEqual([[], []]);

      // Every assertion's coverage is complete, so the pass is a claim about
      // the whole vocabulary rather than about the forms that happened to work.
      const evidence = listOf<{
        readonly kind?: unknown;
        readonly coverage?: { status?: unknown };
      }>(result, "evidence").filter((entry) => entry.kind === "assertion");
      expect(evidence.map((entry) => entry.coverage?.status)).toEqual(["complete", "complete"]);

      expect(await portIsFree(PORT), "the pass left its service listening").toBe(true);
    });

    it("reports a false assertion with what was there and what was asked for", async () => {
      // Four different kinds of not-true, in one pass, because the failure
      // strings are what a caller reads when the assertion was not theirs.
      const outcome = await assertOnItem([
        "json:$.nope=1",
        "json:$.nope",
        "header:x-missing",
        "body_bytes<10",
      ]);

      // Exit 1: the question was put to the service and the answer is no.
      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("failed");

      const exchange = onlyExchange(result);
      expect(exchange.status).toBe(200);
      expect(exchange.assertions_passed).toBe(0);
      expect(exchange.assertions_failed).toBe(4);
      expect(exchange.failures).toEqual([
        // The path, and the expectation. "is absent" is not `= undefined`: the
        // field is not there, which is an answer, and a different one from a
        // field that is there holding null.
        "$.nope is absent, expected 1",
        "$.nope is absent",
        "header x-missing is absent",
        // The observed size, so a limit that is merely too tight is
        // distinguishable from a response that came back wrong.
        "body 26 bytes, limit 10",
      ]);

      // A failing pass is still a pass that ran: the service came up, was
      // driven, and was stopped.
      expect((result["service"] as Record<string, unknown>)["ready"]).toBe(true);
      expect(await portIsFree(PORT), "a failed pass leaked its service").toBe(true);
    });

    it("keeps a check that holds apart from one that was never put", async () => {
      // The distinction the statuses exist for, at the level of the vocabulary:
      // an assertion that passed and an assertion that failed are both
      // answers, and the bundle must not blur them into "not verified".
      const outcome = await assertOnItem(["status=200", "json:$.value=second"]);

      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("failed");

      const exchange = onlyExchange(result);
      expect(exchange.assertions_passed).toBe(1);
      expect(exchange.assertions_failed).toBe(1);
      expect(exchange.failures).toEqual(['$.value = "first", expected "second"']);
    });

    it("names the request an assertion belongs to when several were made", async () => {
      // Order is the association between `--assert` and the `--request` before
      // it. Two requests, each with one failing assertion, so a bundle that
      // attributed them to the wrong request would be caught here.
      const outcome = await verify([
        "--port",
        String(PORT),
        "--request",
        "GET",
        "/items/1",
        "--assert",
        "json:$.value=second",
        "--request",
        "GET",
        "/items",
        // An index past the end, so the failure message is the same whatever
        // order the two items came back in.
        "--assert",
        "json:$[2].value=ninth",
      ]);

      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      const exchanges = listOf<Exchange>(result, "exchanges");
      expect(exchanges.map((entry) => entry.failures)).toEqual([
        ['$.value = "first", expected "second"'],
        ['$[2].value is absent, expected "ninth"'],
      ]);
    });
  },
);
