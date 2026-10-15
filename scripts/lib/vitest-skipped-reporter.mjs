/**
 * Name every test a run skipped, and the reason it gives.
 *
 * Vitest's default reporter folds skips into one count and prints none of their
 * names, which makes a whole-file skip and a passing test look identical in the
 * summary a CI lane leaves behind. That is the shape `docs/testing.md` forbids —
 * "a silent skip and a passing test look identical in a summary" — and it is why
 * this exists: the real-toolchain lane prints `40 passed | 7 skipped` with
 * nothing a reader can act on, while `tests/conformance/providerContract.ts`
 * puts the reason in the title precisely so that a runner would print it.
 *
 * The reason is already in the title, so printing titles is the whole job. Tests
 * are grouped under the suite they were skipped by, because that is where the
 * reason sits for a whole-suite skip: a `describe.skipIf` names its reason once
 * and the tests inside it repeat nothing.
 *
 * Nothing here parses the reason out of a title. A second consumer of that
 * spelling is how a spelling drifts, and the reader needs the sentence, not the
 * field.
 *
 * Wired into `vitest.config.ts` for every local run, and named in the CI test
 * steps, whose explicit `--reporter` flags would otherwise replace the config.
 */
export default class SkippedTestsReporter {
  #logger = undefined;

  onInit(vitest) {
    this.#logger = vitest.logger;
  }

  onTestRunEnd(testModules) {
    const files = [];
    let total = 0;
    for (const testModule of testModules) {
      const groups = new Map();
      for (const test of testModule.children.allTests("skipped")) {
        const suite = suiteTitleOf(test);
        const group = groups.get(suite) ?? [];
        group.push(test);
        groups.set(suite, group);
        total += 1;
      }
      if (groups.size > 0) files.push({ id: testModule.relativeModuleId, groups });
    }
    if (total === 0) return;

    const log = this.#logger ?? console;
    log.log(`\nTests skipped by this run (${String(total)}) — each one names what it needed:`);
    for (const file of files) {
      log.log(`  ${file.id}`);
      for (const [suite, tests] of file.groups) {
        if (suite !== "") log.log(`    ${suite}`);
        for (const test of tests) log.log(`      ${test.name}`);
      }
    }
  }
}

/**
 * The suites a skipped test sits inside, innermost first, joined into one line.
 *
 * Empty for a test declared at the top of its file, which is why the caller
 * prints the line only when there is one.
 */
function suiteTitleOf(test) {
  const titles = [];
  for (let node = test.parent; node !== undefined && node.type === "suite"; node = node.parent) {
    titles.unshift(node.name);
  }
  return titles.join(" > ");
}
