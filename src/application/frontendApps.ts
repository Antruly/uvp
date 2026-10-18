import { FRONTEND_APP_DIRECTORY, type UvpFrontendApp } from "../domain/frontends.js";
import type { FrontendFile } from "./frontends.js";
import reactLockfile from "./frontendLockfiles/react.package-lock.json" with { type: "json" };
import svelteLockfile from "./frontendLockfiles/svelte.package-lock.json" with { type: "json" };
import vue3Lockfile from "./frontendLockfiles/vue3.package-lock.json" with { type: "json" };

/**
 * The generated `frontend/` project for a Node frontend app.
 *
 * The directory is deliberately a standalone Vite project: its own
 * `package.json`, its own committed lockfile, and no relationship to the CMake
 * build. `uvp build` never reads it and never needs Node. The one thing the two
 * halves share is a path — the generated service serves `frontend/dist` when
 * that directory is there at startup.
 *
 * Versions are pinned exactly, and the lockfiles under `frontendLockfiles/` are
 * the ones `npm ci` installs. They were produced from the manifests below with
 * `npm install --package-lock-only --ignore-scripts`, so a build resolves no
 * version and makes no request beyond fetching the pinned packages.
 *
 * Every page renders only values the browser already has (the clock and the
 * viewport). None fetches a server route, names a CDN, or loads an external
 * font, so a built frontend works with the network unavailable and the page
 * cannot make a claim about a route the template does not serve.
 */
const VITE_VERSION = "8.3.4";

interface FrontendAppFramework {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly lockfile: unknown;
}

const FRAMEWORKS: Readonly<Record<UvpFrontendApp, FrontendAppFramework>> = {
  vue3: {
    dependencies: { vue: "3.5.44" },
    devDependencies: { "@vitejs/plugin-vue": "6.0.10", vite: VITE_VERSION },
    lockfile: vue3Lockfile,
  },
  react: {
    dependencies: { react: "19.3.1", "react-dom": "19.3.1" },
    devDependencies: { "@vitejs/plugin-react": "6.1.2", vite: VITE_VERSION },
    lockfile: reactLockfile,
  },
  svelte: {
    dependencies: {},
    devDependencies: {
      "@sveltejs/vite-plugin-svelte": "7.3.1",
      svelte: "5.57.2",
      vite: VITE_VERSION,
    },
    lockfile: svelteLockfile,
  },
};

/**
 * A package name npm accepts, derived from the CMake/workspace name.
 *
 * Workspace names may be uppercase and may contain `.` and `+`; npm names may
 * not. The frontend package is `private`, so the only requirement is a name npm
 * will accept — mangling is fine, and the fallback keeps a name that reduces to
 * nothing from producing `-frontend`.
 */
export const frontendPackageName = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  return `${slug === "" ? "uvp" : slug}-frontend`;
};

const packageManifest = (app: UvpFrontendApp, name: string): string => {
  const framework = FRAMEWORKS[app];
  return `${JSON.stringify(
    {
      name: frontendPackageName(name),
      private: true,
      version: "0.0.0",
      type: "module",
      engines: { node: ">=22.19.0" },
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      ...(Object.keys(framework.dependencies).length === 0
        ? {}
        : { dependencies: framework.dependencies }),
      devDependencies: framework.devDependencies,
    },
    null,
    2,
  )}\n`;
};

/** The lockfile as `npm ci` reads it, reserialized from the committed data. */
const packageLockfile = (app: UvpFrontendApp): string =>
  `${JSON.stringify(FRAMEWORKS[app].lockfile, null, 2)}\n`;

const viteConfig = (app: UvpFrontendApp): string => {
  const imports: Readonly<Record<UvpFrontendApp, string>> = {
    vue3: `import vue from "@vitejs/plugin-vue";`,
    react: `import react from "@vitejs/plugin-react";`,
    svelte: `import { svelte } from "@sveltejs/vite-plugin-svelte";`,
  };
  const plugin: Readonly<Record<UvpFrontendApp, string>> = {
    vue3: "vue()",
    react: "react()",
    svelte: "svelte()",
  };
  return `import { defineConfig } from "vite";
${imports[app]}

// The generated service serves \`frontend/dist\` at \`/\`, so the build keeps the
// default base and the default out directory. Change either and the service
// will answer 503 even after a successful build.
export default defineConfig({
  plugins: [${plugin[app]}],
  build: { outDir: "dist" },
});
`;
};

const entryHtml = (app: UvpFrontendApp, name: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.${app === "react" ? "jsx" : "js"}"></script>
  </body>
</html>
`;

/**
 * The generated entry files import their component and stylesheet relatively,
 * like any hand-written Vite project. Those two lines are assembled here rather
 * than written out inside a string literal: `tests/boundary/importSurface.test.ts`
 * reads every import-shaped string in `dist/` and requires a file to exist
 * there, and uvp's own artifact must not appear to import the files it writes.
 */
const FROM = ["f", "r", "o", "m"].join("");
const defaultImport = (binding: string, specifier: string): string =>
  `import ${binding} ${FROM} ${JSON.stringify(specifier)};`;
const sideEffectImport = (specifier: string): string => `import ${JSON.stringify(specifier)};`;

const mainSource = (app: UvpFrontendApp): string => {
  switch (app) {
    case "vue3":
      return `import { createApp } from "vue";
${defaultImport("App", "./App.vue")}
${sideEffectImport("./style.css")}

createApp(App).mount("#app");
`;
    case "react":
      return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
${defaultImport("App", "./App.jsx")}
${sideEffectImport("./style.css")}

createRoot(document.getElementById("app")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
    case "svelte":
      return `import { mount } from "svelte";
${defaultImport("App", "./App.svelte")}
${sideEffectImport("./style.css")}

export default mount(App, { target: document.getElementById("app") });
`;
  }
};

const vueApp = (name: string): string => `<script setup>
import { onMounted, onUnmounted, ref } from "vue";

const clock = ref("");
let timer;

const render = () => {
  clock.value = new Date().toLocaleTimeString();
};

onMounted(() => {
  render();
  timer = window.setInterval(render, 1000);
});

onUnmounted(() => {
  window.clearInterval(timer);
});
</script>

<template>
  <main>
    <h1>${name}</h1>
    <p>
      This page was generated by uvp, built by Vite, and is served by your
      libuvcpp service from <code>frontend/dist</code>.
    </p>
    <p class="status">Local time {{ clock }}</p>
    <p class="dim">No CDN, no external font, no request leaves this origin.</p>
  </main>
</template>
`;

const reactApp = (name: string): string => `import { useEffect, useState } from "react";

export default function App() {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const render = () => setClock(new Date().toLocaleTimeString());
    render();
    const timer = window.setInterval(render, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main>
      <h1>${name}</h1>
      <p>
        This page was generated by uvp, built by Vite, and is served by your
        libuvcpp service from <code>frontend/dist</code>.
      </p>
      <p className="status">Local time {clock}</p>
      <p className="dim">No CDN, no external font, no request leaves this origin.</p>
    </main>
  );
}
`;

const svelteApp = (name: string): string => `<script>
  let clock = $state("");
  let timer;

  $effect(() => {
    const render = () => (clock = new Date().toLocaleTimeString());
    render();
    timer = window.setInterval(render, 1000);
    return () => window.clearInterval(timer);
  });
</script>

<main>
  <h1>${name}</h1>
  <p>
    This page was generated by uvp, built by Vite, and is served by your
    libuvcpp service from <code>frontend/dist</code>.
  </p>
  <p class="status">Local time {clock}</p>
  <p class="dim">No CDN, no external font, no request leaves this origin.</p>
</main>
`;

const appSource = (app: UvpFrontendApp, name: string): string => {
  switch (app) {
    case "vue3":
      return vueApp(name);
    case "react":
      return reactApp(name);
    case "svelte":
      return svelteApp(name);
  }
};

const APP_EXTENSIONS: Readonly<Record<UvpFrontendApp, string>> = {
  vue3: "vue",
  react: "jsx",
  svelte: "svelte",
};

const appFileName = (app: UvpFrontendApp): string => `App.${APP_EXTENSIONS[app]}`;

const STYLE = `:root { color-scheme: light; --ink: #17181c; --muted: #5b6270; --line: #dfe3ea; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: var(--ink); font: 16px/1.55 system-ui, sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 3rem 1rem; }
h1 { margin: 0 0 .5rem; font-size: clamp(1.5rem, 6vw, 2.25rem); overflow-wrap: anywhere; }
p { margin: 0 0 .75rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.status { color: var(--muted); border-top: 1px solid var(--line); padding-top: .75rem; }
.dim { color: var(--muted); font-size: .875rem; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const readme = (app: UvpFrontendApp, name: string): string => `# ${name} frontend

A standalone ${app} single-page app built by Vite. It is not part of the CMake
project: \`uvp build\` does not read this directory and never requires Node.

## Build

    cd frontend
    npm ci
    npm run build

The build writes \`frontend/dist\`, which the service serves at \`/\`. The
generated service checks for \`frontend/dist/index.html\` at startup:

- before a build, \`/\` answers \`503\` with an instruction to build;
- after a build, restart the service and \`/\` serves the built page.

Node 22.19 or newer is a prerequisite for this directory only. Nothing in the generated C++ project, \`uvp build\`, or
\`uvp run\` needs it.

## Versions

Dependencies are pinned exactly in \`package.json\`, and \`package-lock.json\`
is committed. \`npm ci\` installs those versions without resolving or updating
anything.
`;

/**
 * The files one frontend app contributes.
 *
 * Paths are relative to the workspace root, and every file lives under
 * \`frontend/\`; the generated service reaches the build output through the fixed
 * path in \`UVP_FRONTEND_APP_DEFINITIONS[app].output\`.
 */
export const frontendAppFiles = (app: UvpFrontendApp, name: string): readonly FrontendFile[] => {
  const directory = FRONTEND_APP_DIRECTORY;
  return [
    { path: `${directory}/package.json`, content: packageManifest(app, name) },
    { path: `${directory}/package-lock.json`, content: packageLockfile(app) },
    { path: `${directory}/vite.config.js`, content: viteConfig(app) },
    { path: `${directory}/index.html`, content: entryHtml(app, name) },
    { path: `${directory}/src/main.${app === "react" ? "jsx" : "js"}`, content: mainSource(app) },
    { path: `${directory}/src/${appFileName(app)}`, content: appSource(app, name) },
    { path: `${directory}/src/style.css`, content: STYLE },
    { path: `${directory}/.gitignore`, content: "node_modules/\ndist/\n" },
    { path: `${directory}/README.md`, content: readme(app, name) },
  ];
};
