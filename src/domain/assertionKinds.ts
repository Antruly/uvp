/**
 * The assertion vocabulary.
 *
 * This lives in `domain` rather than beside the evaluator for the same reason
 * `UVP_FEATURES` does: it is a shared vocabulary, not an implementation detail.
 * Three layers name it — the evaluator that implements each kind, the tool
 * contracts that validate a request against it, and the CLI syntax that lowers
 * the short forms onto it — and `contracts` may import from `domain` but never
 * from `application`. Keeping the closed set here is what stops those three from
 * drifting apart, which they did: `uvp_verify`'s contract listed eight of these
 * eleven by hand, so three forms the CLI's own syntax module lowers were
 * accepted by the parser and then rejected by the contract that governs the
 * call.
 *
 * The order is the order they are documented in, not an evaluation order.
 */
export const ASSERTION_KINDS = [
  /** The response status equals one code. */
  "status_equals",
  /** The response status is one of a set, which is how `status=2xx` lowers. */
  "status_in",
  /** A response header has exactly this value. */
  "header_equals",
  /** A response header matches a regular expression. */
  "header_matches",
  /** A response header is present, whatever its value. */
  "header_exists",
  /** The raw body contains this substring. */
  "body_contains",
  /** The raw body matches a regular expression. */
  "body_matches",
  /** A JSON path in the body, compared after parsing. */
  "body_json_path_equals",
  /** A JSON path in the body is present, whatever its value. */
  "body_json_path_exists",
  /** The raw body is smaller than this many bytes. */
  "body_bytes_under",
  /** The exchange took less than this many milliseconds. */
  "latency_under_ms",
  /**
   * The protocol version the response actually arrived in.
   *
   * The one assertion that says whether a transport was exercised rather than
   * whether the service answered. Every other kind here is satisfied by a
   * response; this one is satisfied only by a response that came back over the
   * version asked for — so a service that serves HTTP/1.1 whatever it is sent
   * cannot pass it, and asking for HTTP/2 and getting a green result over
   * HTTP/1.1 stops being possible.
   *
   * It compares the version **as observed**, spelled the way the wire spells it:
   * `"1.1"`, `"2.0"`. That is deliberately not the spelling of
   * `uvp_http_request`'s `http_version` input, which names the version to
   * *attempt* (`"2"`). One is what was asked for and the other is what happened;
   * collapsing them into one string is how a caller ends up asserting on their
   * own request. A failure names the value to write.
   */
  "http_version_equals",
] as const;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];
