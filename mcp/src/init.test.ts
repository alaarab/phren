import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  configureClaude,
  configureCodexMcp,
  configureCopilotMcp,
  configureCursorMcp,
  configureVSCode,
  ensureGovernanceFiles,
  getHooksEnabledPreference,
  getMcpEnabledPreference,
  isVersionNewer,
  parseMcpMode,
  resetVSCodeProbeCache,
  setHooksEnabledPreference,
  setMcpEnabledPreference,
} from "./init.js";

describe.sequential("mcp mode configuration", () => {
  let tmpRoot: string;
  let homeDir: string;
  let cortexPath: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-init-test-"));
    homeDir = path.join(tmpRoot, "home");
    cortexPath = path.join(tmpRoot, "cortex");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(cortexPath, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    resetVSCodeProbeCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("parses mcp mode values", () => {
    expect(parseMcpMode("on")).toBe("on");
    expect(parseMcpMode("OFF")).toBe("off");
    expect(parseMcpMode("status")).toBeUndefined();
    expect(parseMcpMode("")).toBeUndefined();
  });

  it("defaults to mcp enabled and persists preference updates", () => {
    expect(getMcpEnabledPreference(cortexPath)).toBe(true);
    setMcpEnabledPreference(cortexPath, false);
    expect(getMcpEnabledPreference(cortexPath)).toBe(false);
    setMcpEnabledPreference(cortexPath, true);
    expect(getMcpEnabledPreference(cortexPath)).toBe(true);
  });

  it("defaults to hooks enabled and persists preference updates", () => {
    expect(getHooksEnabledPreference(cortexPath)).toBe(true);
    setHooksEnabledPreference(cortexPath, false);
    expect(getHooksEnabledPreference(cortexPath)).toBe(false);
    setHooksEnabledPreference(cortexPath, true);
    expect(getHooksEnabledPreference(cortexPath)).toBe(true);
  });

  it("toggles Claude MCP config on and off while keeping hooks", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          mcpServers: {
            cortex: { command: "npx", args: ["-y", "@alaarab/cortex", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureClaude(cortexPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(offCfg.mcpServers?.cortex).toBeUndefined();
    expect(Array.isArray(offCfg.hooks?.UserPromptSubmit)).toBe(true);
    expect(Array.isArray(offCfg.hooks?.Stop)).toBe(true);
    expect(Array.isArray(offCfg.hooks?.SessionStart)).toBe(true);

    const onStatus = configureClaude(cortexPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(onCfg.mcpServers?.cortex?.command).toBe("npx");
    expect(onCfg.mcpServers?.cortex?.args).toContain(cortexPath);
  });

  it("can disable and re-enable Claude hooks independently from MCP", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    configureClaude(cortexPath, { mcpEnabled: true, hooksEnabled: false });
    const offCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const offHooks = JSON.stringify(offCfg.hooks || {});
    expect(offHooks).not.toContain("hook-prompt");
    expect(offHooks).not.toContain("hook-stop");
    expect(offHooks).not.toContain("hook-session-start");

    configureClaude(cortexPath, { mcpEnabled: true, hooksEnabled: true });
    const onCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const onHooks = JSON.stringify(onCfg.hooks || {});
    expect(onHooks).toContain("hook-prompt");
    expect(onHooks).toContain("hook-stop");
    expect(onHooks).toContain("hook-session-start");
  });

  it("toggles VS Code MCP config on and off", () => {
    const vscodeDir = path.join(homeDir, ".config", "Code", "User");
    fs.mkdirSync(vscodeDir, { recursive: true });
    const mcpPath = path.join(vscodeDir, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          servers: {
            cortex: { command: "npx", args: ["-y", "@alaarab/cortex", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureVSCode(cortexPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(offCfg.servers?.cortex).toBeUndefined();

    const onStatus = configureVSCode(cortexPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.servers?.cortex?.command).toBe("npx");
    expect(onCfg.servers?.cortex?.args).toContain(cortexPath);
  });

  it("detects VS Code in USERPROFILE/AppData/Roaming path", () => {
    const roamingDir = path.join(homeDir, "AppData", "Roaming", "Code", "User");
    fs.mkdirSync(roamingDir, { recursive: true });
    const mcpPath = path.join(roamingDir, "mcp.json");

    const onStatus = configureVSCode(cortexPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");

    const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(cfg.servers?.cortex?.command).toBe("npx");
    expect(cfg.servers?.cortex?.args).toContain(cortexPath);
  });

  it("toggles Cursor MCP config on and off", () => {
    const cursorDir = path.join(homeDir, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            cortex: { command: "npx", args: ["-y", "@alaarab/cortex", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureCursorMcp(cortexPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(offCfg.mcpServers?.cortex).toBeUndefined();

    const onStatus = configureCursorMcp(cortexPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.mcpServers?.cortex?.command).toBe("npx");
    expect(onCfg.mcpServers?.cortex?.args).toContain(cortexPath);
  });

  it("toggles Copilot CLI MCP config on and off", () => {
    const copilotDir = path.join(homeDir, ".github");
    fs.mkdirSync(copilotDir, { recursive: true });
    const mcpPath = path.join(copilotDir, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          servers: {
            cortex: { command: "npx", args: ["-y", "@alaarab/cortex", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureCopilotMcp(cortexPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(offCfg.servers?.cortex).toBeUndefined();

    const onStatus = configureCopilotMcp(cortexPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.servers?.cortex?.command).toBe("npx");
    expect(onCfg.servers?.cortex?.args).toContain(cortexPath);
  });

  it("throws on malformed JSON via patchJsonFile (tested through configureClaude)", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, "{ this is not valid json !!!");

    expect(() => configureClaude(cortexPath, { mcpEnabled: true })).toThrow("Malformed JSON");
  });

  it("preserves non-cortex hooks when configuring (isCortexCommand filtering)", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { type: "command", command: "echo custom-hook" },
          ],
        },
      }, null, 2)
    );

    configureClaude(cortexPath, { mcpEnabled: true, hooksEnabled: true });
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const promptHooks = cfg.hooks?.UserPromptSubmit || [];
    const customHook = promptHooks.find((h: any) => h.command?.includes("custom-hook"));
    expect(customHook).toBeDefined();
  });

  it("toggles Codex MCP config on and off while preserving existing codex.json content", () => {
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexConfig = path.join(codexDir, "config.json");
    fs.writeFileSync(
      codexConfig,
      JSON.stringify(
        {
          hooks: { Stop: [{ type: "command", command: "echo keep" }] },
          mcpServers: {
            cortex: { command: "npx", args: ["-y", "@alaarab/cortex", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureCodexMcp(cortexPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(codexConfig, "utf8"));
    expect(offCfg.mcpServers?.cortex).toBeUndefined();
    expect(Array.isArray(offCfg.hooks?.Stop)).toBe(true);

    const onStatus = configureCodexMcp(cortexPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(codexConfig, "utf8"));
    expect(onCfg.mcpServers?.cortex?.command).toBe("npx");
    expect(onCfg.mcpServers?.cortex?.args).toContain(cortexPath);
    expect(Array.isArray(onCfg.hooks?.Stop)).toBe(true);
  });
});

describe("isVersionNewer", () => {
  it("returns true when current is a higher major version", () => {
    expect(isVersionNewer("2.0.0", "1.0.0")).toBe(true);
  });

  it("returns true when current is a higher minor version", () => {
    expect(isVersionNewer("1.2.0", "1.1.0")).toBe(true);
  });

  it("returns true when current is a higher patch version", () => {
    expect(isVersionNewer("1.0.2", "1.0.1")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isVersionNewer("1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false when previous is undefined", () => {
    expect(isVersionNewer("1.0.0", undefined)).toBe(false);
  });

  it("returns false when current is older", () => {
    expect(isVersionNewer("1.0.0", "2.0.0")).toBe(false);
  });

  it("pre-release sorts before the corresponding release", () => {
    expect(isVersionNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isVersionNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
  });

  it("compares pre-release tags lexicographically", () => {
    expect(isVersionNewer("1.0.0-rc.1", "1.0.0-beta.1")).toBe(true);
    expect(isVersionNewer("1.0.0-beta.1", "1.0.0-rc.1")).toBe(false);
  });

  it("equal pre-release tags return false", () => {
    expect(isVersionNewer("1.0.0-rc.1", "1.0.0-rc.1")).toBe(false);
  });

  it("rc.2 is newer than rc.1", () => {
    expect(isVersionNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
  });
});

describe("ensureGovernanceFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-gov-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates all governance files in a fresh directory", () => {
    ensureGovernanceFiles(tmpDir);
    const govDir = path.join(tmpDir, ".governance");

    expect(fs.existsSync(path.join(govDir, "memory-policy.json"))).toBe(true);
    expect(fs.existsSync(path.join(govDir, "access-control.json"))).toBe(true);
    expect(fs.existsSync(path.join(govDir, "memory-workflow-policy.json"))).toBe(true);
    expect(fs.existsSync(path.join(govDir, "index-policy.json"))).toBe(true);
    expect(fs.existsSync(path.join(govDir, "runtime-health.json"))).toBe(true);
  });

  it("writes valid JSON in each governance file", () => {
    ensureGovernanceFiles(tmpDir);
    const govDir = path.join(tmpDir, ".governance");

    const policy = JSON.parse(fs.readFileSync(path.join(govDir, "memory-policy.json"), "utf8"));
    expect(policy.ttlDays).toBe(120);
    expect(policy.retentionDays).toBe(365);

    const access = JSON.parse(fs.readFileSync(path.join(govDir, "access-control.json"), "utf8"));
    expect(Array.isArray(access.admins)).toBe(true);

    const workflow = JSON.parse(fs.readFileSync(path.join(govDir, "memory-workflow-policy.json"), "utf8"));
    expect(workflow.requireMaintainerApproval).toBe(true);

    const indexPol = JSON.parse(fs.readFileSync(path.join(govDir, "index-policy.json"), "utf8"));
    expect(Array.isArray(indexPol.includeGlobs)).toBe(true);
  });

  it("does not overwrite existing governance files", () => {
    const govDir = path.join(tmpDir, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    const policyPath = path.join(govDir, "memory-policy.json");
    fs.writeFileSync(policyPath, JSON.stringify({ ttlDays: 999 }, null, 2) + "\n");

    ensureGovernanceFiles(tmpDir);

    const after = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    expect(after.ttlDays).toBe(999);
  });
});
