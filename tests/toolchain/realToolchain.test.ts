import { existsSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { LIBUVCPP_BASELINE, TEMPLATE_IDS } from "../../src/application/templates.js";
import type { TemplateId } from "../../src/application/templates.js";
import { EXIT_OK } from "../../src/cli/exitCodes.js";
import {
  buildWorkspace,
  cleanup,
  createWorkspace,
  isAlive,
  portIsFree,
  realLibuvcpp,
  resultOrThrow,
  runCli,
  skipReason,
  startService,
} from "../support/realLibuvcpp.js";
import type { RealLibuvcpp } from "../support/realLibuvcpp.js";

/**
 * The self-proof: five templates, built by a real CMake against a real libuvcpp,
 * started on their own ports, and answered.
 *
 * This is the one lane that can say whether uvp *works*, as opposed to whether
 * its logic is self-consistent. Everything else in the suite drives either a
 * module or a fake; here the substrate is the compiler and the library on this
 * machine, and the claim under test is the product claim — a generated project
 * is a plain CMake project, it builds against the libuvcpp that is installed,
 * and the program it produces serves traffic.
 *
 * ```
 * ### hello-http      :8090 -> {"message":"Hello, AI"}
 * ### rest-api        :8091 -> {"id":"1","value":"first"}
 * ### websocket-echo  :8092 -> HTTP/1.1 101 Switching Protocols
 * ### soap-service    :8093 -> <?xml version="1.0" encoding="utf-8"?><soap:Envelope …
 * ### static-files    :8094 -> <!doctype html>
 * ```
 *
 * That table is the reference run recorded in [docs/testing.md](../../docs/testing.md),
 * and the assertions below are the same facts stated as code — one test per row,
 * each naming the template and the port, so a failure points at a row. The
 * elided rows are asserted as prefixes, which is what the doc's `…` means.
 *
 * **Ports are fixed and distinct.** Each template listens on its own number
 * rather than on a port reserved per run. Sequential probes sharing one port was
 * the cause of a long-standing intermittent failure that looked like a flaky
 * server and was the previous test's socket still in `TIME_WAIT`, and a fixed
 * number per template makes that mistake unrepeatable. The cost is that a busy
 * machine can take one of them first, so `startService` refuses to start when the
 * port already answers: a stranger on the port would satisfy every assertion
 * below for the wrong reason.
 *
 * **The lane owns the process.** The built binary is started and stopped here
 * rather than through `uvp run`, because the claim is about the deliverable —
 * a user who never runs uvp again still has a program that serves traffic. uvp's
 * own supervision is `process-boundary`'s subject and its whole workflow is
 * `acceptance`'s.
 *
 * When no libuvcpp is found the whole file skips, with the reason in the
 * describe name. A missing library is a fact about the host, and reporting it as
 * a failure or as a pass would both be a lie about what was examined.
 */

/** Each template's own port, as the reference run recorded it. */
const PORT_BY_TEMPLATE: Record<TemplateId, number> = {
  "hello-http": 8090,
  "rest-api": 8091,
  "websocket-echo": 8092,
  "soap-service": 8093,
  "static-files": 8094,
};

/** What the service actually said, per template, so the table can be checked. */
const observed: { readonly template: TemplateId; readonly said: string }[] = [];

/**
 * Compare two dotted versions numerically.
 *
 * Numerically, because string order rates `"1.10.0"` below `"1.7.0"` and would
 * reject a newer library for the wrong reason. Only each field's leading digits
 * are read, so a pre-release suffix on the last field compares as its release.
 */
const compareVersions = (left: string, right: string): number => {
  const fields = (version: string): number[] =>
    version.split(".").map((field) => Number.parseInt(field, 10) || 0);
  const a = fields(left);
  const b = fields(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** The response body's text, or a failure naming what was there instead. */
const bodyText = (result: Record<string, unknown>): string => {
  const body: unknown = result["body"];
  if (typeof body !== "object" || body === null) {
    throw new Error(`no body in the result: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const text = (body as { readonly text?: unknown }).text;
  return typeof text === "string" ? text : "";
};

/** The diagnostics, as a string, so a failed build reports why. */
const why = (result: Record<string, unknown>): string =>
  JSON.stringify(result["diagnostics"] ?? result).slice(0, 2_000);

/**
 * Generate and build one template, and hand back the workspace.
 *
 * The build is asserted here rather than in each test because there is nothing
 * template-specific about it: every one of the five must compile with the same
 * flags against the same library, and a failure names the template through the
 * test that called it.
 */
const builtTemplate = async (template: TemplateId) => {
  const workspace = await createWorkspace(template, PORT_BY_TEMPLATE[template]);
  const outcome = await buildWorkspace(workspace);
  const result = resultOrThrow(outcome);
  expect(result["succeeded"], `${template} failed to build: ${why(result)}`).toBe(true);
  expect(result["exit_code"]).toBe(0);
  // The binary the build claims is the binary that was asked for: a manifest
  // naming one target while CMake produced another is a build that "succeeded"
  // and left nothing to run.
  expect(existsSync(workspace.binary), `no binary at ${workspace.binary}`).toBe(true);
  return workspace;
};

afterAll(() => {
  cleanup();
});

/**
 * The discovered install, as a value.
 *
 * `describe.skipIf` is not a narrowing the type checker can see, so every test
 * below would otherwise open with the same three-line throw. One accessor, so
 * there is one statement about what the guard guarantees.
 */
const install = (): RealLibuvcpp => {
  if (realLibuvcpp === undefined)
    throw new Error("unreachable: this file is skipped without an install");
  return realLibuvcpp;
};

describe.skipIf(realLibuvcpp === undefined)(
  realLibuvcpp === undefined
    ? `real CMake and real libuvcpp — skipped: ${skipReason}`
    : `real CMake and real libuvcpp ${realLibuvcpp.version} at ${realLibuvcpp.prefix}`,
  () => {
    it("reports a libuvcpp at or above the version the templates require", () => {
      // A floor, not a pin: libuvcpp follows semver and the generated code uses
      // API stable across the 1.x line. Below the floor the templates are not
      // expected to compile, and the failure would be a cascade inside
      // libuvcpp's own headers rather than anything a reader could act on.
      expect(
        compareVersions(install().version, LIBUVCPP_BASELINE),
        `libuvcpp ${install().version} is below the ${LIBUVCPP_BASELINE} floor`,
      ).toBeGreaterThanOrEqual(0);
      expect(install().prefix).not.toBe("");
    });

    it("reads the feature set from the build, not from the version string", () => {
      // The regression this pins: two builds of the same version can differ in
      // what was compiled in, so a capability claim derived from a number is a
      // guess. The modules come from the `UVCPP_*_ENABLE` symbols that this
      // build's config header defines. An empty list would mean the check did
      // not run, which is `undetermined` — not "this build has no features".
      expect(install().modules.length).toBeGreaterThan(0);
      expect(install().modules.every((symbol) => symbol.startsWith("UVCPP_"))).toBe(true);
    });

    it("hello-http: answers GET /hello on :8090", async () => {
      const workspace = await builtTemplate("hello-http");
      const service = await startService(workspace);
      try {
        const outcome = await runCli([
          "http",
          `http://127.0.0.1:${String(workspace.port)}/hello`,
          "--json",
        ]);
        expect(outcome.exit).toBe(EXIT_OK);
        const result = resultOrThrow(outcome);
        expect(result["status"]).toBe(200);
        // `server: uvcpp` is the proof that the answer came from the generated
        // binary and not from something else that happened to hold the port.
        expect((result["headers"] as Record<string, string>)["server"]).toBe("uvcpp");

        const said = bodyText(result);
        expect(said).toBe('{"message":"Hello, AI"}');
        observed.push({ template: "hello-http", said });
      } finally {
        await service.stop();
      }

      // The generated service handles the polite signal, so forcing it is not
      // needed — a service that had to be killed would leave the reason nowhere.
      expect(isAlive(service.pid), `the service outlived its stop:\n${service.output()}`).toBe(
        false,
      );
      expect(await portIsFree(workspace.port)).toBe(true);
    });

    it("rest-api: answers GET /items/1 on :8091, from a store that holds more", async () => {
      const workspace = await builtTemplate("rest-api");
      const port = workspace.port;
      const service = await startService(workspace);
      try {
        const one = await runCli(["http", `http://127.0.0.1:${String(port)}/items/1`, "--json"]);
        const item = resultOrThrow(one);
        expect(item["status"]).toBe(200);
        const said = bodyText(item);
        expect(said).toBe('{"id":"1","value":"first"}');

        // The positive control for the route parameter: if `:id` were ignored and
        // every request answered the first entry, the assertion above would pass
        // and the template would be broken. The collection is what distinguishes
        // "one item, looked up" from "one item, hard-coded".
        const all = await runCli(["http", `http://127.0.0.1:${String(port)}/items`, "--json"]);
        const collection = bodyText(resultOrThrow(all));
        expect(collection).toContain('{"id":"1","value":"first"}');
        expect(collection).toContain('{"id":"2","value":"second"}');

        observed.push({ template: "rest-api", said });
      } finally {
        await service.stop();
      }

      expect(isAlive(service.pid)).toBe(false);
      expect(await portIsFree(port)).toBe(true);
    });

    it("websocket-echo: completes the upgrade on :8092 and echoes a frame", async () => {
      const workspace = await builtTemplate("websocket-echo");
      const port = workspace.port;
      const service = await startService(workspace);
      try {
        const outcome = await runCli([
          "ws",
          `ws://127.0.0.1:${String(port)}/echo`,
          "--send",
          "hello",
          "--json",
        ]);
        expect(outcome.exit).toBe(EXIT_OK);
        const result = resultOrThrow(outcome);

        // The doc's row is `HTTP/1.1 101 Switching Protocols`, and this is that
        // handshake as data: the status, and the headers that make it an upgrade
        // rather than a 200 with a body.
        expect(result["upgraded"]).toBe(true);
        const handshake = result["handshake"] as {
          readonly status: number;
          readonly headers: Record<string, string>;
        };
        expect(handshake.status).toBe(101);
        expect(handshake.headers["upgrade"]?.toLowerCase()).toBe("websocket");

        // An upgrade that then answers nothing is not an echo. Both directions
        // are checked so that "the frame came back" cannot be satisfied by the
        // frame the client sent.
        const frames = result["frames"] as readonly {
          readonly direction: string;
          readonly text?: string;
        }[];
        const sent = frames.filter((frame) => frame.direction === "sent");
        const received = frames.filter((frame) => frame.direction === "received");
        expect(sent.map((frame) => frame.text)).toEqual(["hello"]);
        expect(received.map((frame) => frame.text)).toEqual(["hello"]);

        observed.push({ template: "websocket-echo", said: "HTTP/1.1 101 Switching Protocols" });
      } finally {
        await service.stop();
      }

      expect(isAlive(service.pid)).toBe(false);
      expect(await portIsFree(port)).toBe(true);
    });

    it("soap-service: returns an envelope for a call on :8093", async () => {
      const workspace = await builtTemplate("soap-service");
      const port = workspace.port;
      const service = await startService(workspace);
      try {
        const outcome = await runCli([
          "soap",
          `http://127.0.0.1:${String(port)}/ws`,
          "--operation",
          "GetQuote",
          "--namespace",
          "urn:example:quote",
          "--param",
          "Symbol=ACME",
          "--json",
        ]);
        expect(outcome.exit).toBe(EXIT_OK);
        const result = resultOrThrow(outcome);
        expect(result["outcome"]).toBe("success");
        expect(result["status"]).toBe(200);

        const said = bodyText(result);
        expect(said.startsWith('<?xml version="1.0" encoding="utf-8"?><soap:Envelope')).toBe(true);
        // The parameter the caller sent is the one the service answered about:
        // a canned envelope would satisfy the prefix and tell the caller nothing
        // about whether its request was read.
        expect(said).toContain("<Symbol>ACME</Symbol>");
        expect(said).toContain("<Price>42.00</Price>");

        observed.push({ template: "soap-service", said });
      } finally {
        await service.stop();
      }

      expect(isAlive(service.pid)).toBe(false);
      expect(await portIsFree(port)).toBe(true);
    });

    it("static-files: serves its document root on :8094", async () => {
      const workspace = await builtTemplate("static-files");
      const port = workspace.port;
      const service = await startService(workspace);
      try {
        const outcome = await runCli(["http", `http://127.0.0.1:${String(port)}/`, "--json"]);
        const result = resultOrThrow(outcome);
        // 200 rather than 500: the template resolves `./public` against the
        // process's working directory, so a 500 here means the service was
        // started somewhere else — which is exactly the mistake `startService`
        // exists to avoid, and the one a caller would otherwise debug by reading
        // the response body.
        expect(result["status"]).toBe(200);
        const said = bodyText(result);
        expect(said.startsWith("<!doctype html>")).toBe(true);
        expect(said).toContain("<h1>svc</h1>");
        observed.push({ template: "static-files", said: said.split("\n")[0] ?? "" });
      } finally {
        await service.stop();
      }

      expect(isAlive(service.pid)).toBe(false);
      expect(await portIsFree(port)).toBe(true);
    });

    it("covered every template, so a green run is the whole table", () => {
      // The vacuity guard. Five passing tests above are only the documented
      // table if they are the five templates — a lane that quietly stopped
      // exercising one, or that a new template never reached, would otherwise
      // report the same green.
      expect(observed.map((row) => row.template)).toEqual([...TEMPLATE_IDS]);
      expect(Object.keys(PORT_BY_TEMPLATE).sort()).toEqual([...TEMPLATE_IDS].sort());
      expect(observed.every((row) => row.said !== "")).toBe(true);
    });
  },
);
