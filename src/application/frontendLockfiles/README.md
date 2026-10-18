# Frontend lockfiles

Each `*.package-lock.json` here is the `package-lock.json` that npm 11.16.0
(`packageManager` in the repository's `package.json`) wrote from the exact pins
in the matching generated `frontend/package.json`. `src/application/frontendApps.ts`
ships them beside that manifest so `npm ci` in the generated project installs a
fixed tree instead of resolving ranges from a registry.

They are committed as data, not source: `npm install --package-lock-only
--ignore-scripts --no-audit --no-fund` produced them in an isolated directory
holding only the manifest, and `frontendApps.test.ts` checks that each lock's
root `dependencies`/`devDependencies` still match the manifest the generator
writes. Regenerate one by running that command again after changing a pin, and
commit the result. `.jscpd.json` ignores this directory because the three
locks share most of the Vite toolchain by design and cannot be refactored.

These files are not published as-is; `tsc` emits them into `dist/` from where
the generator imports them.
