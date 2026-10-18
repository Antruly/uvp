/**
 * libuvcpp's version floor, and what to tell someone who has none.
 *
 * The floor is a fact three layers state to a caller: the generated CMake
 * requires `uvcpp>=1.7.0` on both routes, the workspace manifest records the same
 * requirement, and the documentation names it. Keeping one spelling of the number
 * is what makes those agree; it lives in `domain` for the same reason the feature
 * vocabulary does.
 *
 * The remedy is here rather than beside the build diagnostic that first needed it
 * because two boundaries give it: `uvp build`, where CMake reports the missing
 * package, and `uvp doctor`, where discovery reports no install at all. One text,
 * two renderers, so a reader who meets either gets the same URL, the same version
 * floor, and the same environment variables.
 */
export const LIBUVCPP_BASELINE = "1.7.0";

/** Where the prebuilt archives and source tags are published. */
export const LIBUVCPP_RELEASES_URL = "https://github.com/Antruly/libuvcpp/releases";

/**
 * How to get an install the generated project can find.
 *
 * Names both discovery routes because the caller has not told us which one they
 * want: a release archive is answered by `UVCPP_ROOT`/`PKG_CONFIG_PATH`, a source
 * install by `CMAKE_PREFIX_PATH`, and the verification command is the same for
 * both.
 */
export const LIBUVCPP_INSTALL_REMEDIATION = {
  action:
    `Install libuvcpp ${LIBUVCPP_BASELINE} or newer: unpack a release from ` +
    `${LIBUVCPP_RELEASES_URL} (or build and install it from source), set ` +
    "UVCPP_ROOT (or CMAKE_PREFIX_PATH) and PKG_CONFIG_PATH, verify with " +
    "`pkg-config --modversion uvcpp`, then re-run `uvp build` — `uvp doctor` " +
    "confirms the host is ready.",
  docs: "docs/installation.md#libuvcpp",
} as const;
