import { describe, expect, it } from "vitest";

import { renderHttp } from "./cli/renderWeb.js";

/**
 * The human rendering is the second copy of a result, and the JSON on stdout is
 * the authoritative one — so it may drop fields but not say something the JSON
 * does not say. A truncated body is where that went wrong: `body.bytes` is the
 * whole response's length and was printed as the number of bytes "read", which
 * is the one number the truncation says was not read.
 */
const output = (limitations: readonly string[]): Record<string, unknown> => ({
  request: { method: "GET", url: "http://127.0.0.1/x" },
  status: 200,
  status_text: "OK",
  http_version: "1.1",
  request_http_version: "1.1",
  headers: {},
  redirects: [],
  tls: undefined,
  timing: { total_ms: 1 },
  body: {
    bytes: 1000,
    text: "A".repeat(10),
    truncated: true,
    content_type: "text/plain",
  },
  evidence: [{ kind: "exchange", coverage: { status: "complete" }, limitations }],
});

describe("the truncated-body line", () => {
  it("prints the cap the evidence states instead of the full body's length", () => {
    const rendered = renderHttp(
      output(["The response body was capped at 10 bytes; the digest is over the full body."]),
    ).join("\n");

    expect(rendered).not.toContain("only the first 1000");
    expect(rendered).toContain("capped at 10 bytes");
  });

  it("does not invent a read count when the evidence states no cap", () => {
    const rendered = renderHttp(output([])).join("\n");

    expect(rendered).not.toContain("only the first 1000");
    expect(rendered).toContain("prefix of the response body (1000 B total)");
  });
});
