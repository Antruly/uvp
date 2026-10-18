import { describe, expect, it } from "vitest";

import {
  DEFAULT_EVENT_PAYLOAD_POLICY,
  UVP_EVENT_PAYLOAD_POLICIES,
  isUvpEventPayloadPolicy,
} from "./eventPayloadPolicy.js";

/**
 * The policy is a closed vocabulary, and the default is the non-verbatim one.
 *
 * The value reaches three places — the generated source, `uvp.json`, and the
 * events endpoint — so a name that only one of them understood would be a
 * workspace whose report disagreed with its code.
 */
describe("event payload policies", () => {
  it("recognises exactly the declared policies", () => {
    expect(UVP_EVENT_PAYLOAD_POLICIES).toEqual(["summary", "verbatim"]);
    for (const policy of UVP_EVENT_PAYLOAD_POLICIES)
      expect(isUvpEventPayloadPolicy(policy)).toBe(true);
    expect(isUvpEventPayloadPolicy("")).toBe(false);
    expect(isUvpEventPayloadPolicy("Summary")).toBe(false);
  });

  it("defaults to summary, which retains no message body", () => {
    expect(DEFAULT_EVENT_PAYLOAD_POLICY).toBe("summary");
  });
});
