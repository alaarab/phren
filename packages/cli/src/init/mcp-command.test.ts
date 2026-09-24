/**
 * The MCP server command init writes into Claude's settings. The failure this
 * guards against is quiet: a path into the npx cache works on the day of init
 * and stops working when npm evicts it, with no error the user ever sees.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMcpServerConfig, isEphemeralInstall } from "./config.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("buildMcpServerConfig", () => {
  it("points at a real install's own entry script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-mcp-")); dirs.push(dir);
    const entry = path.join(dir, "node_modules", "@phren", "cli", "dist", "index.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");
    expect(buildMcpServerConfig("/store", { entryScript: entry, platform: "linux" })).toEqual({ command: "node", args: [entry, "/store"] });
  });

  it("never writes a path into the npx cache; an npx install goes through the CLI wrapper", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-mcp-")); dirs.push(dir);
    const cached = path.join(dir, ".npm", "_npx", "bdb5dcd91e5f08ef", "node_modules", "@phren", "cli", "dist", "index.js");
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, ""); // it exists today; that is not the point
    expect(isEphemeralInstall(cached)).toBe(true);
    const config = buildMcpServerConfig("/store", { entryScript: cached, platform: "linux", wrapperPath: "/home/me/.local/bin/phren" });
    expect(config).toEqual({ command: "/home/me/.local/bin/phren", args: ["/store"] });
    expect(JSON.stringify(config)).not.toContain("_npx");
  });

  it("recognises the Windows spelling of the cache too", () => {
    expect(isEphemeralInstall("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@phren\\cli\\dist\\index.js")).toBe(true);
    expect(isEphemeralInstall("/usr/lib/node_modules/@phren/cli/dist/index.js")).toBe(false);
  });

  it("on Windows falls back to npx.cmd with the real package name", () => {
    const config = buildMcpServerConfig("C:\\store", { entryScript: "C:\\x\\_npx\\a\\dist\\index.js", platform: "win32" });
    expect(config.command).toBe("npx.cmd");
    expect(config.args[0]).toBe("-y");
    // The package is @phren/cli; a bare `phren` does not exist on npm.
    expect(config.args[1]).toMatch(/^@phren\/cli@/);
    expect(config.args[2]).toBe("C:\\store");
  });

  it("falls back the same way when the entry script is missing altogether", () => {
    const config = buildMcpServerConfig("/store", { entryScript: "/nowhere/dist/index.js", platform: "linux", wrapperPath: "/w/phren" });
    expect(config).toEqual({ command: "/w/phren", args: ["/store"] });
  });
});
