# Docs browser dependencies

`react.production.min.js` contains React, ReactDOM (including `createRoot` and
`createPortal`), the automatic JSX runtime, and Scheduler in one local IIFE.
The motion lab uses the corresponding development bundle at
`../motion-lab/vendor/react.development.js`. Each bundle shares one React
instance and exports `window.React`, `window.ReactDOM`, and
`window.ReactJSXRuntime`. Neither page fetches React from a CDN.

Regenerate both bundles from the repository root after installing the workspace
dependencies:

```sh
node scripts/build-docs-react.mjs
```

The generator uses `curl`, `tar`, and the root esbuild dependency. Temporary
files go under the system temporary directory (or `TMPDIR` when set), and are
removed on exit. `scripts/docs-react-vendor.json` pins the publisher tarball
URLs, versions, SHA-512 integrity values from the npm registry, and esbuild
version. Update those pins together when upgrading. Generation verifies the
tarball bytes and package identities before bundling; it does not install or
execute package scripts. The outputs contain upstream license comments, with
full package licenses in each vendor directory's `react.LICENSE.txt`.

The landing page sets `NODE_ENV=production` during bundling and is minified.
The motion lab sets `NODE_ENV=development`, retaining React's diagnostics and
readable output. Do not substitute a minified development bundle for production.

Both pages retain Babel standalone 7.29.9 for their shared JSX source files.
`babel-react.js` registers the `phren-react` preset: React's automatic JSX
transform in script mode, with its JSX-runtime import resolved to the bundled
global. It retains Babel's original `env` preset, including the conversion of
the lab's repeated top-level hook declarations to `var`. This keeps declarations
shared between the existing browser scripts
without needing remote modules or a browser CommonJS loader. Load it after
Babel and select it with `data-presets="phren-react"` on every JSX script.
