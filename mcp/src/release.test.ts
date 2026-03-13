import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { configureAllHooks } from "./hooks.js";
import { configureClaude } from "./init.js";
import { getToolCount } from "./tool-registry.js";

function npmExec(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function publishInProgress(): boolean {
  return process.env.npm_command === "publish" || process.env.npm_lifecycle_event === "prepublishOnly";
}

describe.sequential("1.10.x release hardening gates", () => {
  let tmpRoot: string;
  let tmpCleanup: () => void;
  let homeDir: string;
  let cortexPath: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPath = process.env.PATH;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-release-gates-"));
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
    tmpCleanup();
  });

  it("keeps package and MCP server versions consistent", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const indexTs = fs.readFileSync(path.join(root, "mcp", "src", "index.ts"), "utf8");
    const metadataTs = fs.readFileSync(path.join(root, "mcp", "src", "package-metadata.ts"), "utf8");

    // Version is read from shared package metadata, which itself reads package.json.
    expect(indexTs).toContain("version: PACKAGE_VERSION");
    expect(indexTs).not.toMatch(/version:\s*"[\d.]+/);
    expect(metadataTs).toContain("package.json");
  });

  it.skipIf(publishInProgress())("ships a dry-run npm pack with built entrypoints and without source ts files", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const builtRegistry = path.join(root, "mcp", "dist", "tool-registry.js");
    if (!fs.existsSync(builtRegistry)) {
      execFileSync(npmExec(), ["run", "build"], {
        cwd: root,
        encoding: "utf8",
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    const raw = execFileSync(npmExec(), ["pack", "--json", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packInfo = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const files = packInfo[0]?.files?.map((file) => file.path) || [];

    expect(files).toContain("package.json");
    expect(files).toContain("mcp/dist/index.js");
    expect(files).toContain("mcp/dist/tool-registry.js");
    expect(files).not.toContain("mcp/src/index.ts");
  });

  it("keeps generated skill metadata aligned with the live tool registry", async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const linkSkillsTs = fs.readFileSync(path.join(root, "mcp", "src", "link-skills.ts"), "utf8");
    expect(linkSkillsTs).toContain("getToolCount()");
    expect(linkSkillsTs).toContain("renderToolCatalogMarkdown()");
    expect(getToolCount()).toBe(60);
  });

  it.skipIf(process.platform === "win32")("wires lifecycle hooks + wrappers for Copilot/Cursor/Codex", () => {
    const fakeBin = path.join(tmpRoot, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });

    for (const tool of ["copilot", "cursor", "codex"]) {
      const file = path.join(fakeBin, tool);
      fs.writeFileSync(file, "#!/usr/bin/env bash\nexit 0\n");
      fs.chmodSync(file, 0o755);
    }
    process.env.PATH = `${fakeBin}:${origPath || ""}`;

    const configured = configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });
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

  it("rewrites existing Claude cortex hooks to the canonical lifecycle commands", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");

    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "npx cortex hook-prompt" }] }],
            Stop: [{ matcher: "", hooks: [{ type: "command", command: "npx cortex hook-stop" }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "npx cortex hook-session-start" }] }],
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
    expect(cfg.mcpServers?.cortex?.command).toMatch(/^(node|npx)$/);
    const hooksBlob = JSON.stringify(cfg.hooks || {});
    expect(hooksBlob).not.toContain("hook-prompt");
    expect(hooksBlob).not.toContain("hook-stop");
    expect(hooksBlob).not.toContain("hook-session-start");
  });
});
