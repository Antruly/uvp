import { bytes, millis, oneLine, row, rows, table } from "./format.js";
import { at, bool, list, num, obj, str, strings, yesNo } from "./readOutput.js";
import { shortDigest } from "../domain/identity.js";

/**
 * Human renderings for the readiness, workspace, build, and runtime tools.
 *
 * Each of these answers one question in the first two lines — what did uvp find,
 * what did it write, did it compile, is it listening — and then prints the
 * detail a person needs to act. The detail is never a substitute for the answer.
 */

export const renderDoctor = (output: Record<string, unknown>): string[] => {
  const lines: string[] = [];

  for (const entry of list(output["toolchains"])) {
    lines.push(row("toolchain", `${str(at(entry, "id"))} ${str(at(entry, "version"), "?")}`));
    for (const compiler of list(at(entry, "compilers"))) {
      lines.push(
        row(
          "compiler",
          `${str(at(compiler, "id"))} ${str(at(compiler, "version"), "?")}  ${str(at(compiler, "path"))}`,
        ),
      );
    }
    for (const system of list(at(entry, "build_systems"))) {
      // Labelled `build`, not `cmake`. This list holds ninja and make as well,
      // and printing "cmake 1.11.1 /usr/bin/ninja" is a line that reads as a
      // wrong version of a program rather than the right version of another.
      lines.push(
        row(
          "build",
          `${str(at(system, "id"))} ${str(at(system, "version"), "?")}  ${str(at(system, "path"))}`,
        ),
      );
    }
    for (const missing of list(at(entry, "missing"))) {
      lines.push(
        row(
          "missing",
          `${str(at(missing, "id"))} — needed for ${str(at(missing, "required_for"))}`,
        ),
      );
    }
  }

  const libuvcpp = obj(output["libuvcpp"]);
  if (bool(libuvcpp["found"]) === true) {
    const prefix = str(libuvcpp["install_prefix"]);
    lines.push(
      row(
        "libuvcpp",
        `${str(libuvcpp["version"], "version unknown")}` +
          `${whereVersionCameFrom(str(libuvcpp["version_source"]))}` +
          `${prefix === "" ? "" : `  ${prefix}`}`,
      ),
    );
    const modules = strings(libuvcpp["modules"]);
    lines.push(
      ...rows("modules", modules.length === 0 ? ["none reported by this build"] : modules),
    );
  } else {
    lines.push(row("libuvcpp", "not found"));
  }
  const note = str(libuvcpp["note"]);
  if (note !== "") lines.push(row("note", oneLine(note)));

  lines.push(...featureLines(output));

  return lines;
};

/**
 * The feature verdicts, grouped by status.
 *
 * Grouped rather than listed one per line because the question a reader has is
 * "what is missing", and a table of seven `satisfied` rows makes that the thing
 * they have to scan past. `undetermined` gets its own group and its reason shown:
 * it is neither a yes nor a no, and folding it into either would be the exact
 * inference the whole evidence model exists to prevent.
 */
const featureLines = (output: Record<string, unknown>): string[] => {
  const features = list(output["features"]);
  if (features.length === 0) return [];

  const byStatus = (status: string): readonly unknown[] =>
    features.filter((entry) => str(at(entry, "status")) === status);
  const names = (entries: readonly unknown[]): string =>
    entries.map((entry) => str(at(entry, "feature"))).join(", ");

  const lines: string[] = [];
  const satisfied = byStatus("satisfied");
  if (satisfied.length > 0)
    lines.push(row("features", `${"satisfied".padEnd(13)}${names(satisfied)}`));

  for (const entry of byStatus("unmet")) {
    lines.push(
      row(
        "features",
        `${"unmet".padEnd(13)}${str(at(entry, "feature")).padEnd(12)}${oneLine(str(at(entry, "note")), 70)}`,
      ),
    );
  }
  for (const entry of byStatus("undetermined")) {
    lines.push(
      row(
        "features",
        `${"undetermined".padEnd(13)}${str(at(entry, "feature")).padEnd(12)}${oneLine(str(at(entry, "note")), 70)}`,
      ),
    );
  }
  return lines;
};

/** A parenthetical only where the source is worth knowing: an absent or odd one. */
const whereVersionCameFrom = (source: string): string =>
  source === "" || source === "cmake_package" ? "" : ` (from ${source})`;

export const renderWorkspaceCreate = (output: Record<string, unknown>): string[] => {
  const files = list(output["files"]);
  const total = files.reduce<number>((sum, file) => sum + (num(at(file, "bytes")) ?? 0), 0);
  return [
    row("workspace", `${str(output["workspace_id"])}  ${str(output["path"])}`),
    row("template", str(output["template"])),
    row("files", `${String(files.length)} written, ${bytes(total)}`),
    ...rows("next", strings(output["next_steps"])),
  ];
};

export const renderBuild = (output: Record<string, unknown>): string[] => {
  const succeeded = bool(output["succeeded"]) === true;
  const diagnostics = list(output["diagnostics"]);
  const lines = [
    row(
      "build",
      `${succeeded ? "succeeded" : "failed"} (exit ${String(num(output["exit_code"]) ?? -1)})  ` +
        `configure ${millis(num(output["configure_duration_ms"]) ?? 0)}, ` +
        `compile ${millis(num(output["compile_duration_ms"]) ?? 0)}` +
        `${bool(output["from_cache"]) === true ? "  from cache" : ""}`,
    ),
    row("output", str(output["build_dir"])),
  ];

  const artifacts = list(output["artifacts"]);
  if (artifacts.length > 0) {
    lines.push(
      ...rows(
        "artifacts",
        artifacts.map(
          (artifact) => `${str(at(artifact, "path"))}  ${bytes(num(at(artifact, "bytes")) ?? 0)}`,
        ),
      ),
    );
  }

  if (diagnostics.length > 0) {
    lines.push(row("diagnostics", String(diagnostics.length)));
    for (const diagnostic of diagnostics) {
      lines.push(`  ${diagnosticLine(diagnostic)}`);
    }
  }
  return lines;
};

const diagnosticLine = (diagnostic: unknown): string => {
  const file = str(at(diagnostic, "file"), "<toolchain>");
  const line = num(at(diagnostic, "line"));
  const column = num(at(diagnostic, "column"));
  const where = `${file}${line === undefined ? "" : `:${String(line)}`}${column === undefined ? "" : `:${String(column)}`}`;
  const phase = str(at(diagnostic, "phase"));
  return `${where}: ${str(at(diagnostic, "severity"))}: ${str(at(diagnostic, "message"))} [${phase}]`;
};

export const renderRun = (output: Record<string, unknown>): string[] => {
  const lines = [
    row(
      "run",
      `${str(output["run_id"])}${num(output["pid"]) === undefined ? "" : `  pid ${String(num(output["pid"]))}`}`,
    ),
    row(
      "ready",
      bool(output["ready"]) === true
        ? `yes  ${str(output["endpoint"])}${num(output["startup_ms"]) === undefined ? "" : `  ${millis(num(output["startup_ms"]) ?? 0)}`}`
        : `no  (still_running: ${yesNo(output["still_running"])})`,
    ),
  ];

  // Stated in the rendering, not only in `limitations`. `still_running: yes`
  // beside `detached: yes` is the one combination whose consequence a reader
  // would otherwise have to infer, and the consequence is that nothing is
  // watching the service any more. The other combination has a consequence too,
  // and it is the opposite one: this call is waiting on the service, and the
  // interrupt a person is about to reach for ends the *service*, not just the
  // wait.
  if (bool(output["detached"]) === true) {
    lines.push(row("supervision", "released — nothing observes this process now"));
  } else if (bool(output["still_running"]) === true) {
    lines.push(row("supervision", "held — this call waits, and an interrupt stops the service"));
  }

  const stdout = str(output["stdout_tail"]);
  if (stdout.trim() !== "") lines.push(...rows("stdout", stdout.trimEnd().split("\n")));
  const stderr = str(output["stderr_tail"]);
  if (stderr.trim() !== "") lines.push(...rows("stderr", stderr.trimEnd().split("\n")));
  return lines;
};

export const renderRunStop = (output: Record<string, unknown>): string[] => {
  const stopped = list(output["stopped"]);
  if (stopped.length === 0) return [row("stopped", "nothing was running")];
  return [
    table(
      ["run_id", "outcome", "exit", "signal", "killed"],
      stopped.map((entry) => [
        str(at(entry, "run_id")),
        str(at(entry, "outcome")),
        num(at(entry, "exit_code")) === undefined ? "-" : String(num(at(entry, "exit_code"))),
        str(at(entry, "signal"), "-"),
        yesNo(at(entry, "killed")),
      ]),
    ),
    row("cleanup", bool(output["cleanup_complete"]) === true ? "complete" : "incomplete"),
  ];
};

export const renderVerify = (output: Record<string, unknown>): string[] => {
  const goal = str(output["goal"]);
  const lines = [
    // First, because it is the frame everything below answers to: a reader who
    // asked for a specific thing wants to see what uvp understood the ask to be.
    ...(goal === "" ? [] : [row("goal", goal)]),
    row("status", str(output["status"])),
    row(
      "build",
      `${bool(at(output["build"], "succeeded")) === true ? "succeeded" : "failed"} (exit ${String(num(at(output["build"], "exit_code")) ?? -1)})`,
    ),
    row(
      "service",
      `${yesNo(at(output["service"], "ready"))}${str(at(output["service"], "endpoint")) === "" ? "" : `  ${str(at(output["service"], "endpoint"))}`}`,
    ),
  ];

  const exchanges = list(output["exchanges"]);
  if (exchanges.length > 0) {
    lines.push(
      "",
      table(
        ["request", "status", "assertions", "elapsed"],
        exchanges.map((entry) => [
          str(at(entry, "name")),
          num(at(entry, "status")) === undefined ? "-" : String(num(at(entry, "status"))),
          `${String(num(at(entry, "assertions_passed")) ?? 0)} passed, ${String(num(at(entry, "assertions_failed")) ?? 0)} failed`,
          num(at(entry, "elapsed_ms")) === undefined
            ? "-"
            : millis(num(at(entry, "elapsed_ms")) ?? 0),
        ]),
      ),
    );
    for (const entry of exchanges) {
      for (const failure of strings(at(entry, "failures"))) {
        lines.push(`  ${str(at(entry, "name"))}: ${failure}`);
      }
    }
  }

  const unverified = list(output["unverified"]);
  if (unverified.length > 0) {
    lines.push("", "unverified:");
    for (const entry of unverified) {
      lines.push(`  ${str(at(entry, "question"))}`, `    ${str(at(entry, "reason"))}`);
    }
  }

  lines.push("", row("bundle", str(output["bundle_id"])));
  return lines;
};

/**
 * Comparing two saved passes.
 *
 * The outcome leads, because it is the answer, and the two sides are printed
 * under it so that a reader can see *which* reports it is an answer about. A
 * comparison that printed its differences without naming its two sides would be
 * a list of changes to nothing in particular.
 */
export const renderBundleDiff = (output: Record<string, unknown>): string[] => {
  const before = obj(output["before"]);
  const after = obj(output["after"]);
  const side = (entry: Record<string, unknown>): string =>
    `${str(entry["path"])}  ${str(entry["status"])}  ${shortDigest(str(entry["digest"]))}`;

  const lines = [
    row("outcome", str(output["outcome"])),
    row("before", side(before)),
    row("after", side(after)),
    row("digest", digestLine(bool(output["same_digest"]))),
  ];

  for (const reason of strings(output["incomparable_because"])) {
    lines.push(row("not comparable", reason));
  }
  if (bool(output["comparable"]) === false) lines.push("");

  if (bool(output["status_changed"]) === true) {
    lines.push(row("status", `${str(before["status"])} -> ${str(after["status"])}`));
  }
  if (bool(output["order_changed"]) === true) {
    lines.push(
      row(
        "order",
        "the two passes recorded their requests or their questions in a different order",
      ),
    );
  }
  if (bool(output["goal_changed"]) === true) {
    lines.push(row("goal", `${str(before["goal"], "-")} -> ${str(after["goal"], "-")}`));
  }

  const exchanges = obj(output["exchanges"]);
  const entries = list(at(exchanges, "entries"));
  lines.push(
    row(
      "requests",
      `${String(num(at(exchanges, "before_count")) ?? 0)} before, ` +
        `${String(num(at(exchanges, "after_count")) ?? 0)} after, ` +
        `${String(num(at(exchanges, "unchanged")) ?? 0)} unchanged`,
    ),
  );
  if (entries.length > 0) {
    lines.push(
      "",
      table(
        ["request", "change", "status", "assertions"],
        entries.map((raw) => {
          const entry = obj(raw);
          const left = obj(at(entry, "before"));
          const right = obj(at(entry, "after"));
          return [
            str(at(entry, "name")),
            changeLabel(entry),
            `${statusText(left)} -> ${statusText(right)}`,
            `${String(num(at(right, "assertions_passed")) ?? 0)} passed, ` +
              `${String(num(at(right, "assertions_failed")) ?? 0)} failed`,
          ];
        }),
      ),
    );
    for (const raw of entries) {
      const entry = obj(raw);
      for (const failure of changedFailureLines(entry)) {
        lines.push(`  ${str(at(entry, "name"))}: ${failure}`);
      }
    }
  }

  const unverified = list(at(output["unverified"], "entries"));
  if (unverified.length > 0) {
    lines.push("", "unanswered questions:");
    for (const raw of unverified) {
      const entry = obj(raw);
      lines.push(`  ${str(at(entry, "question"))}  (${str(at(entry, "change"))})`);
      const was = str(at(entry, "before"));
      const now = str(at(entry, "after"));
      if (was !== "") lines.push(`    before: ${was}`);
      if (now !== "") lines.push(`    after:  ${now}`);
    }
  }

  // Named rather than implied. A reader who has just compared two digests needs
  // to know which fields this comparison deliberately left alone, or the report
  // reads as a claim about all of them.
  const notCompared = strings(output["not_compared"]);
  if (notCompared.length > 0) lines.push("", row("not compared", notCompared.join(", ")));
  return lines;
};

/** One line for what the two digests did, including the case where they cannot be compared. */
const digestLine = (same: boolean | undefined): string => {
  if (same === true) return "the same, so nothing the digest covers moved";
  if (same === false) return "different";
  return "not compared: a supplied digest does not match the contents it arrived with";
};

const statusText = (side: Record<string, unknown>): string => {
  const status = num(side["status"]);
  return status === undefined ? "no response" : String(status);
};

/**
 * What happened to one exchange.
 *
 * The distinction between a change the digest sees and one it does not is in the
 * label, because it is the difference between "these two passes disagree about
 * the world" and "these two passes agree, and one of them explained itself
 * differently" — and a reader comparing the digests afterwards needs to know
 * which they are looking at.
 */
const changeLabel = (entry: Record<string, unknown>): string => {
  const change = str(at(entry, "change"));
  if (change !== "changed") return change;
  const fields = strings(at(entry, "changed_fields"));
  return bool(at(entry, "verdict_changed")) === true
    ? "changed"
    : `changed (not in the digest: ${fields.join(", ")})`;
};

const changedFailureLines = (entry: Record<string, unknown>): string[] => {
  const fields = strings(at(entry, "changed_fields"));
  if (!fields.includes("failures")) return [];
  const left = strings(at(at(entry, "before"), "failures"));
  const right = strings(at(at(entry, "after"), "failures"));
  return [...left.map((text) => `was: ${text}`), ...right.map((text) => `now: ${text}`)];
};
