#!/usr/bin/env node
import { parseArgs } from "node:util";

import { emitGeneratedFile, finishCheck } from "./lib/generated-file.mjs";
import { importCompiled } from "./lib/paths.mjs";

/**
 * Generate the machine-readable tool catalog from the contracts.
 *
 * The catalog is the only place a client can read the full surface without
 * starting the server, so it is derived from `TOOL_CONTRACTS` rather than
 * maintained beside it. A hand-written catalog drifts on the first tool that
 * gains a field, and it drifts silently, because nothing downstream parses it
 * strictly enough to notice.
 *
 * Two consumers read the same file: the documentation site, which serves it at
 * /uvp/tool-catalog.json, and the npm package, which ships it so a client can
 * inspect the surface without a round trip.
 */

const OUTPUTS = ["docs/public/tool-catalog.json"];

const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`Usage: node scripts/generate-mcp-tool-catalog.mjs [--check]

Writes ${OUTPUTS.join(", ")} from src/contracts/toolContracts.ts.
Requires dist/ — run \`npm run compile\` first.
--check  fail when the file on disk differs, without writing.`);
  process.exit(0);
}

const { TOOL_CONTRACTS, catalogDigestInput } = await importCompiled("contracts/toolContracts.js");
const { canonicalJson, sha256 } = await importCompiled("domain/identity.js");
const { z } = await import("zod");

const toJsonSchema = (schema, io) =>
  z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    // A catalog is read by humans and by clients that generate forms from it.
    // Dropping `$schema` keeps it diffable; the version is stated once at the top.
    override: ({ jsonSchema }) => {
      delete jsonSchema.$schema;
    },
  });

const entries = TOOL_CONTRACTS.map((contract) => ({
  name: contract.name,
  title: contract.title,
  description: contract.description,
  kind: contract.kind,
  input_schema: toJsonSchema(contract.inputSchema, "input"),
  output_schema: toJsonSchema(contract.outputSchema, "output"),
  effects: contract.effects,
  annotations: contract.annotations,
  returns_target_content: contract.returnsTargetContent,
  examples: contract.examples.map((example) => ({
    description: example.description,
    input: example.input,
  })),
}));

/**
 * The digest covers identity, not content.
 *
 * A client embeds it to answer "is the server I am talking to advertising the
 * catalog I expect?". Descriptions and schemas are both in scope, because a
 * changed schema is exactly the case a client needs to notice; the generated
 * JSON Schema text is not, because a Zod upgrade must not look like a contract
 * change.
 */
const digest = sha256(canonicalJson(catalogDigestInput()));

const catalog = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  name: "uvp",
  digest,
  tool_count: entries.length,
  tools: entries,
};

const contents = `${JSON.stringify(catalog, null, 2)}\n`;

const results = [];
for (const relative of OUTPUTS) {
  results.push(await emitGeneratedFile({ relative, contents, check: values.check }));
}

if (values.check) {
  process.exit(finishCheck(results, { label: "tool catalog" }));
}

for (const relative of OUTPUTS)
  console.log(`wrote ${relative} (${entries.length} tools, ${digest})`);
