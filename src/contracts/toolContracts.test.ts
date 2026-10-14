import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  TOOL_CONTRACTS,
  catalogDigestInput,
  contractsByKind,
  requireToolContract,
  toolContract,
  toolNames,
} from "./toolContracts.js";
import {
  EFFECT_WORDS,
  NO_EFFECTS,
  TOOL_KINDS,
  TOOL_NAME_PATTERN,
  defineTool,
} from "./toolContractTypes.js";
import { toolEnvelopeShape } from "./toolOutputSchemaPrimitives.js";
import { canonicalJson, sha256 } from "../domain/identity.js";

/**
 * The contract catalog is the single source of truth: the MCP registrar, the CLI
 * adapter, the generated catalog, the docs page, and the shipped skill all read
 * it. Most of what can go wrong here goes wrong quietly — a duplicated name
 * shadows a tool, an example that no longer parses ships a broken usage snippet
 * to every client, an effect declared `false` while the description says
 * "writes" tells a caller it is safe to run without confirming.
 */

const ENVELOPE_KEYS = Object.keys(toolEnvelopeShape);

describe("the catalog", () => {
  it("names every tool exactly once", () => {
    const names = TOOL_CONTRACTS.map((contract) => contract.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("conforms every name to the convention a client greps for", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(contract.name).toMatch(TOOL_NAME_PATTERN);
      expect(contract.name.startsWith("uvp_")).toBe(true);
    }
  });

  it("declares each contract a kind the vocabulary admits", () => {
    for (const contract of TOOL_CONTRACTS) expect(TOOL_KINDS).toContain(contract.kind);
  });

  it("gives each contract a title that is a name, not a restatement of the tool id", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(contract.title.trim()).not.toBe("");
      expect(contract.title).not.toBe(contract.name);
    }
  });

  it("describes each contract in prose a caller can act on", () => {
    for (const contract of TOOL_CONTRACTS) {
      // Long enough to say what it does and what it returns; the catalog is read
      // by a model choosing a tool, and a two-word description is not a choice.
      expect(contract.description.length).toBeGreaterThan(60);
      expect(contract.description.trimEnd().endsWith(".")).toBe(true);
    }
  });

  it("ships at least one example per contract, and describes each one", () => {
    for (const contract of TOOL_CONTRACTS) {
      expect(contract.examples.length).toBeGreaterThan(0);
      for (const example of contract.examples) expect(example.description.trim()).not.toBe("");
    }
  });
});

describe("examples", () => {
  it("parses against the contract's own input schema", () => {
    // The one check that catches documentation drift for free. An example is a
    // usage snippet a client may copy verbatim; if it does not parse, every
    // client that copies it makes a malformed call.
    for (const contract of TOOL_CONTRACTS) {
      for (const example of contract.examples) {
        const result = contract.inputSchema.safeParse(example.input);
        expect(
          result.success,
          `${contract.name}: example ${JSON.stringify(example.description)} does not parse: ${
            result.success
              ? ""
              : result.error.issues
                  .map((issue) => `${issue.path.join(".")} ${issue.message}`)
                  .join("; ")
          }`,
        ).toBe(true);
      }
    }
  });

  it("supplies what the schema requires, rather than relying on defaults it omits", () => {
    // A schema default is not a substitute for a documented example: the point
    // of an example is to show a caller what a real call looks like.
    for (const contract of TOOL_CONTRACTS) {
      const required = requiredKeys(contract.inputSchema);
      for (const example of contract.examples) {
        for (const key of required) expect(example.input).toHaveProperty(key);
      }
    }
  });
});

describe("effects and annotations", () => {
  it("never disagrees with itself: a writing tool is not advertised read-only", () => {
    for (const contract of TOOL_CONTRACTS) {
      const { effects, annotations } = contract;
      expect(annotations.readOnlyHint, contract.name).toBe(
        !effects.writesFilesystem && !effects.mutatesTarget,
      );
      expect(annotations.destructiveHint, contract.name).toBe(effects.mutatesTarget);
      expect(annotations.idempotentHint, contract.name).toBe(!effects.writesFilesystem);
      expect(annotations.openWorldHint, contract.name).toBe(effects.network);
    }
  });

  it("declares `network` for exactly the tools that contact a host the caller named", () => {
    // An exact set rather than a keyword scan. The words that suggest network
    // access — "call", "send", "request" — also describe a SOAP call to
    // loopback and a listener the capture tool opens, so a keyword rule here
    // would be a rule that fires on the wrong contracts. The list below is the
    // claim; if a tool starts reaching out, this test is where that is stated.
    const reaching = TOOL_CONTRACTS.filter((contract) => contract.effects.network).map(
      (contract) => contract.name,
    );
    // `uvp_capture_read` and `uvp_assert_exchange` are absent, and that is the
    // distinction worth pinning: they read exchanges the session already
    // recorded, so they touch no host. `uvp_capture_start` is present because it
    // opens a listener, and `uvp_verify` because it drives requests.
    expect(reaching).toEqual([
      "uvp_run",
      "uvp_http_request",
      "uvp_websocket_probe",
      "uvp_soap_call",
      "uvp_load_test",
      "uvp_capture_start",
      "uvp_verify",
    ]);
  });

  it("declares `writesFilesystem` for every tool whose description says it writes", () => {
    // The dangerous direction is under-declaring, so the keyword scan is used
    // only where it cannot produce a false positive that would mask a real one:
    // a description that says "scaffold" while the contract says it writes
    // nothing is either a wrong contract or a wrong description.
    for (const contract of TOOL_CONTRACTS) {
      if (!mentionsAny(contract.description, EFFECT_WORDS.writesFilesystem)) continue;
      expect(contract.effects.writesFilesystem, `${contract.name} describes writing`).toBe(true);
    }
  });

  it("marks a tool that returns host content as untrusted, so a client can label it", () => {
    for (const name of [
      "uvp_http_request",
      "uvp_websocket_probe",
      "uvp_soap_call",
      "uvp_capture_read",
    ]) {
      expect(requireToolContract(name).returnsTargetContent, name).toBe(true);
    }
  });

  it("marks a build as returning host content, because diagnostics are the target's own text", () => {
    // A compiler writes its diagnostics, and a client that renders them beside
    // uvp's verdict is reading text uvp did not author. The flag is not only
    // about HTTP: it is about any bytes that did not originate here.
    expect(requireToolContract("uvp_build").returnsTargetContent).toBe(true);
    expect(requireToolContract("uvp_run").returnsTargetContent).toBe(true);
  });

  it("does not mark a tool that returns only uvp's own measurements", () => {
    // The exact set, because the flag decides whether a client wraps a result as
    // untrusted. Over-marking trains a reader to ignore the warning; under-marking
    // lets a remote body be read as uvp's own words. `uvp_load_test` is the case
    // worth naming: it reports counts and percentiles, never a response body.
    const marked = TOOL_CONTRACTS.filter((contract) => contract.returnsTargetContent).map(
      (contract) => contract.name,
    );
    expect(marked).toEqual([
      "uvp_build",
      "uvp_run",
      "uvp_http_request",
      "uvp_websocket_probe",
      "uvp_soap_call",
      "uvp_capture_read",
    ]);
  });
});

describe("output schemas", () => {
  it("carries the standard envelope on every one", () => {
    // The envelope is how evidence, unknowns, and limitations reach a caller. A
    // contract without it would return a result that cannot be audited.
    for (const contract of TOOL_CONTRACTS) {
      const keys = shapeKeys(contract.outputSchema);
      for (const key of ENVELOPE_KEYS) {
        expect(keys, `${contract.name} is missing ${key}`).toContain(key);
      }
    }
  });

  it("requires the envelope, rather than accepting a result that omits the caveats", () => {
    for (const contract of TOOL_CONTRACTS) {
      const schema = contract.outputSchema;
      if (!(schema instanceof z.ZodObject))
        throw new Error(`${contract.name} is not an object schema`);
      for (const key of ENVELOPE_KEYS) {
        expect(schema.safeParse({}).success, contract.name).toBe(false);
        expect(requiredKeys(schema), `${contract.name}: ${key} must not be optional`).toContain(
          key,
        );
      }
    }
  });

  it("leaves `tool` an unconstrained string, which the conformance lane must close", () => {
    // Recorded as a known gap rather than assumed away. `tool` is `z.string()`
    // in the shared envelope, so a handler that returns the wrong tool's name
    // still validates. The conformance lane compares it against the contract it
    // was called through, which is the only place the two are both in hand.
    expect(toolEnvelopeShape.tool).toBeInstanceOf(z.ZodString);
    expect(toolEnvelopeShape.tool.safeParse("uvp_anything_at_all").success).toBe(true);
  });
});

describe("lookups", () => {
  it("returns every contract by name", () => {
    for (const contract of TOOL_CONTRACTS) expect(toolContract(contract.name)).toBe(contract);
  });

  it("returns undefined for a name that is not in the catalog", () => {
    expect(toolContract("uvp_does_not_exist")).toBeUndefined();
  });

  it("throws for a missing contract, because a caller naming one is a bug", () => {
    expect(() => requireToolContract("uvp_does_not_exist")).toThrow(/Unknown tool contract/u);
  });

  it("lists names in catalog order", () => {
    // Order is part of the contract: the catalog is presented in the order a
    // caller performs the workflow, and the generated docs inherit it.
    expect(toolNames()).toEqual(TOOL_CONTRACTS.map((contract) => contract.name));
    expect(toolNames()[0]).toBe("uvp_doctor");
  });

  it("partitions the catalog by kind without losing or duplicating a contract", () => {
    const grouped = contractsByKind();
    const flattened = [...grouped.values()].flat();
    expect(flattened).toHaveLength(TOOL_CONTRACTS.length);
    expect(new Set(flattened).size).toBe(TOOL_CONTRACTS.length);
    for (const contract of TOOL_CONTRACTS) {
      expect(grouped.get(contract.kind)).toContain(contract);
    }
  });
});

describe("catalogDigestInput", () => {
  it("is stable across calls, and depends only on the catalog", () => {
    expect(canonicalJson(catalogDigestInput())).toBe(canonicalJson(catalogDigestInput()));
  });

  it("moves when a description changes, which is the tripwire it exists to be", () => {
    const before = canonicalJson(catalogDigestInput());
    const mutated = catalogDigestInput() as { name: string; description: string }[];
    const changed = mutated.map((entry) =>
      entry.name === "uvp_doctor" ? { ...entry, description: `${entry.description} ` } : entry,
    );
    expect(canonicalJson(changed)).not.toBe(before);
    expect(sha256(canonicalJson(changed))).not.toBe(sha256(before));
  });

  it("covers the identity fields and nothing incidental", () => {
    // Explicit, because a field silently entering or leaving this projection
    // changes every consumer's pinned digest for no reason a diff would explain.
    const entry = (catalogDigestInput() as Record<string, unknown>[])[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "description",
      "effects",
      "kind",
      "name",
      "title",
    ]);
  });
});

describe("defineTool", () => {
  const base = {
    title: "T",
    description: "D",
    kind: "web" as const,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    effects: NO_EFFECTS,
  };

  it("rejects a name that breaks the convention", () => {
    for (const name of ["doctor", "uvpDoctor", "uvp_Doctor", "uvp__doctor", "uvp_ doctor"]) {
      expect(() => defineTool({ ...base, name })).toThrow(/does not match/u);
    }
  });

  it("accepts the names the convention admits", () => {
    for (const name of ["uvp_doctor", "uvp_run_stop", "uvp_http2_probe"]) {
      expect(defineTool({ ...base, name }).name).toBe(name);
    }
  });

  it("defaults to the least-privileged annotations when a tool declares no effects", () => {
    const contract = defineTool({ ...base, name: "uvp_x" });
    expect(contract.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(contract.returnsTargetContent).toBe(false);
    expect(contract.examples).toEqual([]);
  });

  it("lets a contract override a derived annotation", () => {
    // The derivation is a default, not a verdict. `uvp_run_stop` mutates a
    // process tree without writing a file, so the derived `idempotentHint` is
    // right, while a tool with an operator-only override is expressible.
    const contract = defineTool({
      ...base,
      name: "uvp_x",
      effects: { ...NO_EFFECTS, writesFilesystem: true },
      annotations: { idempotentHint: true },
    });
    expect(contract.annotations.idempotentHint).toBe(true);
    expect(contract.annotations.readOnlyHint).toBe(false);
  });
});

/** Keys the schema requires, as opposed to the ones it merely accepts. */
const requiredKeys = (schema: z.ZodType): readonly string[] => {
  if (!(schema instanceof z.ZodObject)) throw new Error("not an object schema");
  return Object.entries(schema.shape)
    .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
    .map(([key]) => key);
};

const shapeKeys = (schema: z.ZodType): readonly string[] => {
  if (!(schema instanceof z.ZodObject)) throw new Error("not an object schema");
  return Object.keys(schema.shape);
};

/**
 * Whether a description uses one of the tokens the effect vocabulary watches for.
 *
 * Matched at a word boundary and case-insensitively, so "writes" and "Written"
 * both count and "copyright" does not.
 */
const mentionsAny = (text: string, words: readonly string[]): boolean => {
  const haystack = text.toLowerCase();
  return words.some((word) => new RegExp(`\\b${word}`, "u").test(haystack));
};
