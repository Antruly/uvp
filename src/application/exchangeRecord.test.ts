import { describe, expect, it } from "vitest";

import { evaluateAssertions } from "./assertions.js";
import { rememberExchange } from "./exchangeRecord.js";
import { SessionStore } from "./sessionStore.js";

/**
 * What a record says about headers it never saw.
 *
 * `responseHeadersObserved` is `undefined` when the whole response header set
 * was read, and a list of names when the client read only those. A record with
 * no response read neither, and leaving the field unset made every header
 * assertion read "absent" — a finding about the peer derived from a gap in the
 * record. The WebSocket probe reaches this with a rejected upgrade, where the
 * handshake response is observed but the record used to drop it.
 */

const NOW = (): Date => new Date("2026-01-01T00:00:00.000Z");

describe("a record with no response", () => {
  it("says no response header was looked at, so a header assertion is undetermined", () => {
    const store = new SessionStore(NOW);
    const stored = rememberExchange(store, NOW, {
      method: "GET",
      url: "ws://127.0.0.1:1/",
      requestHeaders: {},
      requestBody: undefined,
      response: undefined,
      durationMs: 1,
      error: "the connection was refused",
      captureId: undefined,
    });

    expect(stored.responseHeadersObserved).toEqual([]);

    const [outcome] = evaluateAssertions(stored, [
      { kind: "header_exists", target: "content-type" },
    ]);
    expect(outcome?.status).toBe("undetermined");
    expect(outcome?.message).toContain("was not looked at");
  });
});
