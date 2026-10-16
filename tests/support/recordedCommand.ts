/**
 * Reading a recorded command line.
 *
 * `processRunner.ts`'s `renderCommand` writes one: the command and its arguments,
 * with `env NAME=value …` in front when the call set an environment. **Every**
 * word goes through `shellQuote` — the arguments as well as the values — so a
 * word containing anything a POSIX shell would read specially is single-quoted,
 * and a word containing a quote is closed, escaped and reopened (`'\''`). That is
 * the record's only escaping, and `''` is how an empty word is written.
 *
 * What the record still is not is portable: `env …` is POSIX notation on every
 * host, so on Windows the line is a faithful description rather than something to
 * paste into a shell. #20 holds that decision and the alternative that was
 * rejected. What this module owes its callers is the other half — not assuming
 * the record is a string of whitespace-separated words. `NAME=(\S+)` did assume
 * it, and returns `'C:\Users\…` for a Windows path and `'/tmp/uvp` for a POSIX
 * path with a space: the quotes and the truncation are the same defect, and it is
 * why four tests in `LocalToolchainProvider.test.ts` were failing on Windows
 * rather than reading what the product had written.
 */
export const assignmentOf = (command: string, name: string): string | undefined => {
  for (const word of wordsOf(command)) {
    if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
  }
  return undefined;
};

/**
 * `command` split into words, by the notation the record is written in.
 *
 * Exported because it is what the notation means, and `processRunner.test.ts`
 * asserts the product's own line against it rather than against its own idea of
 * quoting.
 *
 * Deliberately not a general shell parser: the record has one quoting form, and
 * supporting more would be inventing syntax the product does not emit. A quote
 * opens or closes a quoted run, except where it is the `'\''` escape, which is a
 * literal quote and leaves the run it is in.
 */
export const wordsOf = (command: string): readonly string[] => {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  let started = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (character === "'" && command.slice(index, index + 4) === String.raw`'\''`) {
      word += "'";
      index += 3;
    } else if (character === "'") {
      quoted = !quoted;
    } else if (character === " " && !quoted) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    } else {
      word += character;
    }
    started = true;
  }

  if (started) words.push(word);
  return words;
};
