import { describeProviderConformance } from "./providerContract.js";
import { fakeSubject } from "./providerSubjects.js";

/**
 * The provider contract, run against the one subject that satisfies all of it.
 *
 * This is the control half of the suite, and its value is not that a scripted
 * provider passes — a script passes whatever it is written to pass. It is that
 * every obligation in `providerContract.ts` is *reached*: a check with a typo in
 * it, an `expect` that never runs, or a skip that fires on every host would fail
 * here rather than wait to be discovered on the day a second provider arrives.
 *
 * The other half is `providerContractFaults.test.ts`, which requires each
 * obligation to reject a subject built to break it. Between them, every check is
 * known to pass on a conforming provider and to fail on a broken one; a check
 * that does neither is not a check.
 *
 * The real provider is the subject of `tests/toolchain/providerConformance.ts`,
 * where the same obligations meet a compiler, a CMake, and a libuvcpp.
 */
describeProviderConformance(fakeSubject({ name: "the scripted provider" }));
