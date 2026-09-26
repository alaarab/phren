// The Claude Code plugin (.claude-plugin/, hooks/): its manifest stays in step
// with the CLI, its skills come from the starter set `phren init` ships, and
// its hooks never double up with the ones `phren init` writes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { makeTempDir } from "./test-helpers.js";
import { configureClaude } from "./init/config.js";
import { resetVSCodeProbeCache } from "./init/init.js";
import { pluginSetupReason } from "./mcp/plugin-mode.js";
import { resolveTopLevelInvocation } from "./entrypoint.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
const cliVersion: string = readJson("packages/cli/package.json").version;
const plugin = readJson(".claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const hookScript = path.join(repoRoot, "hooks", "phren-hook.sh");
const starterSkills = path.join(repoRoot, "packages", "cli", "starter", "global", "skills");

// Starter skills the plugin leaves out, and why. conductor and fanout drive the
// Hook (phren bridge), enrolled computers and headless workers: optional,
// off-by-default modules a plugin-only user does not have.
const NOT_IN_PLUGIN = ["conductor", "fanout"];

describe("Claude Code plugin manifest", () => {
  it("versions and the pinned CLI match packages/cli/package.json", () => {
    expect(plugin.version).toBe(cliVersion);
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === "phren");
    expect(entry.version).toBe(cliVersion);
    expect(plugin.mcpServers.phren.args).toEqual(["-y", `@phren/cli@${cliVersion}`, "mcp"]);
    expect(plugin.mcpServers.phren.env.PHREN_MCP_OWNER).toBe("plugin");
    expect(fs.readFileSync(hookScript, "utf8")).toContain(`PHREN_PIN="${cliVersion}"`);
  });

  it("ships every starter skill except the ones deliberately left out", () => {
    const expected = fs.readdirSync(starterSkills)
      .filter((name) => fs.existsSync(path.join(starterSkills, name, "SKILL.md")))
      .filter((name) => !NOT_IN_PLUGIN.includes(name))
      .sort();
    const shipped = (plugin.skills as string[]).map((p) => {
      const dir = path.join(repoRoot, p);
      expect(path.dirname(dir)).toBe(starterSkills);
      return path.basename(dir);
    }).sort();
    expect(shipped).toEqual(expected);
    for (const name of shipped) {
      const text = fs.readFileSync(path.join(starterSkills, name, "SKILL.md"), "utf8");
      expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .{40,}`));
    }
  });

  it("hooks.json runs the four hooks phren init writes, through phren-hook.sh", () => {
    const hooks = readJson("hooks/hooks.json").hooks;
    const commands = Object.fromEntries(Object.entries(hooks).map(([event, groups]) => [
      event,
      (groups as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command,
    ]));
    expect(commands).toEqual({
      SessionStart: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/phren-hook.sh" hook-session-start',
      UserPromptSubmit: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/phren-hook.sh" hook-prompt',
      PostToolUse: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/phren-hook.sh" hook-tool',
      Stop: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/phren-hook.sh" hook-stop',
    });
  });
});

describe.skipIf(process.platform === "win32")("phren-hook.sh", () => {
  let tmp: { path: string; cleanup: () => void };
  let home: string;
  let fakePhren: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    tmp = makeTempDir("phren-plugin-hook-");
    home = path.join(tmp.path, "home");
    fs.mkdirSync(home, { recursive: true });
    fakePhren = path.join(tmp.path, "fake-phren");
    // Echoes its subcommand and what it read on stdin; exits non-zero to prove fail-open.
    fs.writeFileSync(fakePhren, '#!/bin/sh\nin=$(cat)\necho "RAN $1 $in"\nexit 3\n', { mode: 0o755 });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    tmp.cleanup();
  });

  const makeStore = () => {
    fs.mkdirSync(path.join(home, ".phren", "global"), { recursive: true });
    fs.writeFileSync(path.join(home, ".phren", "phren.root.yaml"), "version: 1\n");
  };

  const run = (event: string, extraEnv: Record<string, string> = {}) => {
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      PHREN_BIN: fakePhren,
      CLAUDE_PROJECT_DIR: tmp.path,
      ...extraEnv,
    };
    return spawnSync("sh", [hookScript, event], { cwd: tmp.path, env, input: '{"prompt":"hi"}', encoding: "utf8" });
  };

  it("runs phren for each event when a store exists, and fails open", () => {
    makeStore();
    for (const event of ["hook-prompt", "hook-session-start", "hook-tool", "hook-stop"]) {
      const result = run(event);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`RAN ${event} {"prompt":"hi"}`);
    }
  });

  it("stands down for every event phren init already wired in settings.json", () => {
    makeStore();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    resetVSCodeProbeCache();
    configureClaude(path.join(home, ".phren"), { mcpEnabled: true, hooksEnabled: true });
    const settings = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
    expect(settings).toContain("hook-prompt");
    for (const event of ["hook-prompt", "hook-session-start", "hook-tool", "hook-stop"]) {
      const result = run(event);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("stands down per event, so a partial settings.json still gets the rest", () => {
    makeStore();
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "PHREN_PATH='/x' '/x/phren' hook-stop" }] }] },
    }));
    expect(run("hook-stop").stdout).toBe("");
    expect(run("hook-prompt").stdout).toContain("RAN hook-prompt");
  });

  it("reads settings from CLAUDE_CONFIG_DIR too", () => {
    makeStore();
    const configDir = path.join(tmp.path, "claude-config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "settings.json"), '{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"phren hook-prompt"}]}]}}');
    expect(run("hook-prompt", { CLAUDE_CONFIG_DIR: configDir }).stdout).toBe("");
    // ...and then only there: Claude Code does not read ~/.claude/settings.json under CLAUDE_CONFIG_DIR.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"hooks":{"Stop":[{"hooks":[{"command":"phren hook-stop"}]}]}}');
    expect(run("hook-stop", { CLAUDE_CONFIG_DIR: configDir }).stdout).toContain("RAN hook-stop");
  });

  it("with no store, stays silent and never runs phren (which would create one)", () => {
    for (const event of ["hook-session-start", "hook-prompt", "hook-tool", "hook-stop"]) {
      const result = run(event);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("PHREN_PLUGIN_HOOKS=off and unknown events do nothing", () => {
    makeStore();
    expect(run("hook-prompt", { PHREN_PLUGIN_HOOKS: "off" }).stdout).toBe("");
    const unknown = run("rm-rf");
    expect(unknown.status).toBe(0);
    expect(unknown.stdout).toBe("");
  });
});

describe("phren mcp (plugin entry)", () => {
  let tmp: { path: string; cleanup: () => void };
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPhrenPath = process.env.PHREN_PATH;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmp = makeTempDir("phren-plugin-mcp-");
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    delete process.env.PHREN_PATH;
    process.chdir(tmp.path);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    if (origPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = origPhrenPath;
    tmp.cleanup();
  });

  it("routes `phren mcp` to the self-locating server", () => {
    expect(resolveTopLevelInvocation(["mcp"])).toEqual({ kind: "mcp-serve" });
    expect(resolveTopLevelInvocation(["mcp", "extra"]).kind).toBe("manage");
  });

  it("serves setup mode when there is no store", () => {
    expect(pluginSetupReason({ PHREN_MCP_OWNER: "plugin" })).toBe("no-store");
  });

  it("serves the full server when a store exists and init registered no server", () => {
    fs.mkdirSync(path.join(tmp.path, ".phren", "global"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, ".phren", "phren.root.yaml"), "version: 1\n");
    expect(pluginSetupReason({ PHREN_MCP_OWNER: "plugin" })).toBeNull();
  });

  it("stands down when phren init already registered its own server", () => {
    fs.mkdirSync(path.join(tmp.path, ".phren", "global"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, ".claude.json"), JSON.stringify({ mcpServers: { phren: { command: "node" } } }));
    expect(pluginSetupReason({ PHREN_MCP_OWNER: "plugin" })).toBe("stand-down");
    // Launched by anything other than the plugin, it never stands down.
    expect(pluginSetupReason({})).toBeNull();
  });

  it("looks for init's server where Claude Code loads it: .claude.json, in CLAUDE_CONFIG_DIR when set", () => {
    fs.mkdirSync(path.join(tmp.path, ".phren", "global"), { recursive: true });
    fs.mkdirSync(path.join(tmp.path, ".claude"), { recursive: true });
    const withPhren = JSON.stringify({ mcpServers: { phren: { command: "node" } } });
    // settings.json is not where Claude Code loads MCP servers from.
    fs.writeFileSync(path.join(tmp.path, ".claude", "settings.json"), withPhren);
    expect(pluginSetupReason({ PHREN_MCP_OWNER: "plugin" })).toBeNull();
    const configDir = path.join(tmp.path, "cfg");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, ".claude.json"), withPhren);
    expect(pluginSetupReason({ PHREN_MCP_OWNER: "plugin", CLAUDE_CONFIG_DIR: configDir })).toBe("stand-down");
  });
});
