# Tool design

A uvp tool is a contract, not a function with a description attached. This page
explains what a contract contains, the rules a new tool has to satisfy, and the
mistakes that have actually been made.

## One contract, four consumers

```ts
defineTool({
  name: "uvp_http_request",
  title: "Send an HTTP request",
  description: "…",
  kind: "web",
  inputSchema,
  outputSchema,
  effects: { … },
  returnsTargetContent: true,
  examples: [ … ],
});
```

The same object backs:

1. the MCP registrar, which publishes it as a tool,
2. the CLI registrar, which maps it to `uvp http request`,
3. the generated catalog at `docs/public/tool-catalog.json`,
4. the shipped skill.

None of those four owns the definition. That is what keeps `uvp build` and the
`uvp_build` tool from drifting apart — a difference between them is a bug in an
adapter, not a design decision — and it is why the documentation for the MCP
surface can be generated rather than hand-maintained.

## Fields, and what each is for

**`name`** must match `/^uvp_[a-z][a-z0-9]*(_[a-z0-9]+)*$/u` — snake_case, `uvp_`
prefix, verb then noun. `defineTool` throws at module load if it does not, which
means a bad name fails at import rather than at the first call in front of a
user.

**`title`** is a short noun phrase for a UI — "Send an HTTP request". **`description`**
is written for a model deciding whether to call it: what it does, what it costs,
and what it does not do. An agent reads the description far more often than it
reads this page.

**`kind`** is one of `toolchain`, `workspace`, `build`, `runtime`, `web`,
`workflow`. It groups the catalog and nothing else.

**`inputSchema` / `outputSchema`** are Zod schemas. The output schema describes
**the success shape only** — failures travel as the error contract with
`isError: true` and no structured content. A caller therefore cannot mistake a
partial failure payload for a successful result, because there is no success
payload to mistake it for.

**`effects`** is a truthful declaration of what the tool touches:

```ts
{
  readsFilesystem: boolean,
  writesFilesystem: boolean,
  network: boolean,
  spawnsProcess: boolean,
  mutatesTarget: boolean,
}
```

`spawnsProcess` and `network` are separate because they carry different risks: a
tool that starts a compiler is not the same as one that opens a socket to a host
the user named. `mutatesTarget` means the tool can change state outside the uvp
workspace — starting a service, putting load on one, modifying something that
outlives the session.

The MCP annotations uvp sends to clients (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) are **derived** from this block rather than
written alongside it, so the hint a client sees and the record in the code cannot
disagree.

**`returnsTargetContent`** marks a tool that can return bytes which did not
originate with uvp: a response body, a captured frame, a compiler diagnostic.
Clients should treat those fields as data, never as instructions. This is a flag
on the contract rather than a sentence in the description because it is a
property of the tool, decided once, and a client should be able to gate on it
mechanically.

**`examples`** are inputs that must actually satisfy `inputSchema`. They are not
decoration: a test validates every example against its own schema, so an example
that has drifted is a failing build.

## Rules for a new tool

**Return evidence, not prose.** A tool that changes the world returns
`Evidence`. A tool that reports on one returns `Evidence`. A sentence like "the
build succeeded" is not a report; `observed.exit_code = 0` plus
`derived.artifacts = [...]` is.

**Never mix observed and derived.** If a value was computed, it goes in
`derived`, and it must be explainable from `observed`. A median in `observed` is
a lie by placement.

**Prefer absent coverage to an assumed `complete`.** If the tool does not track
how much it examined, the coverage status is `unknown`. Silence is not a pass.

**Record what you could not determine.** A `ResidualUnknown` with a question and
a reason is a better result than a confident guess. A tool whose `unknowns` array
is always empty is probably not looking.

**Declare effects truthfully, including the ones that are hard to explain.** A
tool that writes outside the workspace says `mutatesTarget: true` even if it
usually does not. The declaration is about capability.

**Distinguish failure from unavailability.** A build that exits non-zero is a
normal return carrying diagnostics. A toolchain that cannot be invoked at all is
a `UvpFailure`. Collapsing these makes an agent's fix-and-retry loop
indistinguishable from a broken installation.

**Do not invent a third state where the domain has two — or collapse a third
where the domain has three.** The recurring error in this project has been the
second one: treating "could not check" as "checked and absent". See
[libuvcpp feature mapping](libuvcpp-features.md#undetermined-is-a-real-answer).

## Ports and providers

A tool that needs to build, run, or inspect a toolchain depends on the
`ToolchainProvider` **port**, never on a concrete provider. The port is defined
in `src/application/ToolchainProvider.ts`; the only implementation lives in
`src/toolchains/local/`; the binding happens in `src/composition/`.

This is what makes a second provider — a container, a remote SSH target — an
adapter rather than a rewrite. The requirement a provider has to meet is not
"work like the local one" but "report your gaps honestly":

```ts
interface ToolchainAvailability {
  readonly available: boolean;
  readonly missing: readonly { id: string; requiredFor: string }[];
  // …
}
```

A container provider with no host filesystem reports that it cannot read the host
tree. It does not report itself as unavailable, because it is available for
everything else. A provider that is all-or-nothing forces every caller to handle
a failure it does not have.

## Mistakes worth not repeating

**A hand-written enum that drifted.** A feature list literal in a contract was
missing `soap`, so `uvp_workspace_create` rejected a feature the rest of the
system supported. The vocabulary now lives in `src/domain/features.ts` and the
contract uses `z.enum(UVP_FEATURES)`, which makes that class of drift a compile
error rather than a silent rejection.

**A shared vocabulary placed for convenience.** `UvpFeature` was originally next
to the CMake mapping in `application/`, which would have forced `contracts/` to
import upward to reach it. It moved to `domain/`, where a shared vocabulary
belongs. The layering rules in `.oxlintrc.json` now make the inversion a lint
error.

**A description that promised more than the effects block.** `EFFECT_WORDS` in
`src/contracts/toolContractTypes.ts` lists the tokens that suggest undisclosed
behaviour — "write", "create", "scaffold" against `writesFilesystem`; "request",
"connect", "probe", "listen" against `network`; "build", "compile", "run",
"launch" against `spawnsProcess`. A test flags a description that uses one of
those words while the matching effect is declared `false`. It catches the
description written first and the effects block filled in second.

## Adding a tool

1. Write the contract in `src/contracts/`, in the file matching its kind.
2. Write the service in `src/application/`, depending on ports, not providers.
3. Register it in both adapters — `src/server/` and `src/cli/`. Both read
   `TOOL_CONTRACTS`; neither has its own list.
4. Add tests: schema round-trips, the effect/description check, and a
   services-level test for the workflow.
5. Regenerate the catalog (`npm run artifacts:tool-catalog`) and commit the
   result. CI fails if it is stale.

A tool that exists in the MCP server but not the CLI, or the reverse, is not a
smaller change. It is a bug, and the test suite treats it as one.
