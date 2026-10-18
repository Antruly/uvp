import { describe, expect, it } from "vitest";

import {
  UVP_MODULES,
  defaultModules,
  duplicateModules,
  moduleDependencyProblem,
  moduleFeatureProblem,
  moduleRouteConflictProblem,
  resolveModules,
  unknownModules,
} from "./modules.js";

/**
 * The module vocabulary is closed, and every refusal is a named one.
 *
 * These are the rules `uvp init --modules` relies on. The interesting cases are
 * not the happy path but the compositions that look plausible and are not: a
 * module whose feature the request does not include, a console with nothing to
 * drive, and two registrations of the same exact route. Each would otherwise
 * produce a project that fails to build or misleads the person who opens it.
 */

describe("unknown and duplicate names", () => {
  it("names the unknown entries in first-seen order, without repeats", () => {
    expect(unknownModules(["health", "metrics", "echo-log", "metrics"])).toEqual(["metrics"]);
    expect(unknownModules(UVP_MODULES)).toEqual([]);
  });

  it("reports a name only once however many times it repeats", () => {
    expect(duplicateModules(["health", "health", "health"])).toEqual(["health"]);
    expect(duplicateModules(["health", "echo-log"])).toEqual([]);
  });

  it("does not report an unknown name as a duplicate", () => {
    // The two refusals are separate: an unknown name is answered by the
    // vocabulary, and reporting it twice would send the caller after two
    // different fixes for the same mistake.
    expect(duplicateModules(["metrics", "metrics"])).toEqual([]);
  });
});

describe("canonical order", () => {
  it("orders a selection the same way however it was typed", () => {
    // Two requests naming the same set must generate the same file; otherwise
    // workspaces that are equal by every declaration diff on disk.
    const first = resolveModules(["static-console", "health"]);
    const second = resolveModules(["health", "static-console"]);
    expect(first).toEqual(second);
    expect(first).toEqual(["health", "static-console"]);
  });
});

describe("template defaults", () => {
  it("is the full set for websocket-test and nothing for every other template", () => {
    expect(defaultModules("websocket-test")).toEqual(UVP_MODULES);
    for (const template of [
      "hello-http",
      "rest-api",
      "websocket-echo",
      "soap-service",
      "static-files",
      "http3-service",
    ]) {
      expect(defaultModules(template)).toEqual([]);
    }
  });
});

describe("feature requirements", () => {
  it("refuses websocket-echo without the websocket feature, naming the remedy", () => {
    const problem = moduleFeatureProblem(["websocket-echo"], []);
    expect(problem).toBeDefined();
    expect(problem).toContain("websocket-echo");
    expect(problem).toContain("websocket feature");
    expect(problem).toContain("--features websocket");
  });

  it("accepts the module once the feature it is written against is requested", () => {
    expect(moduleFeatureProblem(["websocket-echo"], ["websocket"])).toBeUndefined();
  });

  it("names every feature more than one module needs, once", () => {
    const problem = moduleFeatureProblem(["websocket-echo", "echo-log"], []);
    expect(problem?.match(/websocket/gu)?.length).toBeGreaterThan(0);
    expect(problem).not.toContain("echo-log");
  });
});

describe("module dependencies", () => {
  it("refuses the console without the routes its page drives", () => {
    expect(moduleDependencyProblem(["static-console"])).toContain("websocket-echo");
    expect(moduleDependencyProblem(["static-console"])).toContain("echo-log");
  });

  it("accepts a complete composition", () => {
    expect(
      moduleDependencyProblem(["websocket-echo", "echo-log", "static-console"]),
    ).toBeUndefined();
  });
});

describe("route conflicts", () => {
  it("refuses a module whose exact registration the template already serves", () => {
    const problem = moduleRouteConflictProblem(["health"], "rest-api", ["GET /healthz"]);
    expect(problem).toContain("GET /healthz");
    expect(problem).toContain("health");
    expect(problem).toContain("rest-api");
  });

  it("does not call a different method on the same path a conflict", () => {
    // soap-service answers POST /ws; the WebSocket endpoint is WS /ws. Both
    // registrations can exist, and refusing one would narrow composition for
    // a conflict the router does not have.
    expect(
      moduleRouteConflictProblem(["websocket-echo"], "soap-service", ["POST /ws"]),
    ).toBeUndefined();
  });

  it("treats a prefix registration as a conflict with any module serving that prefix", () => {
    expect(
      moduleRouteConflictProblem(["static-console"], "static-files", [
        "GET /",
        "HEAD /",
        "GET /*path",
        "HEAD /*path",
      ]),
    ).toContain("GET /");
  });
});
