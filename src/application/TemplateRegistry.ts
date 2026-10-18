import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";

import { compareTemplateVersions } from "../domain/templatePackage.js";
import {
  compareTemplateRegistryIds,
  parseTemplateRegistryIndex,
  type TemplateRegistryIndex,
  type TemplateRegistryValidation,
  type TemplateRegistryVersion,
} from "../domain/templateRegistry.js";
import {
  prepareTemplateCriteria,
  templateMetadataMatches,
  templateMetadataScore,
  type TemplateSearchQuery,
} from "./templateDiscovery.js";
import { resolveTemplateStoreRoot } from "./TemplateStore.js";

/**
 * The registry client's read side (#239): index fetch, offline cache, and
 * deterministic search over the metadata.
 *
 * ## The three states
 *
 * A registry read is one of:
 *
 * - **network** — the index was fetched and validated now;
 * - **cache** — the network read failed, and the last good index is returned
 *   with the failure named in `staleReason`; the answer is old, not empty;
 * - **undetermined** — neither the network nor a cache answered. This is not
 *   `matches: []`: an unavailable registry is reported as unavailable, and a
 *   caller must not present it as "there are no packages" or "no updates".
 *
 * Nothing here downloads a package or verifies file bytes; the index carries
 * metadata only, and a returned `digest` is the registry's claim about the
 * manifest. Download, checksum verification, sync, and the CLI/MCP surface are
 * later increments.
 *
 * ## Bounds
 *
 * The response body and the cached file are both capped by `maxBytes` before
 * they are parsed, and the request is aborted after `timeoutMs`. A `200` whose
 * body exceeds the cap is a failure, not a truncated index.
 *
 * ## Proxied hosts
 *
 * `node:http`/`node:https` do not read `HTTP_PROXY`/`HTTPS_PROXY` unless the
 * process starts with `NODE_USE_ENV_PROXY=1` (observed on Node 24). On a host
 * that only reaches the registry through a proxy, the default transport
 * therefore fails with the connection error and the read is reported as
 * `undetermined` — never as an empty registry. A caller that needs its own
 * proxy handling injects a transport.
 */

export const DEFAULT_TEMPLATE_REGISTRY_INDEX_URL =
  "https://raw.githubusercontent.com/Antruly/uvp-templates/main/index.json";

export const DEFAULT_TEMPLATE_REGISTRY_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TEMPLATE_REGISTRY_TIMEOUT_MS = 10_000;

const MAX_REDIRECTS = 3;
const CACHE_DIRECTORY = ".registry";
const CACHE_FILE = "index.json";

export type TemplateRegistryFailureCode =
  | "unreachable"
  | "http_status"
  | "body_limit"
  | "timeout"
  | "invalid_json"
  | "invalid_index"
  | "cache_io";

export class TemplateRegistryError extends Error {
  readonly code: TemplateRegistryFailureCode;
  readonly details: readonly string[];

  constructor(code: TemplateRegistryFailureCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "TemplateRegistryError";
    this.code = code;
    this.details = details;
  }
}

export interface TemplateRegistryRequest {
  readonly url: string;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface TemplateRegistryResponse {
  readonly status: number;
  readonly body: Buffer;
  /** The final URL after redirects, for diagnostics. */
  readonly url: string;
}

/** The seam tests use to serve a fixture index without a real network. */
export type TemplateRegistryTransport = (
  request: TemplateRegistryRequest,
) => Promise<TemplateRegistryResponse>;

export interface TemplateRegistryOptions {
  /** Defaults to the first-party registry's raw index. */
  readonly indexUrl?: string;
  readonly transport?: TemplateRegistryTransport;
  /** Defaults to `<template store root>/.registry`. */
  readonly cacheRoot?: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Skip the network and read only the cache; the cache is then not "stale". */
  readonly offline?: boolean;
}

export interface TemplateRegistryIndexRead {
  readonly state: "read";
  readonly source: "network" | "cache";
  readonly index: TemplateRegistryIndex;
  readonly url: string;
  /** Why the network read failed when `source` is `cache`. */
  readonly staleReason?: string;
  /** A cache write that failed; the returned index is still the network's. */
  readonly cacheError?: string;
}

export interface TemplateRegistryIndexUnavailable {
  readonly state: "undetermined";
  readonly url: string;
  /** Never "the registry is empty": the index could not be read. */
  readonly reason: string;
  readonly details: readonly string[];
}

export type TemplateRegistryIndexResult =
  | TemplateRegistryIndexRead
  | TemplateRegistryIndexUnavailable;

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const describeError = (error: unknown): string => {
  if (error instanceof TemplateRegistryError) return error.message;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "the request timed out";
    }
    return error.message;
  }
  return String(error);
};

const cachePathOf = (options: TemplateRegistryOptions): string =>
  path.join(
    options.cacheRoot ?? path.join(resolveTemplateStoreRoot(), CACHE_DIRECTORY),
    CACHE_FILE,
  );

interface SingleResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly location?: string;
}

const once = (url: URL, maxBytes: number, signal: AbortSignal): Promise<SingleResponse> =>
  new Promise((resolve, reject) => {
    const request = url.protocol === "http:" ? httpRequest : httpsRequest;
    const request_ = request(
      url,
      { method: "GET", headers: { accept: "application/json" }, signal },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400) {
          // A redirect body is not the index; do not buffer it against the cap.
          response.resume();
          resolve({
            status,
            body: Buffer.alloc(0),
            ...(location === undefined ? {} : { location }),
          });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          response.destroy();
          request_.destroy();
          reject(error);
        };
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > maxBytes) {
            fail(
              new TemplateRegistryError(
                "body_limit",
                `the registry response is larger than ${maxBytes} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status, body: Buffer.concat(chunks) });
        });
        response.on("error", (error) =>
          fail(error instanceof Error ? error : new Error(String(error))),
        );
      },
    );
    request_.on("error", reject);
    request_.end();
  });

/**
 * The default transport: one GET, following up to three redirects. It refuses a
 * non-http(s) redirect target rather than handing a `file:` URL to the request
 * implementation.
 */
export const defaultTemplateRegistryTransport: TemplateRegistryTransport = async (request) => {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new TemplateRegistryError("unreachable", `'${request.url}' is not a URL`);
  }
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TemplateRegistryError(
        "unreachable",
        `'${url.toString()}' is not an http or https URL`,
      );
    }
    let response: SingleResponse;
    try {
      response = await once(url, request.maxBytes, request.signal);
    } catch (error) {
      if (error instanceof TemplateRegistryError) throw error;
      if (request.signal.aborted) {
        throw new TemplateRegistryError("timeout", "the registry request timed out");
      }
      const code = codeOf(error);
      throw new TemplateRegistryError(
        "unreachable",
        describeError(error),
        code === undefined ? [] : [code],
      );
    }
    if (response.status >= 300 && response.status < 400) {
      if (response.location === undefined) {
        throw new TemplateRegistryError(
          "http_status",
          `the registry answered HTTP ${response.status} without a Location header`,
        );
      }
      url = new URL(response.location, url);
      continue;
    }
    if (response.status !== 200) {
      throw new TemplateRegistryError(
        "http_status",
        `the registry answered HTTP ${response.status}`,
      );
    }
    return { status: response.status, body: response.body, url: url.toString() };
  }
  throw new TemplateRegistryError("http_status", "the registry redirected too many times");
};

const parseBody = (body: Buffer): TemplateRegistryValidation => {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new TemplateRegistryError(
      "invalid_json",
      `the registry index is not JSON: ${describeError(error)}`,
    );
  }
  return parseTemplateRegistryIndex(value);
};

const readCache = async (
  cachePath: string,
  maxBytes: number,
): Promise<
  | { readonly kind: "read"; readonly index: TemplateRegistryIndex }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly reason: string; readonly details: readonly string[] }
> => {
  let info;
  try {
    info = await stat(cachePath);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { kind: "absent" };
    return {
      kind: "invalid",
      reason: `the cached index could not be stat'ed`,
      details: [describeError(error)],
    };
  }
  if (info.size > maxBytes) {
    return {
      kind: "invalid",
      reason: `the cached index is larger than ${maxBytes} bytes`,
      details: [],
    };
  }
  let body: Buffer;
  try {
    body = await readFile(cachePath);
  } catch (error) {
    return {
      kind: "invalid",
      reason: "the cached index could not be read",
      details: [describeError(error)],
    };
  }
  let validation: TemplateRegistryValidation;
  try {
    validation = parseBody(body);
  } catch (error) {
    return {
      kind: "invalid",
      reason: "the cached index could not be parsed",
      details: [describeError(error)],
    };
  }
  if (!validation.ok) {
    return {
      kind: "invalid",
      reason: "the cached index is not a valid uvp.registry/1 index",
      details: validation.problems.map((problem) =>
        problem.location === "" ? problem.message : `${problem.location}: ${problem.message}`,
      ),
    };
  }
  return { kind: "read", index: validation.index };
};

const writeCache = async (cachePath: string, body: Buffer): Promise<string | undefined> => {
  const directory = path.dirname(cachePath);
  const temporary = path.join(directory, `.${CACHE_FILE}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, body);
    await rename(temporary, cachePath);
    return undefined;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return `the registry index could not be cached at ${cachePath}: ${describeError(error)}`;
  }
};

/**
 * Read the index: network first, then the last good cached copy.
 *
 * A successful network read refreshes the cache. A cache write failure is
 * reported in `cacheError` but does not fail a read that succeeded. `offline`
 * skips the network entirely; a cache hit is then current, not stale, and a
 * miss is `undetermined` with that reason.
 */
export const readTemplateRegistryIndex = async (
  options: TemplateRegistryOptions = {},
): Promise<TemplateRegistryIndexResult> => {
  const url = options.indexUrl ?? DEFAULT_TEMPLATE_REGISTRY_INDEX_URL;
  const maxBytes = options.maxBytes ?? DEFAULT_TEMPLATE_REGISTRY_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEMPLATE_REGISTRY_TIMEOUT_MS;
  const cachePath = cachePathOf(options);

  let networkFailure: { readonly reason: string; readonly details: readonly string[] } | undefined;
  if (options.offline !== true) {
    try {
      const transport = options.transport ?? defaultTemplateRegistryTransport;
      const response = await transport({
        url,
        maxBytes,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        throw new TemplateRegistryError(
          "http_status",
          `the registry answered HTTP ${response.status}`,
        );
      }
      const validation = parseBody(response.body);
      if (!validation.ok) {
        throw new TemplateRegistryError(
          "invalid_index",
          "the registry index is not a valid uvp.registry/1 index",
          validation.problems.map((problem) =>
            problem.location === "" ? problem.message : `${problem.location}: ${problem.message}`,
          ),
        );
      }
      const cacheError = await writeCache(cachePath, response.body);
      return {
        state: "read",
        source: "network",
        index: validation.index,
        url,
        ...(cacheError === undefined ? {} : { cacheError }),
      };
    } catch (error) {
      networkFailure = {
        reason: describeError(error),
        details: error instanceof TemplateRegistryError ? error.details : [],
      };
    }
  }

  const cached = await readCache(cachePath, maxBytes);
  if (cached.kind === "read") {
    return {
      state: "read",
      source: "cache",
      index: cached.index,
      url,
      ...(options.offline === true
        ? {}
        : { staleReason: networkFailure?.reason ?? "the network read did not run" }),
    };
  }

  const details: string[] = [...(networkFailure?.details ?? [])];
  if (cached.kind === "invalid") {
    details.push(
      `${cached.reason}${cached.details.length === 0 ? "" : `: ${cached.details.join("; ")}`}`,
    );
  } else {
    details.push(`no cached index exists at ${cachePath}`);
  }
  return {
    state: "undetermined",
    url,
    reason:
      networkFailure?.reason ??
      (options.offline === true
        ? "the client is offline and the cache does not hold an index"
        : "the registry could not be read and no cached index exists"),
    details,
  };
};

export interface TemplateRegistrySearchMatch {
  readonly id: string;
  readonly latest: string;
  readonly version: string;
  readonly name: string;
  readonly description?: string;
  readonly category: TemplateRegistryVersion["category"];
  readonly framework?: TemplateRegistryVersion["framework"];
  readonly tags?: readonly string[];
  readonly requires?: TemplateRegistryVersion["requires"];
  readonly license?: TemplateRegistryVersion["license"];
  readonly provenance?: TemplateRegistryVersion["provenance"];
  /** Repository-relative package directory from the index. */
  readonly path: string;
  readonly digest: string;
  readonly file_count: number;
  readonly score: number;
  readonly matched_on: readonly string[];
}

export interface TemplateRegistrySearchPage {
  readonly matches: readonly TemplateRegistrySearchMatch[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly truncated: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

/**
 * Search one validated index. Pure: the caller has already decided how the
 * index was obtained, and the result cannot imply a network read.
 */
export const searchRegistryIndex = (
  index: TemplateRegistryIndex,
  query: TemplateSearchQuery = {},
): TemplateRegistrySearchPage => {
  const criteria = prepareTemplateCriteria(query);
  const limit = boundedInteger(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const candidates: {
    readonly pkg: TemplateRegistryIndex["packages"][number];
    readonly entry: TemplateRegistryVersion;
  }[] = [];
  for (const pkg of index.packages) {
    if (query.version !== undefined) {
      const exact = pkg.versions.filter((version) => version.version === query.version);
      for (const entry of exact) candidates.push({ pkg, entry });
      continue;
    }
    if (query.allVersions === true) {
      for (const entry of pkg.versions) candidates.push({ pkg, entry });
      continue;
    }
    const latest = pkg.versions.find((version) => version.version === pkg.latest);
    if (latest !== undefined) candidates.push({ pkg, entry: latest });
  }

  const scored = candidates
    .filter(({ pkg, entry }) => templateMetadataMatches({ ...entry, id: pkg.id }, criteria))
    .map(({ pkg, entry }) => {
      const { score, matchedOn } = templateMetadataScore({ ...entry, id: pkg.id }, criteria);
      return { pkg, entry, score, matchedOn };
    });
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      compareTemplateRegistryIds(left.pkg.id, right.pkg.id) ||
      compareTemplateVersions(right.entry.version, left.entry.version),
  );

  const page = scored.slice(offset, offset + limit);
  return {
    matches: page.map(({ pkg, entry, score, matchedOn }) => ({
      id: pkg.id,
      latest: pkg.latest,
      version: entry.version,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      category: entry.category,
      ...(entry.framework === undefined ? {} : { framework: entry.framework }),
      ...(entry.tags === undefined ? {} : { tags: entry.tags }),
      ...(entry.requires === undefined ? {} : { requires: entry.requires }),
      license: entry.license,
      provenance: entry.provenance,
      path: entry.path,
      digest: entry.digest,
      file_count: entry.files.length,
      score,
      matched_on: matchedOn,
    })),
    total: scored.length,
    offset,
    limit,
    truncated: offset + page.length < scored.length,
  };
};

export type TemplateRegistrySearchResult =
  | ({
      readonly state: "read";
      readonly source: "network" | "cache";
      readonly staleReason?: string;
    } & TemplateRegistrySearchPage)
  | {
      readonly state: "undetermined";
      readonly reason: string;
      readonly details: readonly string[];
    };

/**
 * Read the index and search it. An unreachable registry with no cache returns
 * `state: "undetermined"`; it never returns an empty page that a caller could
 * read as "the registry holds no matching packages".
 */
export const searchTemplateRegistry = async (
  query: TemplateSearchQuery = {},
  options: TemplateRegistryOptions = {},
): Promise<TemplateRegistrySearchResult> => {
  const read = await readTemplateRegistryIndex(options);
  if (read.state === "undetermined") {
    return { state: "undetermined", reason: read.reason, details: read.details };
  }
  const page = searchRegistryIndex(read.index, query);
  return {
    state: "read",
    source: read.source,
    ...(read.staleReason === undefined ? {} : { staleReason: read.staleReason }),
    ...page,
  };
};
