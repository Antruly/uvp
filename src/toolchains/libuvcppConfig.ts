import { join } from "node:path";

/**
 * What an installed libuvcpp build says about itself.
 *
 * The installed `uvcpp_config.h` is written at configure time by the build that
 * produced it, so it describes *that* build rather than the version it claims to
 * be. Two 1.7.0 installs can differ in whether HTTP/3 was compiled in, which is
 * why a capability question is answered from this header and never from a
 * version number.
 *
 * ## Why this is a module and not a provider method
 *
 * Reading it is the same question in every provider, and the answer has to be
 * the same or the providers disagree about the same install. A container
 * provider cannot use a *host* file read — the header is inside the image — but
 * it can use everything here: the layouts to look in, and the rule for reading a
 * header's text. So the text rule and the layouts are shared and only the "get
 * me this file" step belongs to each provider.
 */

/**
 * Where an install may keep its config header, relative to the prefix, in the
 * order to try.
 *
 * **What is observed:** libuvcpp's own release archives put it at
 * `include/uvcpp/uvcpp_config.h`, and that is the layout of both the 1.7.0 and
 * the 1.4.4 archive installed on this machine. That is the layout this list
 * tries first, and it is the only one either of them has been *seen* to use.
 *
 * **What is tolerance:** the two layouts after it — a flattened `include/`, and
 * a config header at the prefix root — are accepted because a prefix laid out by
 * a packager or by a hand-rolled install script can plausibly put it there, and
 * trying a layout costs one failed `stat` inside a loop that is already running.
 * No install using either has been observed here, and the order is what keeps
 * that harmless: the observed layout wins in any prefix that has both, so a
 * speculative layout can never decide which install answered.
 *
 * Relative, as path segments, so each caller joins them its own way. That is not
 * fussiness: a container provider resolves these *inside a Linux image*, where
 * the separator is `/` whatever host uvp is running on, so handing it
 * `path.join` output would produce backslash paths on Windows that no shell in
 * the image could open. The layouts are shared knowledge; the joining is not.
 */
export const CONFIG_HEADER_RELATIVE_PATHS: readonly (readonly string[])[] = [
  ["include", "uvcpp", "uvcpp_config.h"],
  ["include", "uvcpp_config.h"],
  ["uvcpp_config.h"],
];

/** The same layouts resolved against a prefix on *this* host. */
export const configHeaderPaths = (installPrefix: string): readonly string[] =>
  CONFIG_HEADER_RELATIVE_PATHS.map((segments) => join(installPrefix, ...segments));

/**
 * The `UVCPP_*` symbols a config header defines as exactly `1`.
 *
 * "Exactly 1" is the whole rule, and it is narrower than it looks. The header
 * also carries symbols that are *not* modules — `UVCPP_TRY_WRITE_MIN_BYTES` is a
 * byte count, and `UVCPP_HTTP_COMPRESS_ENABLE (1 || 1)` is an expression rather
 * than a `1` — so matching `UVCPP_` alone would report a buffer size as a
 * capability. An earlier description of this called them "the `*_ENABLE` macros",
 * which is also wrong: 1.7.0's header defines `UVCPP_ENABLE_MEMORY_POOL` and
 * `UVCPP_DB_RUNTIME_LOAD`, and the reader was right while the sentence was not.
 *
 * A missing or unreadable header is the caller's problem, not this function's:
 * it is handed text, and an empty result from empty text is honest rather than a
 * fallback.
 */
export const modulesFromConfigHeader = (text: string): readonly string[] => {
  const modules: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*#\s*define\s+([A-Z0-9_]+)\s+1\b/u.exec(line);
    const symbol = match?.[1];
    if (symbol !== undefined && symbol.startsWith("UVCPP_")) modules.push(symbol);
  }
  return modules.sort();
};

/**
 * The version `uvcpp_version.h` declares, or `undefined` if it is not there.
 *
 * Three integers rather than one string. The header computes its own
 * `UVCPP_VERSION_STRING` by pasting them together through `UVCPP_STRINGIFY`, so
 * the string form is not readable text in the file — it is assembled by the
 * preprocessor, and reading it would mean running one. The numbers are literal
 * and are what this reads.
 *
 * Deliberately not applied to `uvcpp_config.h`: that header is read for modules,
 * and `UVCPP_VERSION_IS_RELEASE` is defined as `1` there in some layouts, which
 * the module rule would report as a compiled-in feature. The two questions are
 * asked of two files.
 */
export const versionFromVersionHeader = (text: string): string | undefined => {
  const part = (name: string): string | undefined =>
    new RegExp(`^\\s*#\\s*define\\s+${name}\\s+(\\d+)`, "mu").exec(text)?.[1];
  const major = part("UVCPP_VERSION_MAJOR");
  const minor = part("UVCPP_VERSION_MINOR");
  const patch = part("UVCPP_VERSION_PATCH");
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return `${major}.${minor}.${patch}`;
};
