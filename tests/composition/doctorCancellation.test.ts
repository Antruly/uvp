import { describe, expect, it } from "vitest";

import { createToolHandlers, handlerFor } from "../../src/composition/toolHandlers.js";
import { createUvpServices } from "../../src/composition/uvpServices.js";
import { doctorContract } from "../../src/contracts/toolchainToolContracts.js";
import { toUvpError } from "../../src/domain/errors.js";

/**
 * What a caller is told when they stop a call.
 *
 * The composition lane is where the real local provider is wired to the real tool
 * handler, so this is the one place the whole path exists at once: the provider
 * notices the signal, `uvp_doctor` is the first tool anyone runs, and what comes
 * out is what `uvp doctor` prints.
 *
 * The defect was a cancellation laundered into a finding. An interrupted
 * inspection returned the (empty) compiler list it had collected so far, and an
 * empty list is exactly what `available: false` means — so `uvp doctor`, stopped
 * with Ctrl-C, answered with a toolchain report naming the compiler, the build
 * system, and the libuvcpp to go and install. Asked for the interrupted call
 * directly, the old code returned `available: false`, `missing: [compiler, cmake,
 * ninja]`, `libuvcpp.found: false` — and the word "cancelled" was present, as one
 * line of `limitations` under a report about a machine nothing had looked at. The
 * handler resolved normally, so `src/cli.ts` printed all of it: nothing in the
 * path knew the difference between "this host has no compiler" and "I stopped
 * looking".
 *
 * The tool handler is driven directly rather than through the CLI because the
 * signal is the input under test, and there is no way to time a real SIGINT to
 * land between two inspections. That the CLI then prints what it is handed is a
 * separate claim, pinned in `tests/boundary/cli/cliContract.test.ts`.
 */

const handlers = createToolHandlers(createUvpServices());

/** The handler, looked up by the contract's own name rather than by a string. */
const doctor = handlerFor(handlers, doctorContract.name);

describe("a doctor call that was stopped", () => {
  it("answers on a live signal, so the cancellation below is the abort and not a broken call", async () => {
    // The control, and it holds on a host with no compiler as much as on one with
    // several: either way the doctor inspects and reports one toolchain. Without
    // it, a rejection below could be a wiring mistake dressed up as a cancellation.
    const report = await doctor({}, { signal: new AbortController().signal });
    expect(report["toolchains"]).toHaveLength(1);
  });

  it("is reported as cancelled, not as a host with nothing installed", async () => {
    const controller = new AbortController();
    controller.abort();

    // `undefined` is the failure being checked for: it means the handler resolved,
    // which is the defect in full — a report about a machine nothing looked at.
    const failure = await doctor({}, { signal: controller.signal }).then(
      () => undefined,
      (cause: unknown) => toUvpError(cause),
    );

    expect(failure, "uvp_doctor answered after its call had been cancelled").toBeDefined();
    expect(failure?.code).toBe("cancelled");
    expect(failure?.category).toBe("cancelled");
    // Nothing about the host was learned, so there is no remedy about the host to
    // offer — and a remedy is what makes a caller go and install something.
    expect(failure?.remediation.action).not.toMatch(/Install/u);
  });
});
