/**
 * The shape of a workspace name.
 *
 * A name is two things at once — a CMake target and a file name — so a string
 * that is fine for one and not the other produces a project `init` reports as
 * complete and `cmake` refuses, or a binary path that names a directory. CMake's
 * [CMP0037](https://cmake.org/cmake/help/latest/policy/CMP0037.html) policy is
 * the authority for the first half:
 *
 * > Target names may contain upper and lower case letters, numbers, the
 * > underscore character (`_`), dot (`.`), plus (`+`) and minus (`-`). Target
 * > names reserved by one or more CMake generators are not allowed. Among others
 * > these include `all`, `clean`, `help`, and `install`.
 *
 * The pattern starts with a letter, digit, or underscore so that the same string
 * is never `.`, `..`, a hidden file, or an option-looking `-x` when it is used as
 * `build/<name>`. The two cache targets the Makefile generator adds
 * (`edit_cache`, `rebuild_cache`) and `preinstall` are reserved as well and are
 * refused here; `test` and `package` are not, because generated projects include
 * neither CTest nor CPack. CMake also reserves `ALL_BUILD`, `ZERO_CHECK`, and
 * `INSTALL` — in exactly that case; `Install` configures — and those spellings
 * are refused too.
 *
 * The second half is the file name. The Windows rules are applied on every host
 * on purpose: a workspace created on Linux is copied to Windows as a directory,
 * and a name that cannot be a file there would leave the copied project
 * unbuildable. Windows reserves device names (`CON`, `PRN`, `AUX`, `NUL`,
 * `COM1`–`COM9`, `LPT1`–`LPT9`) whether or not they carry an extension, and
 * strips a trailing dot — so `con.txt` and `svc.` are refused here even though
 * Linux would accept them.
 */
export const WORKSPACE_NAME_PATTERN =
  /^(?!(?:all|clean|help|install|preinstall|edit_cache|rebuild_cache|ALL_BUILD|ZERO_CHECK|INSTALL)$)(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\..*)?$)(?!.*\.$)[A-Za-z0-9_][A-Za-z0-9._+-]*$/u;

export const WORKSPACE_NAME_MESSAGE =
  "Use letters, digits, '_', '.', '+' or '-', starting with a letter, digit or '_'; " +
  "CMake's reserved target names, Windows device names, and a trailing dot are not allowed.";

/** Why `name` cannot be a workspace name, or `undefined` when it can. */
export const workspaceNameProblem = (name: string): string | undefined =>
  WORKSPACE_NAME_PATTERN.test(name) ? undefined : WORKSPACE_NAME_MESSAGE;
