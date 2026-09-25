/**
 * Stale hook entrypoint regression tests.
 *
 * `npm install -g @phren/cli` moved the package entry in 0.1.40 (from
 * `mcp/dist/index.js` to `dist/index.js`). Every hook command in settings.json
 * kept the old absolute path and threw MODULE_NOT_FOUND on each prompt and each
 * Stop — while `phren doctor` reported `ok hook-path-stable` and `--fix`
 * repaired nothing, because the check only looked for npx-cache paths and never
 * asked whether the entrypoint existed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { findStaleHookEntrypoints } from "../hooks.js";

describe("findStaleHookEntrypoints", () => {
  let tmp: { path: string; cleanup: () => void };
  let realEntry: string;

  beforeEach(() => {
    tmp = makeTempDir("hook-entrypoint-");
    realEntry = path.join(tmp.path, "dist", "index.js");
    fs.mkdirSync(path.dirname(realEntry), { recursive: true });
    fs.writeFileSync(realEntry, "// entry\n");
  });

  afterEach(() => tmp.cleanup());

  it("reports nothing when the entrypoint exists", () => {
    expect(findStaleHookEntrypoints([`node '${realEntry}' hook-stop`])).toEqual([]);
  });

  it("reports the exact upgrade failure: entry moved from mcp/dist to dist", () => {
    const oldEntry = path.join(tmp.path, "mcp", "dist", "index.js"); // never created
    const stale = findStaleHookEntrypoints([
      `PHREN_PATH='/x/.phren' node '${oldEntry}' hook-prompt`,
      `PHREN_PATH='/x/.phren' node '${oldEntry}' hook-stop`,
      `PHREN_PATH='/x/.phren' node '${oldEntry}' hook-session-start`,
    ]);
    expect(stale).toEqual([oldEntry]); // deduplicated: one path, not three
  });

  // Missing Windows paths are reported verbatim on POSIX, so these rows prove
  // which token each command shape yields as its entrypoint.
  it.each([
    ["a missing wrapper", `PHREN_PATH='/x/.phren' '/nonexistent/u/.local/bin/phren' hook-session-start`, ["/nonexistent/u/.local/bin/phren"]],
    ["a Windows `set VAR=... && node` command", `set "PHREN_PATH=C:\\Users\\u\\.phren" && node "C:\\npm\\@phren\\cli\\dist\\index.js" hook-prompt`, ["C:\\npm\\@phren\\cli\\dist\\index.js"]],
    ["a Windows wrapper command", `set "PHREN_PATH=C:\\Users\\u\\.phren" && "C:\\Users\\u\\.local\\bin\\phren.cmd" hook-tool`, ["C:\\Users\\u\\.local\\bin\\phren.cmd"]],
    ["npx, which re-resolves every run", "npx -y @phren/cli hook-stop", []],
    ["pinned npx", "npx -y @phren/cli@0.1.40 hook-prompt", []],
    // npx re-resolves each run, so even a path-like argument is never reported.
    ["npx with a path-like argument", "npx -y /nonexistent/phren/dist/index.js hook-stop", []],
    ["a bare command with no path", "phren hook-stop", []],
    ["an empty command", "", []],
  ])("handles %s", (_label, command, expected) => {
    expect(findStaleHookEntrypoints([command])).toEqual(expected);
  });

  it("separates a stale path from a healthy sibling", () => {
    const missing = path.join(tmp.path, "gone", "index.js");
    const stale = findStaleHookEntrypoints([
      `node '${realEntry}' hook-prompt`,
      `node '${missing}' hook-stop`,
    ]);
    expect(stale).toEqual([missing]);
  });
});
