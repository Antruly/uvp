import { describe, expect, it } from "vitest";

import { waitForOutput } from "../support/realLibuvcpp.js";
import type { Service } from "../support/realLibuvcpp.js";

/**
 * The wait behind the `http3-service` row.
 *
 * The race this exists for cannot be reproduced on demand: it needs a runner to
 * connect between `server.listen()` returning and the child executing the next
 * line, which is what made one Windows lane run read the tail before the notice
 * existed ([#173](https://github.com/Antruly/uvp/issues/173)). A module test is
 * the depth that can reproduce the helper's own semantics, so it is the depth
 * used here — the real lane still proves the notice appears, and these cases pin
 * what the wait does while it does not yet.
 */
const serviceWith = (writes: readonly (readonly [number, string])[]): Service => {
  const startedAt = Date.now();
  const written = (): string =>
    writes
      .filter(([at]) => Date.now() - startedAt >= at)
      .map(([, text]) => text)
      .join("");
  return {
    workspace: {
      name: "svc",
      template: "http3-service",
      port: 8095,
      root: "/nonexistent",
      buildDir: "/nonexistent/build",
      binary: "/nonexistent/build/svc",
    },
    pid: 1,
    output: written,
    stop: async () => ({ escalated: false, code: 0 }),
  };
};

const NOTICE = /HTTP\/3 over QUIC on UDP \d+/u;

describe("waitForOutput", () => {
  it("returns the output once the line is written, not before", async () => {
    const service = serviceWith([
      [0, "serving HTTPS with a generated self-signed certificate\n"],
      [40, "listening on https://127.0.0.1:8095 (TCP HTTP/1.1) and "],
      [80, "HTTP/3 over QUIC on UDP 8095\n"],
    ]);
    const beganAt = Date.now();
    const matched = await waitForOutput(service, NOTICE, 2_000);
    expect(matched).toContain("HTTP/3 over QUIC on UDP 8095");
    // The line is only written 80 ms in, so the wait cannot have returned it
    // before that: the time it took is the observation time, at or past the
    // write time, rather than an instantaneous sample that happened to be lucky.
    // This is the claim the case pins, no stronger — a stalled runner makes the
    // elapsed time larger, never smaller.
    expect(Date.now() - beganAt).toBeGreaterThanOrEqual(80);
  });

  it("returns undefined when the bound expires with no line, and keeps the tail", async () => {
    const service = serviceWith([[0, "serving HTTPS with a generated self-signed certificate\n"]]);
    expect(await waitForOutput(service, NOTICE, 60)).toBeUndefined();
    // The caller reports the tail beside the failure; the helper does not clear
    // it, so the reason a bound expired stays readable.
    expect(service.output()).toContain("generated self-signed certificate");
    expect(service.output()).not.toMatch(NOTICE);
  });
});
