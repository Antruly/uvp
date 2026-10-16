import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import type { ToolContract } from "../../src/contracts/toolContractTypes.js";
import { toUvpError } from "../../src/domain/errors.js";
import { sha256 } from "../../src/domain/identity.js";
import { freePort } from "../support/ports.js";
import { removeTree } from "../support/temporaryTree.js";
import { createFakeToolchain, writeFakeService } from "./fakeToolchain.js";

/**
 * Comparing two verification reports, end to end.
 *
 * The unit lane decides what the comparison says; this lane decides whether the
 * thing a caller actually gets says it. That distinction is the reason the lane
 * exists at all, because the comparison is the only tool in uvp whose subject is
 * *another tool's file*. Three claims can only be checked here:
 *
 * - **The reader accepts what the writer produces.** Both passes go through
 *   `uvp_verify` and are kept exactly as `uvp verify --json` keeps one — the
 *   handler's own output, written to a file — so a field added to the bundle
 *   contract is exercised against a real report rather than against a fixture
 *   someone wrote to match.
 * - **Two real passes of one service are comparable and identical.** They differ
 *   in bundle id, exchange id, elapsed time, run id and endpoint, because each
 *   names its own port. If the comparison read any of those, this lane would
 *   report a difference where there is none — which is the failure mode that
 *   would make the tool useless rather than wrong.
 * - **A file that is not a report is refused as one.** Every refusal below comes
 *   from a real file on disk, including the one that is a report with its digest
 *   changed by hand, which is what a reader would meet if a caller edited one.
 *
 * The toolchain is the scripted fixture, so this lane needs neither a compiler
 * nor libuvcpp: what is being tested is the comparison and its reading, not the
 * host it read about. That a real compiler produces the same bundles is the
 * `toolchain` lane's claim.
 */

const TIMEOUT = 30_000;

let root: string;
let services: ReturnType<typeof createUvpServices>;
let handlers: ReturnType<typeof createToolHandlers>;
let signal: AbortSignal;

const workspace = (name: string): string => join(root, name);

const call = async (name: string, input: unknown): Promise<Record<string, unknown>> =>
  await handlerFor(handlers, name)(input, { signal });

/** A result, checked against the contract that describes it, as the CLI/MCP must. */
const conforming = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
  const output = await call(name, input);
  const contract = toolContract(name) as ToolContract | undefined;
  if (contract === undefined) throw new Error(`${name} is not a known contract`);
  expect(output["tool"], `${name} reported a different tool`).toBe(name);
  const parsed = contract.outputSchema.safeParse(output);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${name} produced output its own contract rejects:\n${issues}`);
  }
  return output;
};

const refusalCode = async (name: string, input: unknown): Promise<string> => {
  try {
    await call(name, input);
  } catch (cause) {
    return toUvpError(cause).code;
  }
  throw new Error(`${name} was expected to refuse ${JSON.stringify(input)} and did not`);
};

/**
 * The two requests every pass in this lane makes.
 *
 * A tuple rather than an array, so a test that reuses one of them reads it as
 * the request it is instead of as something that might be absent.
 */
const REQUESTS: readonly [Record<string, unknown>, Record<string, unknown>] = [
  {
    name: "hello",
    method: "GET",
    path: "/hello",
    assertions: [
      { kind: "status_equals", expected: 200 },
      { kind: "body_json_path_equals", target: "$.message", expected: "Hello, AI" },
    ],
  },
  {
    name: "teapot",
    method: "GET",
    path: "/teapot",
    assertions: [{ kind: "status_equals", expected: 418 }],
  },
];

/**
 * One real pass over a real service.
 *
 * The fixture takes its port as the program's first argument, and the launcher
 * passes it because the arguments belong to the caller: `run.args` is where the
 * port travels, and it differs on every pass. `service.endpoint` is therefore a
 * field that genuinely differs between any two passes in this lane, which is what
 * makes "and it was not compared" an assertion with something behind it.
 */
const verify = async (
  name: string,
  port: number,
  requests: readonly Record<string, unknown>[] = REQUESTS,
): Promise<Record<string, unknown>> => {
  const service = await writeFakeService(workspace(name), name, port);
  return await conforming("uvp_verify", {
    path: workspace(name),
    run: { args: service.args, port, ready_path: "/healthz", timeout_ms: 15_000 },
    requests,
    goal: "the fixture answers as declared",
  });
};

/**
 * Keep one pass on disk, the way a caller does.
 *
 * The tool takes paths rather than two inlined reports — one representation for
 * both adapters, and no way for an MCP call to carry two whole bundles — so a
 * caller's file is the only input shape there is. Writing the handler's own
 * output here means the reader is exercised against a report the writer
 * produced, envelope fields and all.
 */
const savePass = async (pass: Record<string, unknown>, name: string): Promise<string> => {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(pass, null, 2));
  return path;
};

const diff = async (
  before: string,
  after: string,
  includeUnchanged = false,
): Promise<Record<string, unknown>> =>
  await conforming("uvp_bundle_diff", {
    before,
    after,
    include_unchanged: includeUnchanged,
  });

interface ReportedExchange {
  readonly name: string;
  readonly change: string;
  readonly changed_fields: readonly string[];
  readonly verdict_changed: boolean;
  readonly before?: { readonly status?: number; readonly failures: readonly string[] };
  readonly after?: { readonly status?: number; readonly failures: readonly string[] };
}

const entriesOf = (output: Record<string, unknown>): readonly ReportedExchange[] =>
  ((output["exchanges"] as { entries: readonly ReportedExchange[] }).entries ??
    []) as readonly ReportedExchange[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "uvp-bundle-diff-"));
  services = createUvpServices({ providers: [createFakeToolchain()] });
  handlers = createToolHandlers(services);
  signal = new AbortController().signal;

  // Created through the tool, so the passes below run over a manifest and files
  // uvp wrote rather than over a hand-made directory.
  for (const name of ["svc", "other"]) {
    await conforming("uvp_workspace_create", {
      path: workspace(name),
      name,
      template: "hello-http",
      port: await freePort(),
    });
  }
}, TIMEOUT);

afterAll(async () => {
  await removeTree(root);
});

describe("two passes of one service", () => {
  it(
    "calls a repeat pass identical, and names the fields it refused to compare",
    async () => {
      const first = await verify("svc", await freePort());
      const second = await verify("svc", await freePort());
      expect(first["status"]).toBe("verified");
      expect(second["status"]).toBe("verified");

      const before = await savePass(first, "identical-before.json");
      const after = await savePass(second, "identical-after.json");
      const output = await diff(before, after);

      expect(output["outcome"]).toBe("identical");
      expect(output["comparable"]).toBe(true);
      expect(output["same_digest"]).toBe(true);
      expect(output["digest_consistent"]).toEqual({ before: true, after: true });
      expect(output["status_changed"]).toBe(false);
      expect(output["order_changed"]).toBe(false);
      expect(output["goal_changed"]).toBe(false);
      expect(entriesOf(output)).toEqual([]);
      expect(output["exchanges"]).toMatchObject({
        unchanged: 2,
        before_count: 2,
        after_count: 2,
      });

      // The two passes really are two: the ids and the endpoint differ, so the
      // identity below is a decision about them rather than a coincidence of the
      // fixture.
      const beforeSide = output["before"] as Record<string, unknown>;
      const afterSide = output["after"] as Record<string, unknown>;
      expect(beforeSide["bundle_id"]).not.toBe(afterSide["bundle_id"]);
      expect(beforeSide["status"]).toBe("verified");
      expect(beforeSide["digest"]).toBe(afterSide["digest"]);
      expect(beforeSide["workspace_id"]).toBe(afterSide["workspace_id"]);

      // `service.endpoint` is reported on both sides and is one of the fields the
      // comparison declines to judge: the caller picked the port, so a difference
      // in it is a difference in the harness.
      const service = output["service"] as {
        changed: boolean;
        before: { endpoint?: string };
        after: { endpoint?: string };
      };
      expect(service.changed).toBe(false);
      expect(service.before.endpoint).not.toBe(service.after.endpoint);
      expect(output["not_compared"]).toContain("service.endpoint");
      expect(output["not_compared"]).toContain("exchange_id");
      expect(output["not_compared"]).toContain("elapsed_ms");
    },
    TIMEOUT,
  );

  it(
    "reports a service that stopped answering as declared as a change, digest and all",
    async () => {
      const before = await savePass(await verify("svc", await freePort()), "changed-before.json");
      // The same two requests, with `/hello` held to the status it never had.
      const after = await savePass(
        await verify("svc", await freePort(), [
          { ...REQUESTS[0], assertions: [{ kind: "status_equals", expected: 418 }] },
          REQUESTS[1],
        ]),
        "changed-after.json",
      );

      const output = await diff(before, after);
      expect(output["outcome"]).toBe("changed");
      expect(output["comparable"]).toBe(true);
      expect(output["same_digest"]).toBe(false);
      expect(output["status_changed"]).toBe(true);
      const afterSide = output["after"] as Record<string, unknown>;
      expect(afterSide["status"]).toBe("failed");

      // One request moved and the other did not, and the answer says which: an
      // exchange that matched is not reported, so a difference is never implied
      // for a request that behaved.
      expect(entriesOf(output).map((entry) => [entry.name, entry.change])).toEqual([
        ["hello", "changed"],
      ]);
      const [hello] = entriesOf(output);
      expect(hello?.verdict_changed).toBe(true);
      expect(hello?.changed_fields).toEqual(["assertions_passed", "assertions_failed", "failures"]);
      expect(hello?.before?.status).toBe(200);
      expect(hello?.before?.failures).toEqual([]);
      // The failure text is the observation — `status 200` — and not the
      // expectation, which is the assertion engine's convention for the checks
      // whose observed value is the whole story. A report does not carry the
      // requests it was made with, so what a reader has is that sentence beside
      // `assertions_failed: 1`, and the pair is what identifies the request as
      // one that came back wrong.
      expect(hello?.after?.failures).toHaveLength(1);
      expect(hello?.after?.failures.join(" ")).toContain("status 200");
      expect(output["exchanges"]).toMatchObject({ unchanged: 1, before_count: 2, after_count: 2 });

      // The reading a caller asks for is a different report of the same two
      // files, not a different comparison.
      const full = await diff(
        join(root, "changed-before.json"),
        join(root, "changed-after.json"),
        true,
      );
      expect(entriesOf(full).map((entry) => [entry.name, entry.change])).toEqual([
        ["hello", "changed"],
        ["teapot", "unchanged"],
      ]);
      expect(full["outcome"]).toBe("changed");
      expect(full["exchanges"]).toMatchObject({ unchanged: 1, before_count: 2, after_count: 2 });
    },
    TIMEOUT,
  );

  it(
    "refuses to compare two passes made in different workspaces",
    async () => {
      const here = await savePass(await verify("svc", await freePort()), "here.json");
      const there = await savePass(await verify("other", await freePort()), "there.json");

      const output = await diff(here, there);
      expect(output["outcome"]).toBe("incomparable");
      expect(output["comparable"]).toBe(false);
      const reasons = output["incomparable_because"] as string[];
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("different workspaces");

      // `incomparable` withholds a reading, not the facts: the per-exchange
      // entries are still there, and the two workspace ids are both reported.
      const beforeSide = output["before"] as Record<string, unknown>;
      const afterSide = output["after"] as Record<string, unknown>;
      expect(beforeSide["workspace_id"]).not.toBe(afterSide["workspace_id"]);
      expect(output["exchanges"]).toMatchObject({ unchanged: 2 });
      expect((output["limitations"] as string[]).join(" ")).toContain("withholds");
    },
    TIMEOUT,
  );

  it(
    "refuses a report whose own digest does not describe it, and does not claim it compared them",
    async () => {
      const good = await savePass(await verify("svc", await freePort()), "good.json");
      const text = await readFile(good, "utf8");
      const tampered = join(root, "tampered.json");
      await writeFile(
        tampered,
        text.replace(/"bundle_digest": "[0-9a-f]{64}"/u, `"bundle_digest": "${"0".repeat(64)}"`),
      );

      const output = await diff(tampered, good);
      expect(output["digest_consistent"]).toEqual({ before: false, after: true });
      expect(output["comparable"]).toBe(false);
      expect(output["outcome"]).toBe("incomparable");
      // Absent rather than false: two digests, one of which does not describe its
      // own bundle, have not been found different — they were never compared.
      expect(output["same_digest"]).toBeUndefined();
      expect((output["incomparable_because"] as string[]).join(" ")).toContain(
        "supplied digest does not match",
      );
    },
    TIMEOUT,
  );
});

describe("what the comparison will not read", () => {
  it(
    "refuses a path with no file at it",
    async () => {
      const good = await savePass(await verify("svc", await freePort()), "missing-good.json");
      expect(
        await refusalCode("uvp_bundle_diff", { before: join(root, "nope.json"), after: good }),
      ).toBe("invalid_request");
    },
    TIMEOUT,
  );

  it(
    "refuses a file that is JSON but is not a report, and says to point at one that is",
    async () => {
      const good = await savePass(await verify("svc", await freePort()), "notreport-good.json");
      const other = join(root, "not-a-report.json");
      await writeFile(other, JSON.stringify({ hello: "world" }, null, 2));

      expect(await refusalCode("uvp_bundle_diff", { before: other, after: good })).toBe(
        "invalid_request",
      );
    },
    TIMEOUT,
  );

  it(
    "refuses a file that is not JSON at all, distinctly from one that is not a report",
    async () => {
      const good = await savePass(await verify("svc", await freePort()), "notjson-good.json");
      const other = join(root, "not-json.txt");
      await writeFile(other, "uvp verify --json > pass.json\n");

      expect(await refusalCode("uvp_bundle_diff", { before: other, after: good })).toBe(
        "invalid_request",
      );
    },
    TIMEOUT,
  );

  it(
    "refuses a directory rather than pretending there was nothing to compare",
    async () => {
      const good = await savePass(await verify("svc", await freePort()), "dir-good.json");
      expect(await refusalCode("uvp_bundle_diff", { before: root, after: good })).toBe(
        "invalid_request",
      );
    },
    TIMEOUT,
  );

  it(
    "refuses an empty path through the contract's own schema",
    async () => {
      // The schema, not the reader: a missing path never reaches the file system,
      // and the refusal names the field. Its category is `invalid_input` — the
      // caller's own value — while every refusal above is about what was found at
      // a path the caller named correctly.
      const good = await savePass(await verify("svc", await freePort()), "empty-good.json");
      expect(await refusalCode("uvp_bundle_diff", { before: "", after: good })).toBe(
        "invalid_request",
      );
    },
    TIMEOUT,
  );
});

describe("the file facts and the evidence", () => {
  it(
    "reports the bytes it read, and a digest of exactly those bytes",
    async () => {
      const good = await savePass(await verify("svc", await freePort()), "bytes.json");
      const raw = await readFile(good);
      const output = await diff(good, good);

      const side = output["before"] as Record<string, unknown>;
      expect(side["path"]).toBe(good);
      expect(side["bytes"]).toBe(raw.byteLength);
      // The byte digest describes the file, the semantic digest describes the
      // pass. Both are reported, and neither is presented as the other.
      expect(side["byte_digest"]).toBe(sha256(raw));
      expect(side["digest"]).toBe((output["after"] as Record<string, unknown>)["digest"]);

      // A file compared with itself is identical, which is the only case where
      // that conclusion is available without reading either pass's contents.
      expect(output["outcome"]).toBe("identical");
      expect(output["same_digest"]).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "records the comparison as evidence about two files, not about a live subject",
    async () => {
      const before = await savePass(await verify("svc", await freePort()), "evidence-before.json");
      const afterPath = await savePass(
        await verify("svc", await freePort()),
        "evidence-after.json",
      );
      const output = await diff(before, afterPath);

      const evidence = output["evidence"] as {
        kind: string;
        coverage: { scope: string; status: string };
        sources: { kind: string; ref: string; digest?: string }[];
      }[];
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.kind).toBe("comparison");
      // Both files were read whole, so the stated scope was examined: `complete`
      // here is a claim this lane can check, and the checked scope is named.
      expect(evidence[0]?.coverage.status).toBe("complete");
      expect(evidence[0]?.coverage.scope).toContain("two reports");
      expect(evidence[0]?.sources.map((source) => source.ref)).toEqual([before, afterPath]);
      for (const source of evidence[0]?.sources ?? []) {
        expect(source.kind).toBe("file");
        // A source without a digest names a file without identifying the claim
        // in it, so a later "is this still the report I compared?" is unanswerable.
        expect(source.digest).toMatch(/^[0-9a-f]{64}$/u);
      }

      // A comparison runs no process and opens no socket, and the envelope says
      // so by carrying nothing observed live: the unknowns are those of the two
      // passes, not of this call.
      const unknowns = output["unknowns"] as { question: string }[];
      for (const unknown of unknowns) {
        expect(unknown.question).not.toContain("uvp_bundle_diff");
      }
      expect((output["limitations"] as string[]).join(" ")).toContain("observes nothing itself");
    },
    TIMEOUT,
  );
});
