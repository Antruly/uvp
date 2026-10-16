import { describe, expect, it } from "vitest";

import { createEvidence, evidenceDigest } from "../domain/evidence.js";
import type { Coverage } from "../domain/evidence.js";
import type { ToolchainIdentity } from "./ToolchainProvider.js";
import {
  commandSource,
  coverageComplete,
  coveragePartial,
  coverageUnknown,
  createRecorder,
  endpointSource,
  envelopeOf,
  fileSource,
  processSource,
  record,
  recordUnknown,
  toEvidenceRef,
  toUnknownOutput,
} from "./evidenceHelpers.js";

/**
 * The two things every tool does: describe what it saw, and admit what it did
 * not.
 *
 * These helpers exist so that recording an unknown is cheaper than omitting it —
 * the module's own docblock says why — which makes them the place where the
 * framework's honesty can quietly decay without a test noticing. The first full
 * mutation sweep measured exactly that: `evidenceHelpers.ts` scored **17.65%**,
 * 15 killed against 70 survived, the bottom of the eight mutated files by an
 * order of magnitude ([#52](https://github.com/Antruly/uvp/issues/52)). The file
 * had no test of its own; three test files reached it and all three took only
 * `createRecorder`.
 *
 * So this is that read, written down. Each `describe` is one export, and each
 * case names the behaviour a caller depends on rather than the mutation it
 * happens to kill.
 *
 * ## Four of the seventy cannot be killed, and that is a fact about the code
 *
 * The conditional-spread idiom — `...(x === undefined ? {} : { k: x })`, which
 * `exactOptionalPropertyTypes` forces on every optional that is forwarded — is
 * mutated four ways, and one of them is equivalent rather than missing. At two
 * sites in `record` and two in `recordUnknown`, the callee re-checks the same
 * optional before it builds its result:
 *
 * - `record` hands `derived` and `limitations` to `createEvidence`, which
 *   defaults them with `init.derived ?? {}` and `[...(init.limitations ?? [])]`,
 *   and the schema requires both fields present. So `{derived: undefined}` and a
 *   missing `derived` produce the same `Evidence`.
 * - `recordUnknown` hands `blockedBy` and `partialEvidence` to
 *   `createResidualUnknown`, which drops each when it is `undefined` (or empty),
 *   so both forms produce the same `ResidualUnknown` and neither carries the key.
 *
 * That was measured rather than reasoned about — the four pairs built against the
 * compiled domain code, compared as canonical JSON, as key ownership and as a
 * deep walk that counts a present-but-`undefined` key as a difference, all equal
 * — and it is why the cases below assert what a caller sees instead of chasing
 * the spread. The mutants at those four sites survive this file by construction
 * and are recorded in `docs/testing.md` rather than left to be rediscovered.
 *
 * The other sixty-six are ordinary gaps: a mutation that drops a supplied value
 * or writes a key the contract omits, both of which the assertions below notice.
 */

const NOW = new Date("2026-10-17T09:30:00.000Z");
const clock = (): Date => NOW;
const coverage: Coverage = { scope: "build", status: "complete" };
const provider: ToolchainIdentity = { id: "local", version: "1.7.0", platform: "linux-x64" };

describe("createRecorder", () => {
  it("starts with nothing recorded, because an empty envelope is not a clean one", () => {
    expect(createRecorder(clock).evidence).toEqual([]);
    expect(createRecorder(clock).unknowns).toEqual([]);
  });

  it("gives each recorder its own lists, so one tool's unknowns are not another's", () => {
    const first = createRecorder(clock);
    const second = createRecorder(clock);
    recordUnknown(first, "did it build?", "not_attempted");
    expect(first.unknowns).toHaveLength(1);
    expect(second.unknowns).toEqual([]);
    expect(first.evidence).not.toBe(second.evidence);
  });

  it("reads the clock it was given, and the system clock when it was given none", () => {
    expect(createRecorder(clock).now()).toBe(NOW);
    const before = Date.now();
    const system = createRecorder().now();
    // The default is the wall clock, and a recorder whose default returned
    // anything else would stamp every record with the same wrong instant.
    expect(system).toBeInstanceOf(Date);
    expect(system.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("record", () => {
  it("returns the record it kept, so a caller can reference what it just did", () => {
    const recorder = createRecorder(clock);
    const evidence = record(recorder, {
      kind: "build",
      subject: { workspace: "w" },
      observed: { exit_code: 0 },
      coverage,
      sources: [commandSource("cmake --build .")],
    });
    expect(recorder.evidence).toEqual([evidence]);
    expect(evidence.kind).toBe("build");
    expect(evidence.subject).toEqual({ workspace: "w" });
    expect(evidence.observed).toEqual({ exit_code: 0 });
  });

  it("stamps the record from the recorder's own clock", () => {
    const evidence = record(createRecorder(clock), {
      kind: "launch",
      subject: {},
      observed: {},
      coverage,
      sources: [],
    });
    expect(evidence.observed_at).toBe(NOW.toISOString());
  });

  it("carries the derived facts when there are any, and none when there are not", () => {
    const withDerived = record(createRecorder(clock), {
      kind: "benchmark",
      subject: {},
      observed: { samples: 10 },
      derived: { p50_ms: 4.2 },
      coverage,
      sources: [],
    });
    expect(withDerived.derived).toEqual({ p50_ms: 4.2 });
    // The field is required by the schema, so "nothing was derived" is an empty
    // record rather than an absent one — and that is what makes a dropped
    // `derived` visible to a caller comparing two envelopes.
    const without = record(createRecorder(clock), {
      kind: "benchmark",
      subject: {},
      observed: { samples: 10 },
      coverage,
      sources: [],
    });
    expect(without.derived).toEqual({});
  });

  it("carries the limitations when there are any, and an empty list when there are not", () => {
    const limited = record(createRecorder(clock), {
      kind: "capture",
      subject: {},
      observed: {},
      coverage,
      sources: [],
      limitations: ["the body was truncated at 64 KiB"],
    });
    expect(limited.limitations).toEqual(["the body was truncated at 64 KiB"]);
    const unlimited = record(createRecorder(clock), {
      kind: "capture",
      subject: {},
      observed: {},
      coverage,
      sources: [],
    });
    expect(unlimited.limitations).toEqual([]);
  });
});

describe("recordUnknown", () => {
  it("keeps the unknown on the recorder, which is the whole point of the call", () => {
    const recorder = createRecorder(clock);
    const unknown = recordUnknown(recorder, "does it answer on :8090?", "not_attempted");
    expect(recorder.unknowns).toEqual([unknown]);
    expect(unknown.question).toBe("does it answer on :8090?");
    expect(unknown.reason).toBe("not_attempted");
  });

  it("mints an id of the unknown kind rather than a bare one", () => {
    const unknown = recordUnknown(createRecorder(clock), "q", "cancelled");
    expect(unknown.unknown_id).toMatch(/^unk_[0-9a-f]{22}$/u);
  });

  it("records what would have to change, when the caller knows", () => {
    const unknown = recordUnknown(createRecorder(clock), "q", "toolchain_missing", {
      blockedBy: "install libuvcpp 1.7.0",
    });
    expect(unknown.blocked_by).toBe("install libuvcpp 1.7.0");
  });

  it("records the evidence that partly bears on the question", () => {
    const unknown = recordUnknown(createRecorder(clock), "q", "resource_limit", {
      partialEvidence: ["ev_0000000000000000000000"],
    });
    expect(unknown.partial_evidence).toEqual(["ev_0000000000000000000000"]);
  });

  it("omits both when neither was given, rather than writing them as undefined", () => {
    const unknown = recordUnknown(createRecorder(clock), "q", "not_attempted");
    expect(unknown).not.toHaveProperty("blocked_by");
    expect(unknown).not.toHaveProperty("partial_evidence");
  });
});

describe("toEvidenceRef", () => {
  const evidence = createEvidence({
    id: "ev_0000000000000000000000",
    kind: "build",
    subject: { workspace: "w" },
    observedAt: NOW.toISOString(),
    observed: { exit_code: 0 },
    coverage,
    sources: [commandSource("cmake --build .")],
    limitations: ["ran with -j1"],
  });

  it("projects every field the output contract carries", () => {
    const ref = toEvidenceRef(evidence);
    expect(ref.evidence_id).toBe("ev_0000000000000000000000");
    expect(ref.kind).toBe("build");
    expect(ref.observed_at).toBe(NOW.toISOString());
    expect(ref.coverage).toEqual(coverage);
    expect(ref.sources).toEqual([commandSource("cmake --build .")]);
    expect(ref.limitations).toEqual(["ran with -j1"]);
  });

  it("carries the digest of the claim, not of the record that made it", () => {
    expect(toEvidenceRef(evidence).digest).toBe(evidenceDigest(evidence));
  });

  it("copies the sources and limitations rather than sharing the record's arrays", () => {
    const ref = toEvidenceRef(evidence);
    expect(ref.sources).not.toBe(evidence.sources);
    expect(ref.limitations).not.toBe(evidence.limitations);
  });
});

describe("toUnknownOutput", () => {
  it("carries the id, the question and the reason", () => {
    const output = toUnknownOutput({
      unknown_id: "unk_0000000000000000000000",
      question: "q",
      reason: "out_of_scope",
    });
    expect(output).toEqual({
      unknown_id: "unk_0000000000000000000000",
      question: "q",
      reason: "out_of_scope",
    });
  });

  it("carries `blocked_by` when the unknown has one", () => {
    const output = toUnknownOutput({
      unknown_id: "unk_0000000000000000000000",
      question: "q",
      reason: "toolchain_missing",
      blocked_by: "install libuvcpp",
    });
    expect(output.blocked_by).toBe("install libuvcpp");
  });

  it("omits `blocked_by` entirely when there is none", () => {
    const output = toUnknownOutput({
      unknown_id: "unk_0000000000000000000000",
      question: "q",
      reason: "cancelled",
    });
    // `toStrictEqual` rather than `toEqual`: the two differ exactly on a key that
    // is present and `undefined`, which is the shape this case exists to refuse.
    expect(output).toStrictEqual({
      unknown_id: "unk_0000000000000000000000",
      question: "q",
      reason: "cancelled",
    });
    expect(output).not.toHaveProperty("blocked_by");
  });

  it("drops `partial_evidence`, which the output schema has no field for", () => {
    // Deliberate and documented on the function: widening the published schema
    // for a field only `uvp_verify` populates would make every caller parse it.
    const recorder = createRecorder(clock);
    const unknown = recordUnknown(recorder, "q", "resource_limit", {
      partialEvidence: ["ev_0000000000000000000000"],
    });
    expect(toUnknownOutput(unknown)).toStrictEqual({
      unknown_id: unknown.unknown_id,
      question: "q",
      reason: "resource_limit",
    });
  });
});

describe("envelopeOf", () => {
  it("carries the tool, the provider, and what was recorded", () => {
    const recorder = createRecorder(clock);
    const evidence = record(recorder, {
      kind: "build",
      subject: {},
      observed: {},
      coverage,
      sources: [],
    });
    recordUnknown(recorder, "q", "not_attempted");
    const envelope = envelopeOf(recorder, { tool: "uvp_build", provider });
    expect(envelope.tool).toBe("uvp_build");
    expect(envelope.provider).toEqual({ id: "local", version: "1.7.0", platform: "linux-x64" });
    expect(envelope.evidence).toEqual([toEvidenceRef(evidence)]);
    expect(envelope.unknowns).toHaveLength(1);
  });

  it("omits the provider version when the provider has none", () => {
    const envelope = envelopeOf(createRecorder(clock), {
      tool: "uvp_doctor",
      provider: { id: "local", platform: "linux-x64" },
    });
    expect(envelope.provider).toStrictEqual({ id: "local", platform: "linux-x64" });
    expect(envelope.provider).not.toHaveProperty("version");
  });

  it("carries the limitations when there are any, and an empty list when there are not", () => {
    const limited = envelopeOf(createRecorder(clock), {
      tool: "uvp_build",
      provider,
      limitations: ["no C++ compiler on this host"],
    });
    expect(limited.limitations).toEqual(["no C++ compiler on this host"]);
    const unlimited = envelopeOf(createRecorder(clock), { tool: "uvp_build", provider });
    expect(unlimited.limitations).toEqual([]);
  });

  it("orders unknowns by id, so two runs of the same tool agree as bytes", () => {
    const recorder = createRecorder(clock);
    recordUnknown(recorder, "second asked", "not_attempted");
    recordUnknown(recorder, "first asked", "not_attempted");
    const ids = envelopeOf(recorder, { tool: "uvp_doctor", provider }).unknowns.map(
      (unknown) => unknown.unknown_id,
    );
    expect(ids).toEqual([...ids].sort());
  });

  it("says nothing it was not told: an empty recorder makes an empty envelope", () => {
    expect(envelopeOf(createRecorder(clock), { tool: "uvp_doctor", provider })).toEqual({
      tool: "uvp_doctor",
      provider,
      evidence: [],
      unknowns: [],
      limitations: [],
    });
  });
});

describe("the coverage constructors", () => {
  it("marks a whole scope complete without inventing counts", () => {
    expect(coverageComplete("all six templates")).toStrictEqual({
      scope: "all six templates",
      status: "complete",
    });
  });

  it("says why coverage is partial, and how much of it was examined", () => {
    expect(
      coveragePartial("the response body", "read the first 64 KiB", 65536, 1048576),
    ).toStrictEqual({
      scope: "the response body",
      status: "partial",
      note: "read the first 64 KiB",
      examined: 65536,
      total: 1048576,
    });
  });

  it("omits the counts it was not given, rather than writing them as undefined", () => {
    // `toStrictEqual` is load-bearing here for the same reason as above: a count
    // that is present and `undefined` is not the same claim as no count at all,
    // and `toEqual` accepts both.
    expect(coveragePartial("the response body", "read the first 64 KiB")).toStrictEqual({
      scope: "the response body",
      status: "partial",
      note: "read the first 64 KiB",
    });
    expect(coveragePartial("the response body", "read the first 64 KiB", 65536)).toStrictEqual({
      scope: "the response body",
      status: "partial",
      note: "read the first 64 KiB",
      examined: 65536,
    });
  });

  it("marks an unexamined scope unknown, which is never a pass", () => {
    expect(coverageUnknown("the container image", "no runtime on this host")).toStrictEqual({
      scope: "the container image",
      status: "unknown",
      note: "no runtime on this host",
    });
  });
});

describe("the source constructors", () => {
  it("names a command by what was run", () => {
    expect(commandSource("cmake --build .")).toStrictEqual({
      kind: "command",
      ref: "cmake --build .",
    });
  });

  it("names a file, with a digest only when one was taken", () => {
    expect(fileSource("CMakeLists.txt")).toStrictEqual({ kind: "file", ref: "CMakeLists.txt" });
    expect(fileSource("CMakeLists.txt")).not.toHaveProperty("digest");
    expect(fileSource("CMakeLists.txt", "abc123")).toStrictEqual({
      kind: "file",
      ref: "CMakeLists.txt",
      digest: "abc123",
    });
  });

  it("names an endpoint by its url", () => {
    expect(endpointSource("http://127.0.0.1:8090/")).toStrictEqual({
      kind: "endpoint",
      ref: "http://127.0.0.1:8090/",
    });
  });

  it("names a process by its pid when there is one, and by its command when there is not", () => {
    expect(processSource(4242, "uvcpp-hello")).toStrictEqual({
      kind: "process",
      ref: "pid=4242 uvcpp-hello",
    });
    // A run that has already exited has no pid to name, and `pid=undefined` in a
    // provenance string is worse than no pid at all.
    expect(processSource(undefined, "uvcpp-hello")).toStrictEqual({
      kind: "process",
      ref: "uvcpp-hello",
    });
  });
});
