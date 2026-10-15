import {
  asBoolean,
  asList,
  asNumber,
  asString,
  flagError,
  parseCsv,
  parseHeaders,
  parsePairs,
  requirePositional,
} from "../args.js";
import type { ParsedArgv } from "../args.js";
import type { CommandSpec } from "../commandSpec.js";
import { EXIT_NO, EXIT_WRONG } from "../exitCodes.js";
import { parseAssertionList } from "../assertionSyntax.js";
import { at, bool, list, num, obj, str } from "../readOutput.js";

/**
 * The web commands: http, ws, soap, load, assert, capture.
 *
 * The exit codes here run against the project commands' instinct. A web tool's
 * job is to report what a host did, and a 404, a rejected WebSocket upgrade, and
 * a SOAP fault are all *answers* — they exit 0 unless the caller asked a
 * question with a yes-or-no shape.
 *
 * `uvp assert` is that shape. It is the one command here whose whole purpose is a
 * verdict, so it is the one that exits 1 on a failure rather than reporting one.
 */

const tlsFlag = {
  name: "tls",
  type: "boolean" as const,
  description: "Verify the server certificate. On by default; --no-tls to skip.",
};

const timeoutFlag = {
  name: "timeout",
  type: "number" as const,
  value: "MS",
  description: "Give up after this long. Default 30000.",
};

/**
 * Include a field only when the caller supplied it, so contract defaults apply.
 *
 * Assigning `undefined` would not do: these objects are parsed by the contract,
 * and `{ timeout_ms: undefined }` reads as "the caller chose nothing", which is
 * indistinguishable from an absent key except in the one place it matters — the
 * strict schema.
 */
const optional = (key: string, value: unknown): Record<string, unknown> =>
  value === undefined ? {} : { [key]: value };

const headerFlags = {
  name: "header",
  type: "list" as const,
  value: "NAME:VALUE",
  description: "A request header. Repeatable.",
};

const headersOf = (parsed: ParsedArgv): Record<string, string> =>
  parseHeaders(asList(parsed, "header"));

const headersSection = (parsed: ParsedArgv): Record<string, unknown> => {
  const headers = headersOf(parsed);
  return Object.keys(headers).length === 0 ? {} : { headers };
};

export const httpCommand: CommandSpec = {
  path: ["http"],
  tool: "uvp_http_request",
  summary: "Send one HTTP request and print the full exchange.",
  usage:
    "uvp http [METHOD] URL [--header NAME:VALUE]... [--data BODY] [--form K=V]...\n" +
    "        [--http-version auto|1.1|2|3] [--follow] [--no-tls] [--timeout MS]\n" +
    "        [--max-bytes N] [--json]",
  positionals: [
    { name: "METHOD", description: "Optional HTTP method, before the URL. Default GET." },
    { name: "URL", description: "Absolute URL, including scheme." },
  ],
  flags: [
    headerFlags,
    { name: "data", type: "string", value: "BODY", description: "Raw request body." },
    {
      name: "form",
      type: "list",
      value: "K=V",
      description: "URL-encoded form field. Repeatable; sets the body and its content type.",
    },
    {
      name: "http-version",
      type: "string",
      value: "VERSION",
      description: "auto, 1.1, 2, or 3. The result reports what was actually used.",
    },
    { name: "follow", type: "boolean", description: "Follow redirects. Off by default." },
    {
      name: "max-redirects",
      type: "number",
      value: "N",
      description: "Stop following after N hops.",
    },
    tlsFlag,
    timeoutFlag,
    {
      name: "max-bytes",
      type: "number",
      value: "N",
      description: "Return at most this many body bytes; the rest is reported as truncated.",
    },
  ],
  notes: [
    "A 404 or a 500 exits 0. The call succeeded and the status is the answer. To make a status a",
    "condition of success, follow with `uvp assert --exchange <id> --assert status=200`.",
    "",
    "The method may be given or omitted: `uvp http GET URL` and `uvp http URL` are the same request.",
    "",
    "The response body is content from the target host. The renderer labels it; --json carries it",
    "verbatim in `body.text`.",
  ],
  input: (parsed) => {
    const { method, url } = methodAndUrl(parsed, "uvp http https://example.com/");
    return {
      url,
      method,
      ...headersSection(parsed),
      ...bodySection(parsed),
      ...optional("http_version", asString(parsed, "http-version")),
      ...optional("follow_redirects", asBoolean(parsed, "follow")),
      ...optional("max_redirects", asNumber(parsed, "max-redirects")),
      ...optional("timeout_ms", asNumber(parsed, "timeout")),
      ...optional("max_body_bytes", asNumber(parsed, "max-bytes")),
    };
  },
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * `uvp http GET URL` or `uvp http URL`.
 *
 * One positional must be a URL and two must be a method and a URL, so the shape
 * decides — with the method table as the check, because `uvp http localhost:8080`
 * is a typo worth catching rather than a GET to a host named "uvp".
 */
const methodAndUrl = (parsed: ParsedArgv, usage: string): { method: string; url: string } => {
  const first = requirePositional(parsed, 0, "a URL", usage);
  const second = parsed.positionals[1];
  if (second === undefined) return { method: "GET", url: first };
  if (!HTTP_METHODS.has(first.toUpperCase())) {
    flagError(`"${first}" is not an HTTP method, and two positionals were given.`, { usage });
  }
  return { method: first.toUpperCase(), url: second };
};

/** `--form` builds a body; `--data` supplies one. Both at once is a mistake worth naming. */
const bodySection = (parsed: ParsedArgv): Record<string, unknown> => {
  const data = asString(parsed, "data");
  const form = asList(parsed, "form");
  if (data !== undefined && form.length > 0) {
    flagError("--data and --form both set the request body. Pass one of them.");
  }
  if (data !== undefined) return { body: data };
  if (form.length === 0) return {};
  return {
    body: new URLSearchParams(parsePairs(form)).toString(),
    headers: { ...headersOf(parsed), "content-type": "application/x-www-form-urlencoded" },
  };
};

export const assertCommand: CommandSpec = {
  path: ["assert"],
  tool: "uvp_assert_exchange",
  summary: "Evaluate assertions against an exchange recorded earlier.",
  usage: "uvp assert --exchange EXCHANGE_ID --assert ASSERTION... [--json]",
  flags: [
    {
      name: "exchange",
      type: "string",
      value: "ID",
      description: "An exchange_id from an earlier call.",
    },
    {
      name: "assert",
      type: "list",
      value: "ASSERTION",
      description: "Check to evaluate. Repeatable; at least one is required.",
    },
  ],
  notes: [
    "No traffic is sent. The exchange is re-read from the session, which is what lets a check be",
    "re-run against a recorded baseline.",
    "",
    "This is where negated assertions belong: --assert '!status=200'. `uvp verify` does not accept",
    "them, because uvp_verify's contract has no field to carry the negation and it would be dropped.",
  ],
  input: (parsed) => {
    const exchangeId = asString(parsed, "exchange");
    if (exchangeId === undefined) {
      flagError("uvp assert needs --exchange ID.", {
        usage: "uvp assert --exchange exc_0123456789abcdefghijkl --assert status=200",
      });
    }
    const assertions = parseAssertionList(asList(parsed, "assert"));
    if (assertions.length === 0) {
      flagError("uvp assert needs at least one --assert.", {
        usage: "uvp assert --exchange exc_0123456789abcdefghijkl --assert status=200",
      });
    }
    return { exchange_id: exchangeId, assertions };
  },
  verdict: (output) => ((num(output["failed"]) ?? 0) > 0 ? EXIT_NO : undefined),
};

export const websocketCommand: CommandSpec = {
  path: ["ws"],
  tool: "uvp_websocket_probe",
  summary: "Open a WebSocket, send frames, and report the handshake and frame log.",
  usage:
    "uvp ws URL [--send TEXT]... [--header NAME:VALUE]... [--subprotocol NAME]...\n" +
    "       [--max-frames N] [--idle-timeout MS] [--expect-frame TEXT]... [--no-tls] [--json]",
  positionals: [{ name: "URL", description: "ws:// or wss:// URL." }],
  flags: [
    {
      name: "send",
      type: "list",
      value: "TEXT",
      description: "A frame to send, in the order given. Repeatable.",
    },
    headerFlags,
    {
      name: "subprotocol",
      type: "list",
      value: "NAME",
      description: "Offer this subprotocol. Repeatable.",
    },
    {
      name: "max-frames",
      type: "number",
      value: "N",
      description: "Stop after this many received frames. Default 10.",
    },
    {
      name: "idle-timeout",
      type: "number",
      value: "MS",
      description: "Stop after this long with no frame. Default 5000.",
    },
    tlsFlag,
    {
      name: "expect-frame",
      type: "list",
      value: "TEXT",
      description:
        "Require a received frame containing TEXT. Repeatable; exit 1 if one is missing.",
    },
  ],
  notes: [
    "With no --send the probe performs the handshake and stops. A 101 is a success and is reported",
    "as one — the frame log stays empty, which is not a failure.",
    "",
    "A rejected upgrade exits 1: the probe ran, and `upgraded: false` with the handshake response is",
    "its answer.",
    "",
    "--expect-frame is checked here rather than by the tool, and the frame log is printed either",
    "way — a failed expectation still leaves you the evidence.",
  ],
  input: (parsed) => {
    const url = requirePositional(parsed, 0, "a WebSocket URL", "uvp ws ws://127.0.0.1:8080/echo");
    const sends = asList(parsed, "send");
    const subprotocols = parseCsv(asList(parsed, "subprotocol"));
    return {
      url,
      ...headersSection(parsed),
      ...(subprotocols.length === 0 ? {} : { subprotocols }),
      ...(sends.length === 0 ? {} : { send: sends.map((payload) => ({ payload })) }),
      ...optional("max_frames", asNumber(parsed, "max-frames")),
      ...optional("idle_timeout_ms", asNumber(parsed, "idle-timeout")),
      ...optional("verify_tls", asBoolean(parsed, "tls")),
    };
  },
  verdict: (output) => (bool(output["upgraded"]) === true ? undefined : EXIT_NO),
  inspect: (output, parsed) => missingFrames(output, asList(parsed, "expect-frame")),
};

/**
 * Which `--expect-frame` values never arrived.
 *
 * Matched against received frames only. A frame this CLI sent is not evidence
 * that the far end said anything, and on an echo server the two are identical
 * strings — which is exactly the confusion the direction filter prevents.
 */
const missingFrames = (
  output: Record<string, unknown>,
  expected: readonly string[],
): string | undefined => {
  if (expected.length === 0) return undefined;
  const received = list(output["frames"])
    .map((frame) => obj(frame))
    .filter((frame) => frame["direction"] === "received")
    .map((frame) => str(frame["text"]));
  const missing = expected.filter((needle) => !received.some((text) => text.includes(needle)));
  return missing.length === 0
    ? undefined
    : `no received frame contained ${missing.map((text) => JSON.stringify(text)).join(", ")}`;
};

export const soapCommand: CommandSpec = {
  path: ["soap"],
  tool: "uvp_soap_call",
  summary: "Invoke a SOAP operation and report the result or the fault.",
  usage:
    "uvp soap ENDPOINT (--operation NAME [--namespace URI] [--param K=V]... | --body XML)\n" +
    "         [--action ACTION] [--version 1.1|1.2] [--header NAME:VALUE]... [--timeout MS] [--json]",
  positionals: [{ name: "ENDPOINT", description: "SOAP endpoint URL." }],
  flags: [
    { name: "operation", type: "string", value: "NAME", description: "Operation to invoke." },
    {
      name: "namespace",
      type: "string",
      value: "URI",
      description: "Target namespace of the operation.",
    },
    {
      name: "param",
      type: "list",
      value: "K=V",
      description: "An operation parameter. Repeatable.",
    },
    {
      name: "body",
      type: "string",
      value: "XML",
      description: "Send this envelope verbatim; overrides --operation and --param.",
    },
    {
      name: "version",
      type: "string",
      value: "VERSION",
      description: "SOAP 1.1 or 1.2. Default 1.1.",
    },
    { name: "action", type: "string", value: "ACTION", description: "SOAPAction header value." },
    headerFlags,
    timeoutFlag,
  ],
  notes: [
    "A SOAP fault exits 1 — not 0, and not 2. The call reached the service and the service answered",
    "`fault`, which is a definite negative.",
    "",
    "A transport error exits 2, because no protocol outcome exists to report. The renderer says",
    "which of the two happened; the status alone does not, since a fault is usually an HTTP 500.",
  ],
  input: (parsed) => {
    const endpoint = requirePositional(
      parsed,
      0,
      "an endpoint URL",
      "uvp soap https://svc.example.com/ws --operation GetQuote --namespace urn:example:quote",
    );
    const operation = asString(parsed, "operation");
    const envelope = asString(parsed, "body");
    if (operation === undefined && envelope === undefined) {
      flagError("uvp soap needs --operation or --body.", {
        usage: "uvp soap ENDPOINT --operation GetQuote --namespace urn:example:quote",
      });
    }
    const parameters = parsePairs(asList(parsed, "param"));
    return {
      endpoint,
      ...optional("soap_version", asString(parsed, "version")),
      ...optional("operation", operation),
      ...optional("namespace", asString(parsed, "namespace")),
      ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
      ...optional("raw_envelope", envelope),
      ...optional("soap_action", asString(parsed, "action")),
      ...headersSection(parsed),
      ...optional("timeout_ms", asNumber(parsed, "timeout")),
    };
  },
  verdict: (output) => {
    const outcome = str(output["outcome"]);
    if (outcome === "success") return undefined;
    // `transport_error` means nothing answered, so uvp could not put the question
    // to the service at all — that is the "wrong environment" code, not a "no".
    return outcome === "transport_error" ? EXIT_WRONG : EXIT_NO;
  },
};

export const loadCommand: CommandSpec = {
  path: ["load"],
  tool: "uvp_load_test",
  summary: "Measure latency under concurrency.",
  usage:
    "uvp load URL [METHOD] [--header NAME:VALUE]... [--data BODY]\n" +
    "         [--concurrency N] [--requests N] [--duration MS] [--warmup N]\n" +
    "         [--p99-under MS] [--max-error-rate PERCENT] [--max-samples N] [--no-tls]\n" +
    "         [--timeout MS] [--json]",
  positionals: [
    { name: "URL", description: "URL to request repeatedly." },
    { name: "METHOD", description: "Optional HTTP method. Default GET." },
  ],
  flags: [
    headerFlags,
    { name: "data", type: "string", value: "BODY", description: "Body sent with every request." },
    {
      name: "concurrency",
      type: "number",
      value: "N",
      description: "Simultaneous workers. Default 8.",
    },
    {
      name: "requests",
      type: "number",
      value: "N",
      description: "Stop after this many requests. Default 200.",
    },
    {
      name: "duration",
      type: "number",
      value: "MS",
      description: "Wall-clock budget. Whichever of this and --requests comes first wins.",
    },
    {
      name: "warmup",
      type: "number",
      value: "N",
      description: "Requests to discard before measuring.",
    },
    tlsFlag,
    timeoutFlag,
    {
      name: "p99-under",
      type: "number",
      value: "MS",
      description: "Exit 1 if the 99th percentile exceeds this.",
    },
    {
      name: "max-error-rate",
      type: "number",
      value: "PERCENT",
      description: "Exit 1 if more than this percentage of requests errored.",
    },
    {
      name: "max-samples",
      type: "number",
      value: "N",
      description: "Individual timings to keep and compute the distribution from. Default 10000.",
    },
  ],
  notes: [
    "The result is a distribution, never a single number: p50, p90, p95, p99, and a status",
    "histogram. There is deliberately no --mean flag; a mean without percentiles hides exactly the",
    "behaviour a load test is asking about.",
    "",
    "The individual timings come back with it, in the order they were taken, so a p99 can be traced",
    "to the measurement it came from. --max-samples bounds how many are kept; the count dropped is",
    "reported, and every number is computed from exactly the samples returned.",
    "",
    "Without --p99-under or --max-error-rate the run exits 0 whatever it measured. Those two flags",
    "are the whole of the pass/fail judgement, and the caller states them.",
  ],
  input: (parsed) => {
    const url = requirePositional(parsed, 0, "a URL", "uvp load http://127.0.0.1:8080/hello");
    const method = parsed.positionals[1];
    if (method !== undefined && !HTTP_METHODS.has(method.toUpperCase())) {
      flagError(`"${method}" is not an HTTP method.`, { usage: "uvp load URL GET --requests 200" });
    }
    return {
      url,
      ...optional("method", method?.toUpperCase()),
      ...headersSection(parsed),
      ...optional("body", asString(parsed, "data")),
      ...optional("concurrency", asNumber(parsed, "concurrency")),
      ...optional("requests", asNumber(parsed, "requests")),
      ...optional("duration_ms", asNumber(parsed, "duration")),
      ...optional("warmup_requests", asNumber(parsed, "warmup")),
      ...optional("timeout_ms", asNumber(parsed, "timeout")),
      ...optional("verify_tls", asBoolean(parsed, "tls")),
      ...optional("max_samples", asNumber(parsed, "max-samples")),
    };
  },
  verdict: (output, parsed) => {
    const p99Ceiling = asNumber(parsed, "p99-under");
    if (p99Ceiling !== undefined && (num(at(at(output, "latency_ms"), "p99")) ?? 0) > p99Ceiling) {
      return EXIT_NO;
    }
    const errorRate = asNumber(parsed, "max-error-rate");
    if (errorRate === undefined) return undefined;
    const sent = num(output["requests_sent"]) ?? 0;
    // No requests sent means no rate to compare, and a division by zero is not a
    // passing grade. The renderer reports the zero; the exit code stays out of it.
    if (sent === 0) return undefined;
    return ((num(output["requests_failed"]) ?? 0) / sent) * 100 > errorRate ? EXIT_NO : undefined;
  },
};

export const captureStartCommand: CommandSpec = {
  path: ["capture", "start"],
  tool: "uvp_capture_start",
  summary: "Start a capture session and print the proxy URL.",
  usage:
    "uvp capture start [UPSTREAM] [--listen PORT] [--host NAME]... [--method VERB]...\n" +
    "                  [--path-prefix P] [--max-exchanges N] [--auto-stop MS]\n" +
    "                  [--max-body-bytes N] [--json]",
  positionals: [
    { name: "UPSTREAM", description: "Origin to forward to. Omit for a transparent proxy." },
  ],
  flags: [
    {
      name: "listen",
      type: "number",
      value: "PORT",
      description: "Port to capture on. Default 8888.",
    },
    {
      name: "host",
      type: "list",
      value: "NAME",
      description: "Record only these hosts. Repeatable.",
    },
    {
      name: "method",
      type: "list",
      value: "VERB",
      description: "Record only these methods. Repeatable.",
    },
    {
      name: "path-prefix",
      type: "string",
      value: "P",
      description: "Record only paths beginning with this.",
    },
    {
      name: "max-exchanges",
      type: "number",
      value: "N",
      description: "Stop capturing once this many exchanges are recorded.",
    },
    {
      name: "auto-stop",
      type: "number",
      value: "MS",
      description: "Stop capturing after this long.",
    },
    {
      name: "max-body-bytes",
      type: "number",
      value: "N",
      description: "Record at most this many body bytes per direction. Default 1 MiB.",
    },
  ],
  notes: [
    "The session belongs to this uvp session, and `uvp stop --all` ends it along with any services.",
    "A capture that outlives the shell that started it is a port held by a process nobody is watching.",
    "`--max-body-bytes` bounds what is recorded, not what is forwarded: a captured request still reaches the origin whole, and one too large to forward whole is refused with 413 rather than sent short.",
  ],
  input: (parsed) => {
    const hosts = parseCsv(asList(parsed, "host"));
    const methods = parseCsv(asList(parsed, "method")).map((method) => method.toUpperCase());
    const pathPrefix = asString(parsed, "path-prefix");
    const filterEmpty = hosts.length === 0 && methods.length === 0 && pathPrefix === undefined;
    return {
      ...optional("listen_port", asNumber(parsed, "listen")),
      ...optional("upstream", parsed.positionals[0]),
      ...(filterEmpty
        ? {}
        : { filter: { hosts, methods, ...optional("path_prefix", pathPrefix) } }),
      ...optional("max_exchanges", asNumber(parsed, "max-exchanges")),
      ...optional("auto_stop_ms", asNumber(parsed, "auto-stop")),
      ...optional("max_body_bytes", asNumber(parsed, "max-body-bytes")),
    };
  },
  verdict: (output) => (str(output["proxy_url"]) === "" ? EXIT_NO : undefined),
};

export const captureReadCommand: CommandSpec = {
  path: ["capture", "read"],
  tool: "uvp_capture_read",
  summary: "List the exchanges a capture session recorded.",
  usage:
    "uvp capture read [--capture-id ID] [--since EXCHANGE_ID] [--limit N] [--payloads] [--stop] [--json]",
  flags: [
    {
      name: "capture-id",
      type: "string",
      value: "ID",
      description: "Defaults to the most recent session.",
    },
    {
      name: "since",
      type: "string",
      value: "EXCHANGE_ID",
      description: "Only exchanges recorded after this one.",
    },
    {
      name: "limit",
      type: "number",
      value: "N",
      description: "Return at most N exchanges. Default 100.",
    },
    { name: "payloads", type: "boolean", description: "Include request and response bodies." },
    { name: "stop", type: "boolean", description: "Stop the session after reading." },
  ],
  notes: [
    "`withheld_by_limit` counts the exchanges the limit held back. An empty list beside a non-zero",
    "count means the limit was too small — not that no traffic was seen.",
  ],
  input: (parsed) => ({
    ...optional("capture_id", asString(parsed, "capture-id")),
    ...optional("since_id", asString(parsed, "since")),
    ...optional("limit", asNumber(parsed, "limit")),
    ...optional("include_payloads", asBoolean(parsed, "payloads")),
    ...optional("stop", asBoolean(parsed, "stop")),
  }),
};
