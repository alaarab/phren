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
import { extractHookScriptPath, findStaleHookEntrypoints } from "../hooks.js";

describe("extractHookScriptPath", () => {
  it("pulls the script out of a `node <path>` command", () => {
    expect(
      extractHookScriptPath(`PHREN_PATH='/Users/u/.phren' node '/usr/lib/node_modules/@phren/cli/dist/index.js' hook-stop`),
    ).toBe("/usr/lib/node_modules/@phren/cli/dist/index.js");
  });

  it("pulls the wrapper out of a wrapper command", () => {
    expect(
      extractHookScriptPath(`PHREN_PATH='/Users/u/.phren' '/Users/u/.local/bin/phren' hook-session-start`),
    ).toBe("/Users/u/.local/bin/phren");
  });

  it("handles Windows `set VAR=... && node \"...\"` commands", () => {
    expect(
      extractHookScriptPath(`set "PHREN_PATH=C:\\Users\\u\\.phren" && node "C:\\npm\\@phren\\cli\\dist\\index.js" hook-prompt`),
    ).toBe("C:\\npm\\@phren\\cli\\dist\\index.js");
  });

  it("handles a Windows wrapper command", () => {
    expect(
      extractHookScriptPath(`set "PHREN_PATH=C:\\Users\\u\\.phren" && "C:\\Users\\u\\.local\\bin\\phren.cmd" hook-tool`),
    ).toBe("C:\\Users\\u\\.local\\bin\\phren.cmd");
  });

  it("returns null for npx commands, which re-resolve every run", () => {
    expect(extractHookScriptPath("npx -y @phren/cli hook-stop")).toBeNull();
    expect(extractHookScriptPath("npx -y @phren/cli@0.1.40 hook-prompt")).toBeNull();
  });

  it("returns null when there is no path to check", () => {
    expect(extractHookScriptPath("phren hook-stop")).toBeNull();
    expect(extractHookScriptPath("")).toBeNull();
  });
});

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

  it("ignores npx commands entirely", () => {
    expect(findStaleHookEntrypoints(["npx -y @phren/cli hook-stop"])).toEqual([]);
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
