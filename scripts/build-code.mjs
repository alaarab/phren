import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
// Host sources supply types during a clean workspace build. Only the optional
// package output ships; runtime host imports use the CLI's published exports.
execFileSync(process.platform === "win32" ? "tsc.cmd" : "tsc", ["-p", "packages/code/tsconfig.json"], { cwd: root, stdio: "inherit" });
fs.rmSync(new URL("../packages/code/dist/cli", import.meta.url), { recursive: true, force: true });
