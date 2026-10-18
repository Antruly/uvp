/**
 * The payload policy of the evidence log.
 *
 * A generated service's evidence log keeps a bounded number of events. What it
 * keeps of a message payload is a separate decision, and this is its closed
 * vocabulary: `summary` stores a length and a hash (and a hex prefix for binary
 * frames), `verbatim` stores the text a peer sent. The policy is compiled into
 * the generated source, written to `uvp.json`, and reported by the events
 * endpoint, so a reader of either can tell what the events do and do not
 * contain without reading the source.
 *
 * `summary` is the default because a log that is meant to correlate traffic
 * should not retain message bodies unless the workspace's owner asked for them.
 * The choice belongs to the workspace rather than to the reader of the endpoint:
 * a policy a request could change at read time would describe the caller, not
 * what was collected.
 */
export const UVP_EVENT_PAYLOAD_POLICIES = ["summary", "verbatim"] as const;

export type UvpEventPayloadPolicy = (typeof UVP_EVENT_PAYLOAD_POLICIES)[number];

export const DEFAULT_EVENT_PAYLOAD_POLICY: UvpEventPayloadPolicy = "summary";

export const isUvpEventPayloadPolicy = (value: string): value is UvpEventPayloadPolicy =>
  (UVP_EVENT_PAYLOAD_POLICIES as readonly string[]).includes(value);
