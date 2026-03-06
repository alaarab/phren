import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configureAllHooks } from "./hooks.js";
import { configureClaude } from "./init.js";

describe.sequential("1.10.x release hardening gates", () => {
  let tmpRoot: string;
  let homeDir: string;
  let cortexPath: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPath = process.env.PATH;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-release-gates-"));
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
    process.env.PATH = origPath;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("keeps package and MCP server versions consistent", () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
    const indexTs = fs.readFileSync(path.join(root, "mcp", "src", "index.ts"), "utf8");

    // Version is now read dynamically from package.json at runtime, not hardcoded
    expect(indexTs).toContain("version: PACKAGE_VERSION");
    expect(indexTs).not.toMatch(/version:\s*"[\d.]+/);
  });

  it("wires lifecycle hooks + wrappers for Copilot/Cursor/Codex", () => {
    const fakeBin = path.join(tmpRoot, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });

    for (const tool of ["copilot", "cursor", "codex"]) {
      const file = path.join(fakeBin, tool);
      fs.writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n");
      fs.chmodSync(file, 0o755);
    }
    process.env.PATH = `${fakeBin}:${origPath || ""}`;

    const configured = configureAllHooks(cortexPath, new Set(["copilot", "cursor", "codex"]));
    expect(configured).toContain("Copilot CLI");
    expect(configured).toContain("Cursor");
    expect(configured).toContain("Codex");

    const copilotHooks = fs.readFileSync(path.join(homeDir, ".github", "hooks", "cortex.json"), "utf8");
    expect(copilotHooks).toContain("hook-session-start");
    expect(copilotHooks).toContain("hook-prompt");
    expect(copilotHooks).toContain("hook-stop");

    const cursorHooks = fs.readFileSync(path.join(homeDir, ".cursor", "hooks.json"), "utf8");
    expect(cursorHooks).toContain("sessionStart");
    expect(cursorHooks).toContain("beforeSubmitPrompt");
    expect(cursorHooks).toContain("hook-stop");

    const codexHooks = fs.readFileSync(path.join(cortexPath, "codex.json"), "utf8");
    expect(codexHooks).toContain("SessionStart");
    expect(codexHooks).toContain("UserPromptSubmit");
    expect(codexHooks).toContain("Stop");

    for (const tool of ["copilot", "cursor", "codex"]) {
      const wrapper = path.join(homeDir, ".local", "bin", tool);
      expect(fs.existsSync(wrapper)).toBe(true);
      const wrapperBody = fs.readFileSync(wrapper, "utf8");
      expect(wrapperBody).toContain("hook-session-start");
      expect(wrapperBody).toContain("hook-stop");
    }
  });

  it("upgrades legacy Claude hook config to lifecycle commands", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");

    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "npx @alaarab/cortex hook-prompt" }] }],
            Stop: [{ matcher: "", hooks: [{ type: "command", command: "cd ~/.cortex && git add -A && git commit -m 'auto-save cortex'" }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "cd ~/.cortex && npx @alaarab/cortex doctor --fix" }] }],
          },
        },
        null,
        2
      )
    );

    configureClaude(cortexPath, { mcpEnabled: true });
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const prompt = JSON.stringify(cfg.hooks?.UserPromptSubmit || []);
    const stop = JSON.stringify(cfg.hooks?.Stop || []);
    const start = JSON.stringify(cfg.hooks?.SessionStart || []);

    expect(prompt).toContain("hook-prompt");
    expect(stop).toContain("hook-stop");
    expect(start).toContain("hook-session-start");
  });

  it("can disable Claude hooks while keeping MCP configured", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    configureClaude(cortexPath, { mcpEnabled: true, hooksEnabled: false });
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(cfg.mcpServers?.cortex?.command).toBe("npx");
    const hooksBlob = JSON.stringify(cfg.hooks || {});
    expect(hooksBlob).not.toContain("hook-prompt");
    expect(hooksBlob).not.toContain("hook-stop");
    expect(hooksBlob).not.toContain("hook-session-start");
  });
});
