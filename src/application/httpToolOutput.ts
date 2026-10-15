import type { TlsVerification } from "./httpClient.js";

/**
 * What `uvp_http_request` returns, declared once.
 *
 * The tool can be answered over two transports and they share nothing underneath:
 * HTTP/1.1 and HTTP/2 come from Node in this process, HTTP/3 comes from the native
 * probe in another one. What they do share is this shape, and it is a named type
 * rather than two object literals that happen to match because the contract's
 * output schema is the thing both are held to — a second branch written against
 * "the other one looks like this" is how two transports end up reporting the same
 * field under two names.
 *
 * The fields are optional in the places a transport genuinely has nothing to say,
 * and never to paper over a gap: `tls` is absent for a cleartext exchange because
 * there was no TLS, and `text`/`base64` are alternatives because a body is one or
 * the other.
 */

/** The certificate an exchange happened under, when one was examined. */
export interface ToolTlsReport {
  protocol?: string;
  cipher?: string;
  subject?: string;
  issuer?: string;
  valid_from?: string;
  valid_to?: string;
  verification: TlsVerification;
  reason?: string;
}

/** How long the exchange took, per phase where the transport could see one. */
export interface TimingOutput {
  dns_ms?: number;
  connect_ms?: number;
  tls_ms?: number;
  ttfb_ms?: number;
  total_ms: number;
}

export interface HttpRequestOutput {
  exchange_id: string;
  request: { method: string; url: string };
  status: number;
  status_text: string;
  http_version: string;
  request_http_version: string;
  headers: Record<string, string>;
  timing: TimingOutput;
  body: {
    bytes: number;
    content_type?: string;
    text?: string;
    base64?: string;
    truncated: boolean;
    decoded_as_text: boolean;
    digest: string;
  };
  redirects: { status: number; location: string }[];
  tls?: ToolTlsReport;
}
