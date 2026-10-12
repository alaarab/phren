#!/usr/bin/env node
// Checks the packaged app's terminal support: runs the unpacked build's own
// Electron as Node (as the app runs its daemon), loads node-pty from the app's
// node_modules and runs a shell command in a pseudo-terminal. Run after
// scripts/package.mjs; reads packages/desktop/release/*-unpacked or mac-*.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const release = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../release");

function unpacked() {
  for (const dir of readdirSync(release)) {
    const full = path.join(release, dir);
    if (dir.startsWith("mac")) {
      const app = path.join(full, "Phren.app/Contents");
      if (existsSync(app)) return { exe: path.join(app, "MacOS/Phren"), app: path.join(app, "Resources/app") };
    }
    if (dir === "win-unpacked") return { exe: path.join(full, "Phren.exe"), app: path.join(full, "resources/app") };
    if (dir === "linux-unpacked") return { exe: path.join(full, "phren-desktop"), app: path.join(full, "resources/app") };
  }
  return null;
}

const found = unpacked();
if (!found) {
  console.error(`No unpacked app under ${release}.`);
  process.exit(1);
}

const probe = path.join(mkdtempSync(path.join(tmpdir(), "phren-pty-")), "probe.cjs");
writeFileSync(probe, `
const pty = require(${JSON.stringify(path.join(found.app, "node_modules/node-pty"))});
const windows = process.platform === "win32";
const term = pty.spawn(windows ? "cmd.exe" : "/bin/sh", windows ? ["/c", "echo pty-ok"] : ["-c", "echo pty-ok"], { cols: 80, rows: 24 });
let out = "";
term.onData((data) => { out += data; });
const timer = setTimeout(() => { console.error("node-pty: no exit after 15 s; output: " + JSON.stringify(out)); process.exit(1); }, 15000);
term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (!out.includes("pty-ok")) { console.error("node-pty: shell output missing; got " + JSON.stringify(out) + ", exit " + exitCode); process.exit(1); }
  console.log("node-pty ok on " + process.platform + "-" + process.arch + " (Electron " + process.versions.electron + ")");
  process.exit(0);
});
`);

execFileSync(found.exe, [probe], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
