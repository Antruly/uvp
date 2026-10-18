import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MsvcLocatorResult } from "./LocalToolchainProvider.js";
import { LocalToolchainProvider } from "./LocalToolchainProvider.js";

/**
 * What the provider does when Visual Studio's locator does not answer.
 *
 * The branch only runs on Windows and only when no compiler is on `PATH`, and
 * the states it must tell apart — a locator that timed out, one that could not
 * start, one that answered and named no toolset — cannot be produced on demand
 * from a Linux host. Mocking the host fact and emptying `PATH` reaches the
 * branch from any platform; the locator itself is the provider's own seam.
 *
 * The rule under test is AGENTS.md's: "An unavailable probe yields
 * `undetermined`, not `unmet`". A locator that did not answer says nothing
 * about whether an MSVC is installed, so it must not become `missing:
 * compiler`.
 */
vi.mock("../host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../host.js")>()),
  isWindows: true,
}));

type Reported = {
  readonly compilers: readonly { id: string; path: string; onPath?: boolean }[];
  readonly missing: readonly string[];
  readonly limitation: string;
};

const inspectWith = async (locateMsvc: () => Promise<MsvcLocatorResult>): Promise<Reported> => {
  const provider = new LocalToolchainProvider({ locateMsvc });
  const availability = await provider.inspectAvailability(new AbortController().signal);
  return {
    compilers: availability.compilers,
    missing: availability.missing.map((entry) => entry.id),
    limitation: availability.limitations.join(" "),
  };
};

let emptyPath: string;

beforeEach(async () => {
  // A plain Windows terminal has no `cl.exe` on PATH, which is what makes the
  // provider consult the locator at all.
  emptyPath = await mkdtemp(join(tmpdir(), "uvp-empty-path-"));
  vi.stubEnv("PATH", emptyPath);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(emptyPath, { recursive: true, force: true });
});

describe("a Visual Studio locator that did not answer", () => {
  it("leaves the compiler question open instead of calling it missing", async () => {
    const reported = await inspectWith(async () => ({ problem: "timed-out" }));

    expect(reported.compilers).toEqual([]);
    expect(reported.missing).not.toContain("compiler");
    expect(reported.limitation).toContain("did not answer in time");
    expect(reported.limitation).toContain("is unknown");
  });

  it("says the question is open for a locator that would not start", async () => {
    const reported = await inspectWith(async () => ({ problem: "could-not-start" }));

    expect(reported.missing).not.toContain("compiler");
    expect(reported.limitation).toContain("could not be started");
  });

  it("says the question is open for a locator that exited with an error", async () => {
    const reported = await inspectWith(async () => ({ problem: "failed" }));

    expect(reported.missing).not.toContain("compiler");
    expect(reported.limitation).toContain("exited without naming a toolset");
  });
});

describe("a Visual Studio locator that answered", () => {
  it("calls the compiler missing when it named no toolset", async () => {
    const reported = await inspectWith(async () => ({ problem: "named-nothing" }));

    expect(reported.compilers).toEqual([]);
    expect(reported.missing).toContain("compiler");
    expect(reported.limitation).not.toContain("unknown");
  });

  it("reports the toolset it named as found, off PATH", async () => {
    const path = "C:\\VS\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64\\cl.exe";
    const reported = await inspectWith(async () => ({ path }));

    expect(reported.compilers).toEqual([{ id: "msvc", path, onPath: false }]);
    expect(reported.missing).not.toContain("compiler");
    expect(reported.limitation).toContain("not on PATH");
  });
});
