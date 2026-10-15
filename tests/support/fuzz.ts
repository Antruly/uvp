/**
 * A seeded generator for tests that explore inputs instead of asserting examples.
 *
 * The example tests in this repository are written from output captured off real
 * tools, which is what makes them evidence about those tools rather than about
 * the parser's own shapes. Their limit is the other side of the same coin: they
 * cover the inputs someone thought of, and the parser's failure mode is the line
 * nobody thought of — a drive letter, a message block that runs past its cap, a
 * body that is half of one character. A generator covers inputs nobody wrote
 * down, and costs less than it looks because both parsers here are pure
 * functions of their arguments.
 *
 * **Determinism is the contract.** Every case comes from a seed drawn from a
 * fixed list, so the suite examines the same inputs on every run and a failure
 * is a failure rather than a coincidence. Each iteration is seeded from the pair
 * `(seed, iteration)` rather than from a stream that runs across iterations, so
 * the seed and iteration number a failure prints identify that case on its own —
 * replaying does not mean replaying the four hundred cases before it.
 *
 * **What a generator does not do is prove anything.** A bounded search over
 * generated inputs is not a statement about the input space; it is a statement
 * about the cases it drew. `UVP_FUZZ_SEED` exists to draw different ones, which
 * is only meaningful if the limited default is stated rather than implied — so
 * every run prints the seeds and the iteration count it used.
 *
 * **What it deliberately does not generate.** The values a fuzz draws are ones a
 * caller can reach. A checker that invented an impossible input to prove a point
 * would be reporting a defect nobody can hit, which is the same invented-fact
 * failure as reporting an observation nobody made. Where a shape is theoretically
 * reachable but not reachable today — a field of the wrong type on an error Node
 * itself raised — the case that covers it says so in the test rather than being
 * left out.
 */

/** The environment variable that replaces the default seed list. */
export const FUZZ_SEED_ENV = "UVP_FUZZ_SEED";

/** `UVP_FUZZ_SEED=random` draws one seed from the clock instead of a list. */
export const FUZZ_SEED_RANDOM = "random";

/**
 * The seeds the suite runs when nothing overrides them.
 *
 * A list rather than one number, because one seed is one walk through the
 * generator and the point of a fuzz is the input nobody pictured. Eight seeds at
 * a few hundred iterations each costs tens of milliseconds per property and
 * covers eight different walks.
 */
export const DEFAULT_FUZZ_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** Iterations per seed. The product with the seed count is what a run examines. */
export const DEFAULT_FUZZ_ITERATIONS = 200;

/** A generator, and the seed it came from. */
export interface Fuzzer {
  readonly seed: number;
  /** A number in `[0, 1)`. */
  next(): number;
  /** An integer in `[0, max]`, inclusive at both ends. */
  int(max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** One element of a non-empty array. */
  pick<T>(values: readonly T[]): T;
  /** A string of the given length range, drawn character by character. */
  string(alphabet: string, minLength: number, maxLength: number): string;
  /** A byte string of the given length range. */
  bytes(minLength: number, maxLength: number): Buffer;
  /** How many values this generator has drawn, for a message that says how far it got. */
  readonly draws: number;
}

/**
 * A small, fast, self-contained generator.
 *
 * Mulberry32 rather than a dependency: the value here is reproducibility, not
 * statistical quality, and a fuzz whose seed handling lives in someone else's
 * upgrade path is a fuzz that stops reproducing on an unrelated commit. An added
 * dependency is also a design discussion in this repository, and this is not a
 * reason to have one.
 */
export const fuzzer = (seed: number): Fuzzer => {
  let state = seed >>> 0;
  let draws = 0;
  const next = (): number => {
    draws += 1;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (max: number): number => Math.floor(next() * (max + 1));
  return {
    seed,
    next,
    int,
    chance: (probability) => next() < probability,
    pick: <T>(values: readonly T[]): T => {
      // The empty array is what makes a draw impossible, not the value drawn:
      // `undefined` is a legitimate element here — "no `Content-Type` header" is
      // one — so testing the value for `undefined` refuses to draw it.
      if (values.length === 0) throw new Error("pick() needs a non-empty array");
      return values[int(values.length - 1)] as T;
    },
    string: (alphabet, minLength, maxLength) => {
      // Split into characters by spread rather than indexed as a string. Indexing
      // yields UTF-16 code units, so an alphabet holding an astral character — one
      // that takes a surrogate pair — would let a draw take half of one, and half a
      // surrogate is a string `Buffer.from(text, "utf8")` cannot give back: it
      // encodes to U+FFFD. A generator that draws text which is not text is
      // generating a case no caller can put on the wire.
      const characters = [...alphabet];
      const length = minLength + int(maxLength - minLength);
      let text = "";
      for (let index = 0; index < length; index += 1) {
        text += characters[int(characters.length - 1)] ?? "";
      }
      return text;
    },
    bytes: (minLength, maxLength) => {
      const length = minLength + int(maxLength - minLength);
      const buffer = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) buffer[index] = int(255);
      return buffer;
    },
    get draws() {
      return draws;
    },
  };
};

/**
 * The seed for one iteration, so that `(seed, iteration)` names one input.
 *
 * Mixing the pair rather than continuing one stream is what makes a failure
 * report actionable: `UVP_FUZZ_SEED=3` with "iteration 412" is a single case to
 * re-run, not a position in a sequence that has to be replayed from the start.
 */
export const seedFor = (seed: number, iteration: number): number =>
  (Math.imul(seed, 2_654_435_761) + Math.imul(iteration + 1, 40_503)) >>> 0;

/** The seeds this run should use: the environment's, or the default list. */
export const fuzzSeeds = (): readonly number[] => {
  const requested = process.env[FUZZ_SEED_ENV];
  if (requested === undefined || requested === "") return DEFAULT_FUZZ_SEEDS;
  if (requested === FUZZ_SEED_RANDOM) {
    const drawn = Math.floor(Math.random() * 2 ** 31);
    console.log(`fuzz: ${FUZZ_SEED_ENV}=${FUZZ_SEED_RANDOM} drew seed ${String(drawn)}`);
    return [drawn];
  }
  const parsed = Number(requested);
  if (!Number.isInteger(parsed) || parsed < 0) {
    // Reported rather than ignored: a run that silently used the default seeds
    // after being asked for a specific one would answer a question nobody asked.
    throw new Error(`${FUZZ_SEED_ENV} must be an integer >= 0 or "${FUZZ_SEED_RANDOM}"`);
  }
  return [parsed];
};

/** The iteration count for this run, overridable the same way and for the same reason. */
export const fuzzIterations = (defaultIterations = DEFAULT_FUZZ_ITERATIONS): number => {
  const requested = process.env["UVP_FUZZ_ITERATIONS"];
  if (requested === undefined || requested === "") return defaultIterations;
  const parsed = Number(requested);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("UVP_FUZZ_ITERATIONS must be an integer >= 1");
  }
  return parsed;
};

/**
 * The line a run prints about what it examined.
 *
 * Printed for the reason the repository's other checks print their counts: a
 * bounded search that says nothing about its bounds reads like a proof, and the
 * seeds and counts are the difference between "no case failed" and "no case was
 * tried".
 */
export const reportFuzzRun = (
  label: string,
  seeds: readonly number[],
  iterations: number,
): void => {
  const drawn = seeds.length * iterations;
  const which =
    process.env[FUZZ_SEED_ENV] === undefined || process.env[FUZZ_SEED_ENV] === ""
      ? `seed(s) ${seeds.join(", ")}`
      : `seed(s) ${seeds.join(", ")} (${FUZZ_SEED_ENV})`;
  console.log(
    `fuzz: ${label} — ${which} × ${String(iterations)} iteration(s) = ` +
      `${String(drawn)} generated input(s)`,
  );
};

/** How much of a failing input a message shows before it says it is showing less. */
const REPLAY_LINES = 40;
const REPLAY_CHARS = 2_000;

/** A numbered listing of a text's lines, cut off with the cut reported. */
const numberedLines = (text: string): string => {
  const lines = text.split("\n");
  const shown = lines.slice(0, REPLAY_LINES);
  const rendered = shown.map((line, index) => `  ${String(index + 1).padStart(3)} | ${line}`);
  if (lines.length > shown.length) {
    rendered.push(`  … ${String(lines.length - shown.length)} more line(s)`);
  }
  return rendered.join("\n");
};

/**
 * A failure message that carries the input, so the case can be re-run.
 *
 * A fuzz that reports "an invariant did not hold" without the input has found
 * something and thrown it away — the cost of a generator is that the failing
 * case exists nowhere but in the run that produced it. Text is shown both quoted
 * and numbered, because a parser failure is usually on one line and a reader
 * looking for it in a JSON string is reading `\n` instead of looking.
 */
export const replay = (caseOf: {
  readonly seed: number;
  readonly iteration: number;
  readonly input: string | Buffer;
  readonly problem: string;
}): string => {
  const { seed, iteration, input, problem } = caseOf;
  const header =
    `${problem}\n  fuzz case: iteration ${String(iteration)}\n` +
    `  reproduce with ${FUZZ_SEED_ENV}=${String(seed)}`;
  if (Buffer.isBuffer(input)) {
    const hex = input.toString("hex").slice(0, REPLAY_CHARS);
    const cut = hex.length < input.toString("hex").length ? " (cut)" : "";
    return `${header}\n  input bytes (${String(input.byteLength)}): ${hex}${cut}`;
  }
  const quoted = JSON.stringify(input.slice(0, REPLAY_CHARS));
  const quotedCut = input.length > REPLAY_CHARS ? " (cut)" : "";
  return `${header}\n  input (${String(input.length)} char(s)): ${quoted}${quotedCut}\n${numberedLines(input)}`;
};
