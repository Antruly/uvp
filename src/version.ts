import { PACKAGE_NAME, PACKAGE_VERSION } from "./generatedPackageMetadata.js";

/**
 * The version this build reports.
 *
 * Re-exported rather than read from `package.json` at runtime: a published
 * tarball's `dist/` is not guaranteed to sit next to its `package.json` once a
 * bundler or a monorepo tool has moved things around, and a `--version` that
 * throws is worse than one that is stale by a release.
 *
 * The value is generated from `package.json` by the build, so the only way for
 * it to drift is for the generated file to be stale — which `npm run
 * metadata:check` fails on.
 */
export const uvpVersion = (): string => PACKAGE_VERSION;

/** `uvp-agents 0.1.0`, for banners and MCP server metadata. */
export const uvpVersionBanner = (): string => `${PACKAGE_NAME} ${PACKAGE_VERSION}`;
