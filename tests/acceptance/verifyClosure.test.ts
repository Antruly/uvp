import { afterAll, describe, expect, it } from "vitest";

import { EXIT_NO, EXIT_OK, EXIT_WRONG } from "../../src/cli/exitCodes.js";
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
import type { Exchange, Observation } from "./verifyBundle.js";

/**
 * The whole closure, on a real service: configure, compile, launch, drive,
 * assert, stop, report — and the four verdicts it can end in.
 *
 * `toolchain` proves the generated projects work; `process-boundary` proves uvp
 * supervises processes; `services` proves the verification workflow's logic
 * against injected providers. This file is the join: one `uvp verify` per
 * verdict, against a service that is really listening, with the status, the exit
 * code, and the evidence checked together — because those three are one claim.
 *
 * The status vocabulary is the product's most load-bearing sentence, and the
 * distinction worth this file's size is `unknown` against `failed`:
 *
 * | Status     | What it means                        | Exit |
 * | ---------- | ------------------------------------ | ---- |
 * | `verified` | every assertion evaluated and passed | 0    |
 * | `failed`   | something was evaluated and was not  | 1    |
 * | `partial`  | something was never evaluated        | 1    |
 * | `unknown`  | nothing could be evaluated           | 2    |
 *
 * Collapsing `unknown` into `failed` would make `verified` untrustworthy in
 * exactly the case where a caller leans on it hardest: "the assertion did not
 * hold" and "I could not put the assertion to the service" call for different
 * next steps, and only one of them means the service is wrong.
 *
 * **One workspace, four passes.** All four verdicts are asked of the same
 * `rest-api` service, reusing one port, which is what a caller does — build,
 * verify, adjust, verify again. Two consequences are deliberate: the verdicts
 * differ only in what was asked, never in the workspace, and rebinding the port
 * after a pass is itself exercised (uvp's own service is stopped by the pass, so
 * a leaked process would show up here as a `not ready` on the next one).
 *
 * Skip-with-a-reason applies as it does in the toolchain lane: without libuvcpp
 * there is nothing to build, and reporting that as a failure would report the
 * host as a uvp defect.
 */

/** This file's port. Disjoint from the toolchain lane's 8090–8099. */
const PORT = 8301;

/**
 * A port the file never starts anything on.
 *
 * Used to ask uvp for the one verdict it cannot reach by assertion: a service
 * that is running but not where uvp was told to look for it. It is never bound,
 * so nothing can answer on it.
 */
const NOWHERE = 8399;

/**
 * The workspace every pass below runs against, generated once.
 *
 * Memoised as a promise rather than a value so that a second test asking for it
 * cannot start a second `uvp init` — the first `uvp init` would still be running,
 * and the two would race for the same directory.
 */
let made: Promise<Workspace> | undefined;
const workspace = (): Promise<Workspace> => (made ??= createWorkspace("rest-api", PORT));

/** One `uvp verify` pass over that workspace. The caller judges the outcome. */
const verify = async (args: readonly string[]): Promise<CliOutcome> =>
  await runCli(["verify", (await workspace()).root, ...args, "--json"]);

/**
 * One request, with the two assertions that a healthy `rest-api` satisfies.
 *
 * `:id` is a real route parameter in this template and `$.value` is the value
 * the store holds for `1`, so both assertions are claims about the service's
 * behaviour rather than about the transport.
 */
const FIRST_ITEM: readonly string[] = [
  "--request",
  "GET",
  "/items/1",
  "--assert",
  "status=200",
  "--assert",
  "json:$.value=first",
];

afterAll(() => {
  cleanup();
});

describe.skipIf(realLibuvcpp === undefined)(
  realLibuvcpp === undefined
    ? `the verification closure — skipped: ${skipReason}`
    : `the verification closure, on real CMake and libuvcpp ${realLibuvcpp.version}`,
  () => {
    it("verifies a real service and stops it, with the goal and the evidence it claims", async () => {
      const goal = "GET /items/1 returns the first stored item";
      const outcome = await verify([...FIRST_ITEM, "--port", String(PORT), "--goal", goal]);

      // The answer is `verified`, so the exit code is 0: nothing was asked and
      // refused. A caller scripting on this does not have to parse the bundle.
      expect(outcome.exit, outcome.stderr || outcome.stdout.slice(0, 400)).toBe(EXIT_OK);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("verified");
      expect(result["goal"]).toBe(goal);

      // The build it composed, reported as its own fact: a pass that never
      // compiled anything is not a pass over the workspace.
      const build = result["build"] as Record<string, unknown>;
      expect(build["succeeded"]).toBe(true);
      expect(build["exit_code"]).toBe(0);

      // And the service, which existed as a process and no longer does.
      const service = result["service"] as Record<string, unknown>;
      expect(service["ready"]).toBe(true);
      expect(String(service["endpoint"])).toContain(String(PORT));

      const exchange = onlyExchange(result);
      expect(exchange.name).toBe("GET /items/1");
      expect(exchange.status).toBe(200);
      // Two supplied, two evaluated, none failed. This is what makes `verified`
      // mean something rather than "no assertion was supplied".
      expect(exchange.assertions_passed).toBe(2);
      expect(exchange.assertions_failed).toBe(0);
      expect(exchange.failures).toEqual([]);
      expect(result["unverified"]).toEqual([]);

      // Four observations, each complete. An empty or `unknown` coverage entry
      // here would mean a scope that was not examined, which cannot be
      // `verified`.
      const evidence = listOf<Observation>(result, "evidence");
      expect(evidence.map((entry) => entry.kind)).toEqual([
        "build",
        "launch",
        "exchange",
        "assertion",
      ]);
      expect(evidence.map((entry) => entry.coverage?.status)).toEqual([
        "complete",
        "complete",
        "complete",
        "complete",
      ]);

      // The closure includes the stop, and the limitation says so out loud
      // rather than leaving a reader to wonder whether a process is still up.
      expect(
        (result["limitations"] as readonly string[]).some((line) =>
          line.includes("was stopped after the pass"),
        ),
      ).toBe(true);
      expect(await portIsFree(PORT), "the pass left its service listening").toBe(true);
    });

    it("says failed, and says what was there and what was asked for", async () => {
      const outcome = await verify([
        "--port",
        String(PORT),
        "--request",
        "GET",
        "/items/1",
        "--assert",
        "status=200",
        // The service holds "first". Asking for "second" is a claim about the
        // service being false — not a mistake in the invocation.
        "--assert",
        "json:$.value=second",
      ]);

      // Exit 1, not 2: the question was asked and the answer is no.
      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("failed");

      const exchange = onlyExchange(result);
      expect(exchange.status).toBe(200);
      expect(exchange.assertions_passed).toBe(1);
      expect(exchange.assertions_failed).toBe(1);
      // Both halves of the comparison, in the one string a bundle carries: the
      // value that was there, and the value that was asked for. A caller who did
      // not write the assertion has nothing else to read.
      expect(exchange.failures).toEqual(['$.value = "first", expected "second"']);

      // A failing pass is a pass that ran: the service came up, was driven, and
      // was stopped. Nothing is left running just because an assertion did not
      // hold.
      const service = result["service"] as Record<string, unknown>;
      expect(service["ready"]).toBe(true);
      expect(await portIsFree(PORT), "a failed pass leaked its service").toBe(true);
    });

    it("says partial when some assertions were evaluated and passed and a question was never put", async () => {
      const outcome = await verify([
        "--port",
        String(PORT),
        ...FIRST_ITEM,
        // A second request with no `--assert`: it is made, and its status is
        // reported, but no question about its body is put to anything. This is
        // the gap `partial` exists for — the pass is not a failure and it is
        // certainly not a verification.
        "--request",
        "GET",
        "/items",
      ]);

      // Exit 1, sharing a code with `failed` but not its meaning: a caller that
      // reads only the code learns "not verified", and has to read the status to
      // learn which kind of not-verified it got.
      expect(outcome.exit).toBe(EXIT_NO);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("partial");

      // The assertions that were evaluated passed, and the bundle says so per
      // request rather than in aggregate — the second entry is the unexamined
      // one, and it is not reported as a failure.
      const exchanges = listOf<Exchange>(result, "exchanges");
      expect(exchanges.map((entry) => entry.name)).toEqual(["GET /items/1", "GET /items"]);
      expect(exchanges[0]?.assertions_passed).toBe(2);
      expect(exchanges[0]?.assertions_failed).toBe(0);
      expect(exchanges[1]?.assertions_passed).toBe(0);
      expect(exchanges[1]?.assertions_failed).toBe(0);
      expect(exchanges[1]?.status).toBe(200);

      // Named, not merely counted: the bundle says which question it did not
      // put, so `partial` is actionable rather than a shrug.
      const unverified = listOf<{ readonly question?: unknown; readonly reason?: unknown }>(
        result,
        "unverified",
      );
      expect(unverified).toHaveLength(1);
      expect(String(unverified[0]?.question)).toContain("GET /items");
      expect(String(unverified[0]?.reason)).toContain("no assertions were supplied");

      // The same fact where an evidence reader looks for it: a coverage entry
      // that is `unknown` with the reason, rather than a complete scope whose
      // emptiness implies nothing was wrong.
      const assertionEvidence = listOf<Observation>(result, "evidence").filter(
        (entry) => entry.kind === "assertion",
      );
      expect(assertionEvidence).toHaveLength(2);
      expect(assertionEvidence.map((entry) => entry.coverage?.status)).toEqual([
        "complete",
        "unknown",
      ]);
      expect(String(assertionEvidence[1]?.coverage?.note)).toContain("no assertions");
    });

    it("says unknown when no assertion was supplied at all, since nothing was evaluated", async () => {
      // The other side of the line `partial` sits on, and the rule that decides
      // it: a pass where *nothing* was evaluated is `unknown` — "the goal could
      // not be evaluated at all" — even though the service answered every
      // request. `partial` needs something that passed; with nothing to pass,
      // there is no partial credit to give.
      const outcome = await verify(["--port", String(PORT), "--request", "GET", "/items/1"]);

      expect(outcome.exit).toBe(EXIT_WRONG);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("unknown");

      // And it is a different `unknown` from an unready service: this one
      // observed the exchange, and the reason names the missing assertion rather
      // than a port nothing answered on.
      const service = result["service"] as Record<string, unknown>;
      expect(service["ready"]).toBe(true);
      const exchange = onlyExchange(result);
      expect(exchange.status).toBe(200);
      expect(exchange.assertions_passed).toBe(0);
      const unverified = listOf<{ readonly reason?: unknown }>(result, "unverified");
      expect(String(unverified[0]?.reason)).toContain("no assertions were supplied");
    });

    it("says unknown, not failed, when the service is not where it was told to look", async () => {
      // The service starts and listens on the port it was built for; the pass is
      // asked to probe a different one. So uvp could not put the assertion to
      // the service at all — which is a different fact from the assertion being
      // false, and the reason this status exists.
      const outcome = await verify(["--port", String(NOWHERE), "--timeout", "1500", ...FIRST_ITEM]);

      // Exit 2: uvp could not ask. A script that treated this as "the service is
      // broken" would be acting on a defect that was never observed.
      expect(outcome.exit).toBe(EXIT_WRONG);
      const result = resultOrThrow(outcome);
      expect(result["status"]).toBe("unknown");

      // Nothing was launched *usefully* and nothing was claimed: the build
      // succeeded, so this is not the build-failure route to `unknown`.
      const build = result["build"] as Record<string, unknown>;
      expect(build["succeeded"]).toBe(true);
      const service = result["service"] as Record<string, unknown>;
      expect(service["ready"]).toBe(false);
      expect(result["exchanges"]).toEqual([]);

      const unverified = listOf<{ readonly reason?: unknown }>(result, "unverified");
      expect(String(unverified[0]?.reason)).toContain("readiness timeout");
      expect(
        (result["limitations"] as readonly string[]).some((line) => line.includes(String(NOWHERE))),
      ).toBe(true);

      // The service the pass *did* start is stopped anyway. "Nothing could be
      // asserted" is not a reason to leave a process behind.
      expect(await portIsFree(PORT)).toBe(true);
    });

    it("gives two identical passes one digest and two ids", async () => {
      // With real evidence this is the claim that the digest is a function of
      // the findings and not of the clock: the two passes observe at different
      // times, from different pids, and still digest the same. The ids differ,
      // because they are handles to two different runs and an id that repeated
      // would make two observations hard to tell apart in a log.
      const first = resultOrThrow(await verify([...FIRST_ITEM, "--port", String(PORT)]));
      const second = resultOrThrow(await verify([...FIRST_ITEM, "--port", String(PORT)]));

      expect(first["status"]).toBe("verified");
      expect(second["status"]).toBe("verified");
      expect(second["bundle_digest"]).toBe(first["bundle_digest"]);
      expect(second["bundle_id"]).not.toBe(first["bundle_id"]);

      // The evidence's own digests do differ, and that is not a contradiction:
      // an observation's subject includes the run and the pid it came from, so
      // two runs are two subjects. The bundle digest covers the findings.
      const kinds = (result: Record<string, unknown>): readonly string[] =>
        listOf<Observation>(result, "evidence").map((entry) => String(entry.kind));
      expect(kinds(second)).toEqual(kinds(first));
      expect(listOf<Observation>(second, "evidence")[0]?.coverage?.status).toBe("complete");
    });
  },
);
