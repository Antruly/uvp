/**
 * Reading a recorded command line.
 *
 * `processRunner.ts`'s `renderCommand` writes one: the command and its arguments,
 * with `env NAME=value …` in front when the call set an environment. A value that
 * contains anything a POSIX shell would read specially is single-quoted, and a
 * value containing a quote is closed, escaped and reopened (`'\''`) — that is
 * `shellQuote`'s rule and the only escaping in the record.
 *
 * What the record *should* be is a different question, open in #20: `env …` is
 * not a cmd.exe or PowerShell command, so on Windows the line is not one a caller
 * can re-run even though `renderCommand` says it is, and the command's own
 * arguments are never quoted, so it is not reliably re-runnable on POSIX either.
 * A reader cannot settle that; it can only stop *assuming* the record is a string
 * of whitespace-separated words. `NAME=(\S+)`, the shape this replaces, returns
 * `'C:\Users\…` for a Windows path and `'/tmp/uvp` for a POSIX path with a space —
 * the quotes and the truncation are the same defect, and it is why four tests in
 * `LocalToolchainProvider.test.ts` were failing on Windows rather than reading
 * what the product had written.
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
 * Deliberately not a general shell parser: the record has one quoting form, and
 * supporting more would be inventing syntax the product does not emit. A quote
 * opens or closes a quoted run, except where it is the `'\''` escape, which is a
 * literal quote and leaves the run it is in.
 */
const wordsOf = (command: string): readonly string[] => {
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
