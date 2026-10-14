import type { UvpError, UvpErrorCategory } from "../domain/errors.js";

/**
 * Exit codes.
 *
 * The distinction a script needs is not "did it work" but "should I ask again".
 * `1` means the operation ran and the answer is no — a compile error, a failed
 * assertion. `2` means the question could not be put to the service at all: a bad
 * flag, no libuvcpp, no such workspace. A retry loop keyed on `1` is pointless; a
 * retry loop keyed on `2` after fixing the environment is the whole point.
 *
 * The mapping is by *category*, not by code, so a new code cannot be added
 * without someone deciding which side of the line it falls on — the compiler
 * makes them pick a category, and the category decides the exit code.
 */
export const EXIT_OK = 0;
export const EXIT_NO = 1;
export const EXIT_WRONG = 2;

const WRONG_CATEGORIES: ReadonlySet<UvpErrorCategory> = new Set<UvpErrorCategory>([
  "invalid_input",
  "unsupported_toolchain",
  "unsupported_target",
]);

export const exitCodeForError = (error: UvpError): number =>
  WRONG_CATEGORIES.has(error.category) ? EXIT_WRONG : EXIT_NO;
