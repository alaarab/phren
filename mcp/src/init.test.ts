import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  configureClaude,
  configureVSCode,
  getMcpEnabledPreference,
  parseMcpMode,
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
});
