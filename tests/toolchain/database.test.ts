import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EXIT_NO, EXIT_OK } from "../../src/cli/exitCodes.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  isAlive,
  portIsFree,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  runToExit,
  skipReason,
  startService,
} from "../support/realLibuvcpp.js";
import type { CliOutcome, Workspace } from "../support/realLibuvcpp.js";

/**
 * The database-backed template: `rest-api --features db`, on a real libuvcpp.
 *
 * `src/application/templates.test.ts` answers the cheaper half — that declaring
 * `db` replaces the in-memory store in the generated source. That is a claim
 * about a string, and a string is exactly what a service that *looks* durable
 * would also produce: a handler that answers `{"stored":1}` and then forgets is
 * the failure this lane exists for, and no amount of reading the generated C++
 * can rule it out.
 *
 * So the subject here is the wire and the file. A workspace is generated with
 * the feature, compiled by a real CMake against a real libuvcpp, started with a
 * connection string, asked to store a value nobody could have guessed, stopped,
 * **started again**, and asked for it. The second process is the assertion: a
 * row that only ever existed in a map is gone by then, and the value it is asked
 * for is the one this run generated, so no canned answer satisfies it.
 *
 * ## Why SQLite, and what that does not cover
 *
 * libuvcpp reaches SQLite, MySQL and PostgreSQL through drivers it loads at run
 * time, so all three are the same template and the same generated code. Only
 * SQLite can be connected to on a machine that has nothing else installed —
 * it is a library, not a server — so that is the dialect this lane can exercise
 * end to end, and the other two are claimed by the code path and not observed
 * here. What this lane says about them is what
 * `tests/toolchain/database.test.ts` can actually see: that a connection string
 * for one of them is refused at startup with the driver's own reason when the
 * client library is missing, rather than at the first request.
 *
 * That is the difference between "uvp generates a service that speaks MySQL" and
 * "uvp generates a service that would speak MySQL here" — the second is not a
 * finding, and this file does not report it.
 *
 * ## The port
 *
 * 8096, in the toolchain lane's block. It is a number another file in the same
 * project also writes into a generated manifest (`buildFailure.test.ts`), which
 * is safe because that lane never compiles far enough to listen and this project
 * runs one file at a time.
 */

/** This file's port. */
const PORT = 8096;

/** The name `createWorkspace` gives every generated project. */
const NAME = "svc";

/**
 * The workspace every test below runs against, generated and built once.
 *
 * Once, rather than once per test, because three of the four tests below start
 * the *same binary* with a different environment — that is the question they ask
 * — and a generated project costs a configure and a compile each time it is
 * rebuilt.
 */
let made: Promise<Workspace> | undefined;

const generated = async (): Promise<Workspace> => {
  made ??= (async () => {
    const workspace = await createWorkspace("rest-api", PORT, ["db"]);
    const outcome = await buildWorkspace(workspace);
    const result = resultOrThrow(outcome);
    expect(
      result["succeeded"],
      JSON.stringify(result["diagnostics"] ?? result).slice(0, 2_000),
    ).toBe(true);
    expect(existsSync(workspace.binary), `no binary at ${workspace.binary}`).toBe(true);
    return workspace;
  })();
  return await made;
};

/**
 * Why this lane did not run, in the words of the observation that produced it.
 *
 * Two separate reasons, and the second is not a formality: a workspace declaring
 * `db` against a libuvcpp built without the module fails its own `#error` guard,
 * and that compile error would be read as a broken template rather than as a
 * library configured without the module. A lane that ran anyway would report
 * uvp's health as a fact about the host.
 */
const skipDatabase: string =
  realLibuvcpp === undefined
    ? skipReason
    : realLibuvcpp.modules.includes("UVCPP_DB_ENABLE")
      ? ""
      : `libuvcpp ${realLibuvcpp.version} at ${realLibuvcpp.prefix} was built without the db ` +
        `module (UVCPP_DB_ENABLE is not 1 in its uvcpp_config.h), so a workspace declaring ` +
        `the db module cannot be compiled at all`;

const describeDatabase = describe.skipIf(skipDatabase !== "");

/** The response body's text, or the empty string when the response had none. */
const bodyText = (outcome: CliOutcome): string => {
  const body: unknown = resultOrThrow(outcome)["body"];
  if (typeof body !== "object" || body === null) return "";
  const text = (body as { readonly text?: unknown }).text;
  return typeof text === "string" ? text : "";
};

/**
 * The rows a read route answered with.
 *
 * The db module's own JSON — `{"table":…,"columns":[…],"rows":[…]}` — parsed
 * rather than scraped, and a body that is not that shape is a failure with the
 * body in the message instead of an empty list that would read as "no rows".
 */
const rowsOf = (outcome: CliOutcome): readonly unknown[] => {
  const text = bodyText(outcome);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`not JSON: ${text.slice(0, 300)}`);
  }
  const rows = (parsed as { readonly rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new Error(`no rows in the response: ${text.slice(0, 300)}`);
  }
  return rows;
};

/** One request to the generated service, through the CLI a caller would use. */
const ask = async (
  path: string,
  options: { readonly method?: string; readonly data?: string } = {},
): Promise<CliOutcome> => {
  const outcome = await runCli([
    "http",
    ...(options.method === undefined ? [] : [options.method]),
    `http://127.0.0.1:${String(PORT)}${path}`,
    ...(options.data === undefined ? [] : ["--data", options.data]),
    "--json",
  ]);
  expect(outcome.exit, outcome.stderr).toBe(EXIT_OK);
  return outcome;
};

afterAll(() => {
  cleanup();
});

describeDatabase(
  skipDatabase === ""
    ? `the database-backed template, on real libuvcpp ${realLibuvcpp?.version ?? ""}`
    : `the database-backed template — skipped: ${skipDatabase}`,
  () => {
    it("stores a value in SQLite and still has it after the service restarts", async () => {
      const workspace = await generated();
      const databaseFile = join(workspace.root, "lane.db");
      const database = `sqlite://${databaseFile}`;
      const env = { UVP_DATABASE_URL: database };

      // Unique to this run, so no answer the template could have canned —
      // including one hard-coded to look like a database — satisfies the reads
      // below.
      const stamp = String(Date.now());
      const value = `stored-${stamp}`;

      const first = await startService(workspace, { env });
      try {
        // The service announces the connection string it actually opened, which
        // is how a caller learns that the environment variable was read at all.
        expect(first.output()).toContain(`serving from ${database}`);

        // A store with nothing in it, before anything is written. The in-memory
        // template seeds two rows, so this is also the shortest statement that
        // the store behind these routes is not that one.
        expect(rowsOf(await ask("/items"))).toEqual([]);

        const missing = await ask(`/items/${stamp}`);
        expect(resultOrThrow(missing)["status"]).toBe(404);

        const created = await ask(`/items/${stamp}`, { method: "POST", data: value });
        expect(resultOrThrow(created)["status"]).toBe(201);

        // The write is visible to a later read, and the value is the one this
        // run sent.
        expect(rowsOf(await ask(`/items/${stamp}`))).toEqual([{ id: stamp, value }]);

        // A refusal on the write path, so "201" is a decision rather than the
        // only thing this handler can say.
        const empty = await ask(`/items/empty-${stamp}`, { method: "POST" });
        expect(resultOrThrow(empty)["status"]).toBe(400);
        expect(rowsOf(await ask("/items"))).toHaveLength(1);
      } finally {
        await first.stop();
      }
      expect(isAlive(first.pid), `the service outlived its stop:\n${first.output()}`).toBe(false);
      expect(await portIsFree(PORT)).toBe(true);

      // The row is in the file, not in the process that answered. A byte count
      // rather than a content check: it is the evidence that the durability
      // below has something to be durable *in*, and this lane does not open
      // SQLite itself to find out — that would be a second reader of a format
      // whose owner is the driver.
      expect(existsSync(databaseFile), `no database at ${databaseFile}`).toBe(true);
      expect(statSync(databaseFile).size).toBeGreaterThan(0);

      // A second process, with nothing shared but the connection string.
      const second = await startService(workspace, { env });
      try {
        expect(rowsOf(await ask(`/items/${stamp}`))).toEqual([{ id: stamp, value }]);
      } finally {
        await second.stop();
      }
      expect(isAlive(second.pid)).toBe(false);
      expect(await portIsFree(PORT)).toBe(true);
    });

    it("refuses a connection string it cannot open, before it listens", async () => {
      // The failure worth having a test for: a service that opened its database
      // lazily would come up green, answer `/healthz`, and 500 on the first
      // request that needs data — reporting a deployment mistake as a bug in
      // the request. `init` opens the first connection at startup, so this is
      // an exit and a reason instead of a listener.
      //
      // The path is blocked by a regular file, not by a directory that does not
      // exist. libuvcpp's SQLite driver creates the parent chain before opening
      // (`make_parent_dirs`, `src/db/uvcpp_db_sqlite.cpp`), so a missing
      // directory is unopenable only when the host happens to forbid creating
      // it: `/no/such/directory` is EACCES for the POSIX runner, but on Windows
      // it resolves to a path on the current drive that the administrator
      // account can create, and the service rightly serves. That made the old
      // fixture an assertion about the runner's permissions; the lane could only
      // keep it by skipping it there, which left the refusal behavior
      // unobserved on Windows.
      //
      // A file where a directory is needed is the same refusal everywhere: the
      // driver accepts EEXIST/ERROR_ALREADY_EXISTS as "the chain is there"
      // without checking that the component is a directory (recorded on #108),
      // and `sqlite3_open_v2` then answers CANTOPEN. The backend's own reason is
      // what reaches the operator; this fixture was run on Linux, and the
      // Windows lane is where the second half is observed.
      const workspace = await generated();
      writeFileSync(join(workspace.root, "blocker"), "not a directory\n");
      const database = "sqlite://./blocker/lane.db";
      const outcome = await runToExit(workspace, {
        env: { UVP_DATABASE_URL: database },
      });
      expect(outcome.code).toBe(EXIT_NO);
      // The status name is the module's, and the URL is echoed back so the
      // operator can see which connection string was tried: a service that
      // reported only "database unavailable" would leave them looking at the
      // wrong variable.
      expect(outcome.output).toContain("open_failed");
      expect(outcome.output).toContain(database);
      expect(await portIsFree(PORT)).toBe(true);
    });

    it("opens a file in the working directory when no connection string names one", async () => {
      // The documented default, and the reason a freshly generated workspace
      // runs with nothing installed but libuvcpp: SQLite is a library, not a
      // server. `uvp verify` is the caller that depends on this most — it starts
      // the service with no environment at all — so the default getting a test
      // is what makes that documented rather than assumed.
      const workspace = await generated();
      const service = await startService(workspace, { env: { UVP_DATABASE_URL: "" } });
      try {
        expect(service.output()).toContain(`serving from sqlite://./${NAME}.db`);
        // Resolved against the working directory, which `startService` sets to
        // the workspace root.
        expect(existsSync(join(workspace.root, `${NAME}.db`))).toBe(true);
        expect(rowsOf(await ask("/items"))).toEqual([]);
      } finally {
        await service.stop();
      }
      expect(await portIsFree(PORT)).toBe(true);
    });

    it("answers the route table it shares with the in-memory template", async () => {
      // The control for the three tests above: whatever the store, these are the
      // routes. `/healthz` in particular does not touch the database, so it
      // answers even when every route beside it would fail — which is what makes
      // it a health check rather than a second data route.
      const workspace = await generated();
      const service = await startService(workspace, {
        env: { UVP_DATABASE_URL: `sqlite://${join(workspace.root, "control.db")}` },
      });
      try {
        expect(bodyText(await ask("/healthz"))).toBe('{"status":"ok"}');
      } finally {
        await service.stop();
      }
      expect(await portIsFree(PORT)).toBe(true);
    });
  },
);
