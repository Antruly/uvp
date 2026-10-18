import { describe, expect, it } from "vitest";

import { UVP_FRONTEND_APPS, type UvpFrontendApp } from "../domain/frontends.js";
import { frontendAppFiles, frontendPackageName } from "./frontendApps.js";

const filesOf = (app: UvpFrontendApp, name = "svc") => frontendAppFiles(app, name);

const byPath = (app: UvpFrontendApp, path: string): string => {
  const file = filesOf(app).find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${app} did not write ${path}`);
  return file.content;
};

const dependenciesOf = (manifest: { dependencies?: Record<string, string> }): string[] =>
  Object.keys(manifest.dependencies ?? {});

describe("the generated frontend project", () => {
  it("writes only under frontend/ and never a public/ document root", () => {
    for (const app of UVP_FRONTEND_APPS) {
      const files = filesOf(app);
      expect(files.length, app).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.path.startsWith("frontend/"), `${app} ${file.path}`).toBe(true);
      }
      expect(
        files.some((file) => file.path.endsWith("/package-lock.json")),
        app,
      ).toBe(true);
    }
  });

  it("pins every dependency exactly, with no range", () => {
    for (const app of UVP_FRONTEND_APPS) {
      const manifest = JSON.parse(byPath(app, "frontend/package.json")) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
        engines: { node: string };
        private: boolean;
      };
      expect(manifest.private, app).toBe(true);
      // The same lines uvp itself accepts; a bare floor would also admit the
      // odd-numbered releases Vite does not test against.
      expect(manifest.engines.node, app).toBe("^22.19.0 || ^24.11.0 || >=26.0.0");
      for (const [dependency, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        expect(version, `${app} ${dependency}`).toMatch(/^\d+\.\d+\.\d+$/u);
      }
    }
  });

  it("commits a lockfile whose root dependencies match the manifest", () => {
    for (const app of UVP_FRONTEND_APPS) {
      const manifest = JSON.parse(byPath(app, "frontend/package.json")) as {
        dependencies?: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const lockfile = JSON.parse(byPath(app, "frontend/package-lock.json")) as {
        name?: string;
        lockfileVersion: number;
        packages: Record<
          string,
          {
            name?: string;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          }
        >;
      };
      expect(lockfile.lockfileVersion, app).toBe(3);
      const root = lockfile.packages[""];
      expect(root, app).toBeDefined();
      // The root name follows the generated package, so the first `npm install`
      // in a generated project does not rewrite a lockfile nobody changed.
      expect(lockfile.name, app).toBe(frontendPackageName("svc"));
      expect(root?.name, app).toBe(frontendPackageName("svc"));
      expect(root?.dependencies ?? {}, app).toEqual(manifest.dependencies ?? {});
      expect(root?.devDependencies ?? {}, app).toEqual(manifest.devDependencies);
      // A lockfile with only the root entry is not a lockfile; `npm ci` would
      // fail to find the packages it names.
      expect(Object.keys(lockfile.packages).length, app).toBeGreaterThan(1);
    }
  });

  it("keeps the page free of remote assets and network calls", () => {
    for (const app of UVP_FRONTEND_APPS) {
      for (const path of ["frontend/index.html", "frontend/src/style.css"]) {
        expect(byPath(app, path), `${app} ${path}`).not.toMatch(/https?:\/\//u);
      }
      const sources = filesOf(app).filter(
        (file) => file.path.startsWith("frontend/src/") || file.path.endsWith("vite.config.js"),
      );
      expect(sources.length, app).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source.content, `${app} ${source.path}`).not.toMatch(
          /https?:\/\/|\bfetch\(|XMLHttpRequest|WebSocket\(/u,
        );
      }
    }
  });

  it("names the app's component after its framework", () => {
    const component = (app: UvpFrontendApp): string | undefined =>
      filesOf(app).find((file) => /\/src\/App\./u.test(file.path))?.path;
    expect(component("vue3")).toBe("frontend/src/App.vue");
    expect(component("react")).toBe("frontend/src/App.jsx");
    expect(component("svelte")).toBe("frontend/src/App.svelte");
  });

  it("tells the reader how to build, and what the service does until then", () => {
    for (const app of UVP_FRONTEND_APPS) {
      const readme = byPath(app, "frontend/README.md");
      expect(readme, app).toContain("npm ci");
      expect(readme, app).toContain("npm run build");
      expect(readme, app).toContain("frontend/dist");
      expect(readme, app).toContain("503");
    }
  });

  it("is deterministic for one name and framework", () => {
    for (const app of UVP_FRONTEND_APPS) {
      expect(filesOf(app)).toEqual(filesOf(app));
      expect(filesOf(app, "other")).not.toEqual(filesOf(app, "svc"));
    }
  });

  it("derives an npm-safe package name from a workspace name", () => {
    expect(frontendPackageName("svc")).toBe("svc-frontend");
    expect(frontendPackageName("My.App+1")).toBe("my.app-1-frontend");
    expect(frontendPackageName("__")).toBe("uvp-frontend");
  });

  it("lists the dependencies each framework needs and nothing else", () => {
    const manifest = (
      app: UvpFrontendApp,
    ): { dependencies?: Record<string, string>; devDependencies: Record<string, string> } =>
      JSON.parse(byPath(app, "frontend/package.json")) as {
        dependencies?: Record<string, string>;
        devDependencies: Record<string, string>;
      };
    expect(dependenciesOf(manifest("vue3"))).toEqual(["vue"]);
    expect(dependenciesOf(manifest("react"))).toEqual(["react", "react-dom"]);
    expect(dependenciesOf(manifest("svelte"))).toEqual([]);
    expect(Object.keys(manifest("svelte").devDependencies)).toEqual([
      "@sveltejs/vite-plugin-svelte",
      "svelte",
      "vite",
    ]);
  });
});
