#!/usr/bin/env node
// Builds the desktop installers. Run after building @phren/cli,
// @phren/desktop-kit and @phren/desktop (and optionally @phren/desktop-editor):
//   node packages/desktop/scripts/package.mjs [electron-builder args, e.g. --mac]
//
// electron-builder does not follow pnpm's workspace links, so this stages a
// self-contained copy of the package first: `pnpm deploy` with a hoisted
// node_modules, which copies @phren/cli and @phren/desktop-kit in as plain
// folders. Installers land in packages/desktop/release/.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(pkgDir, "../..");
const stage = path.join(pkgDir, ".stage");
const require = createRequire(path.join(pkgDir, "package.json"));

for (const file of ["dist/src/main.js", "../desktop-kit/dist/index.js", "../cli/dist/memory-ui-graph.runtime.js"]) {
  if (!existsSync(path.join(pkgDir, file))) {
    console.error(`Missing ${file}: build @phren/cli, @phren/desktop-kit and @phren/desktop first.`);
    process.exit(1);
  }
}
if (!existsSync(path.join(pkgDir, "ui/editor-host"))) {
  console.warn("No ui/editor-host: the app will open files in plain Monaco. Build @phren/desktop-editor to include VS Code's editor.");
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

rmSync(stage, { recursive: true, force: true });
run("pnpm", ["--filter", "@phren/desktop", "deploy", "--prod", "--config.node-linker=hoisted", stage], root);
// Without the workspace files, electron-builder reads the staged tree as a
// plain npm project instead of asking pnpm about a workspace it is not in.
for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) rmSync(path.join(stage, file), { force: true });
// node-pty's npm tarball ships its macOS spawn-helper without the execute
// bit. The daemon fixes that at runtime from a checkout, but inside a signed,
// possibly read-only app bundle it has to be right before signing.
const prebuilds = path.join(stage, "node_modules/node-pty/prebuilds");
for (const dir of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
  const helper = path.join(prebuilds, dir, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const electronVersion = require("electron/package.json").version;
const builder = path.join(path.dirname(require.resolve("electron-builder/package.json")), "cli.js");
const args = [
  builder,
  "--projectDir", stage,
  "--config", path.join(pkgDir, "electron-builder.yml"),
  `-c.electronVersion=${electronVersion}`,
  `-c.directories.output=${path.join(pkgDir, "release")}`,
  `-c.directories.buildResources=${path.join(pkgDir, "build")}`,
  "--publish", "never",
  // Without a Developer ID (CSC_LINK / CSC_NAME), sign ad hoc: Apple Silicon
  // refuses to launch an app whose signature electron-builder left broken.
  ...(process.env.CSC_LINK || process.env.CSC_NAME ? [] : ["-c.mac.identity=-"]),
  ...process.argv.slice(2),
];
run(process.execPath, args, pkgDir);
