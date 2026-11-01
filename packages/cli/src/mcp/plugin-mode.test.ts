// The Claude Code plugin starts `phren mcp` without a store path, so the
// server decides for itself: full server, setup-only server with no store, or
// an empty one when `phren init` already registered its own phren server.
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import { pluginSetupReason, type PluginSetupReason } from "./plugin-mode.js";

const pluginEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PHREN_MCP_OWNER: "plugin", ...extra });

function writeStore(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "phren.root.yaml"), "version: 1\n");
}

function writeRegisteredServer(dir: string, value: unknown = { command: "node" }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { phren: value } }));
}

describe("phren mcp plugin mode", () => {
  let home = "";
  let tmp: { path: string; cleanup: () => void };
  const origCwd = process.cwd();

  beforeEach(() => {
    tmp = makeTempDir("phren-plugin-mode-");
    home = tmp.path;
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("PHREN_PATH", "");
    process.chdir(home);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.unstubAllEnvs();
    tmp.cleanup();
  });

  // null = full server, "no-store" = setup-only server, "stand-down" = empty server.
  const situations: Array<[string, () => NodeJS.ProcessEnv, PluginSetupReason | null]> = [
    [
      "serves setup mode when PHREN_PATH names a plain directory, without falling back to ~/.phren",
      () => {
        writeStore(path.join(home, ".phren"));
        const elsewhere = path.join(home, "elsewhere");
        fs.mkdirSync(elsewhere);
        vi.stubEnv("PHREN_PATH", elsewhere);
        return pluginEnv();
      },
      "no-store",
    ],
    [
      "serves the full server for a store at PHREN_PATH",
      () => {
        const store = path.join(home, "store");
        writeStore(store);
        vi.stubEnv("PHREN_PATH", store);
        return pluginEnv();
      },
      null,
    ],
    [
      "serves the full server for ~/.phren that has install markers but no root manifest yet",
      () => {
        const store = path.join(home, ".phren");
        fs.mkdirSync(store, { recursive: true });
        fs.writeFileSync(path.join(store, "machines.yaml"), "machines: []\n");
        return pluginEnv();
      },
      null,
    ],
    [
      "stands down before looking for a store when init's server is registered",
      () => {
        writeRegisteredServer(home);
        return pluginEnv();
      },
      "stand-down",
    ],
    [
      "ignores a HOME .claude.json when CLAUDE_CONFIG_DIR is set and has no server of its own",
      () => {
        writeStore(path.join(home, ".phren"));
        writeRegisteredServer(home);
        const configDir = path.join(home, "cfg");
        fs.mkdirSync(configDir);
        return pluginEnv({ CLAUDE_CONFIG_DIR: configDir });
      },
      null,
    ],
    [
      "falls back to HOME's .claude.json when CLAUDE_CONFIG_DIR is blank",
      () => {
        writeStore(path.join(home, ".phren"));
        writeRegisteredServer(home);
        return pluginEnv({ CLAUDE_CONFIG_DIR: "   " });
      },
      "stand-down",
    ],
    [
      "treats an unreadable .claude.json as having no registered server",
      () => {
        writeStore(path.join(home, ".phren"));
        fs.writeFileSync(path.join(home, ".claude.json"), "{ not json");
        return pluginEnv();
      },
      null,
    ],
    [
      "ignores a null mcpServers.phren entry",
      () => {
        writeStore(path.join(home, ".phren"));
        writeRegisteredServer(home, null);
        return pluginEnv();
      },
      null,
    ],
    [
      "finds a store in an ancestor .phren while serving the full server",
      () => {
        writeStore(path.join(home, "project", ".phren"));
        const nested = path.join(home, "project", "sub");
        fs.mkdirSync(nested, { recursive: true });
        process.chdir(nested);
        return pluginEnv();
      },
      null,
    ],
  ];

  it.each(situations)("%s", (_situation, setup, decision) => {
    expect(pluginSetupReason(setup())).toBe(decision);
  });
});
