/**
 * The toolchain vocabulary.
 *
 * A kind names *where* a workspace is compiled, which is a question the caller
 * can answer and the compiler cannot: the same source built by the same CMake
 * produces different binaries on this host and inside an image, and an artifact
 * that cannot run where it was written back to is a fact about the choice rather
 * than about the code.
 *
 * It lives in `domain` for the same reason the feature vocabulary does: the
 * manifest reads it, both tool contracts validate against it, and the
 * composition root maps it onto concrete providers. One closed set, three
 * readers — a kind added here and forgotten elsewhere fails to typecheck instead
 * of becoming a request that quietly builds somewhere else.
 */
export const TOOLCHAIN_KINDS = [
  /** This host's own compilers. */
  "local",
  /** A container image, named by the workspace. */
  "container",
] as const;

export type ToolchainKind = (typeof TOOLCHAIN_KINDS)[number];

export const isToolchainKind = (value: unknown): value is ToolchainKind =>
  typeof value === "string" && (TOOLCHAIN_KINDS as readonly string[]).includes(value);

/**
 * One toolchain, named.
 *
 * The same type describes what a workspace declares and what a call ends up
 * using, on purpose: a build's toolchain and the workspace's declaration are
 * compared by readers and by tests, and two vocabularies for one question is how
 * those comparisons start disagreeing.
 *
 * A union rather than a kind plus an optional image, because the two variants
 * carry different obligations: `container` without an image is not a partial
 * container toolchain, it is a declaration nothing can act on, and that is
 * checkable at the boundary that reads it rather than at every use.
 */
export type ToolchainSelection =
  | { readonly kind: "local" }
  | { readonly kind: "container"; readonly image: string };
