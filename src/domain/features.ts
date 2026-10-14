/**
 * The libuvcpp feature vocabulary.
 *
 * This lives in `domain` rather than beside the toolchain code because it is a
 * shared vocabulary, not an implementation detail: tool contracts validate
 * against it, templates are parameterised by it, and the toolchain layer maps it
 * onto real build switches. Keeping the closed set here is what stops those
 * three from drifting apart — a feature added in one place and forgotten in
 * another becomes a change that fails to typecheck rather than a request that
 * silently builds without the module it asked for.
 *
 * The names are uvp's own, chosen for what a caller wants. They deliberately do
 * not match libuvcpp's internal module names, which are about how the library is
 * built rather than about what the caller is asking for.
 */
export const UVP_FEATURES = [
  /** TLS termination and `https://`. */
  "tls",
  /** HTTP/2 transport. */
  "http2",
  /** HTTP/3 over QUIC. */
  "http3",
  /** gRPC services. */
  "grpc",
  /** WebSocket routes on the same listener as HTTP. */
  "websocket",
  /** SOAP 1.1/1.2 endpoints. */
  "soap",
  /** The database module. */
  "db",
] as const;

export type UvpFeature = (typeof UVP_FEATURES)[number];

export const isUvpFeature = (value: string): value is UvpFeature =>
  (UVP_FEATURES as readonly string[]).includes(value);
