import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  commandExists,
  detectInstalledTools,
  buildLifecycleCommands,
  buildSharedLifecycleCommands,
  configureAllHooks,
  readCustomHooks,
  runCustomHooks,
  type CustomHookEvent,
} from "../hooks.js";
import { makeTempDir } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("hooks platform compatibility", () => {
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPath = process.env.PATH;
  let tmpRoot: string;
  let tmpCleanup: () => void;
  let phrenPath: string;
  let homeDir: string;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-hooks-plat-"));
    homeDir = path.join(tmpRoot, "home");
    phrenPath = path.join(tmpRoot, "phren");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(phrenPath, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    process.env.PATH = origPath;
    tmpCleanup();
  });

  function writeInstallPrefs(content: string): void {
    const runtimeDir = path.join(phrenPath, ".runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, "install-preferences.json"), content);
  }

  function setupFakeBinaries(tools: string[] = ["copilot", "cursor", "codex"]) {
    const fakeBin = path.join(tmpRoot, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    for (const tool of tools) {
      if (process.platform === "win32") {
        fs.writeFileSync(path.join(fakeBin, `${tool}.cmd`), `@echo off\r\nexit /b 0\r\n`);
      } else {
        const file = path.join(fakeBin, tool);
        fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(file, 0o755);
      }
    }
    process.env.PATH = `${fakeBin}${path.delimiter}${origPath || ""}`;
  }

  describe("buildLifecycleCommands platform behavior", () => {
    it("generates hookTool command alongside other lifecycle commands", () => {
      const cmds = buildLifecycleCommands(phrenPath);
      const pathInCmd = phrenPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      expect(cmds).toHaveProperty("hookTool");
      expect(cmds.hookTool).toContain("hook-tool");
      expect(cmds.hookTool).toContain(pathInCmd);
    });

    it("handles paths with spaces correctly", () => {
      const spacedPath = path.join(tmpRoot, "my phren path");
      fs.mkdirSync(spacedPath, { recursive: true });
      const cmds = buildLifecycleCommands(spacedPath);
      expect(cmds.sessionStart).toContain("my phren path");
      // Path should be quoted
      expect(cmds.sessionStart).toContain('"');
    });

    it("handles paths with backslashes", () => {
      const cmds = buildLifecycleCommands("/tmp/path\\with\\backslashes");
      expect(cmds.sessionStart).toContain("\\\\");
    });

    it("all four commands reference the same phren path", () => {
      const cmds = buildLifecycleCommands(phrenPath);
      const pathInCmd = phrenPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      for (const cmd of [cmds.sessionStart, cmds.userPromptSubmit, cmds.stop, cmds.hookTool]) {
        expect(cmd).toContain(pathInCmd);
      }
    });
  });

  describe("configureAllHooks tool selection", () => {
    it("returns empty array when no tools are detected and none specified", () => {
      process.env.PATH = "";
      const configured = configureAllHooks(phrenPath);
      expect(configured).toEqual([]);
    });

    it("configures only a single tool when specified", () => {
      setupFakeBinaries();
      const configured = configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      expect(configured).toContain("Codex");
      expect(configured).not.toContain("Copilot CLI");
      expect(configured).not.toContain("Cursor");
    });

    it("configures two of three tools when only two specified", () => {
      setupFakeBinaries();
      const configured = configureAllHooks(phrenPath, { tools: new Set(["copilot", "codex"]) });
      expect(configured).toContain("Copilot CLI");
      expect(configured).toContain("Codex");
      expect(configured).not.toContain("Cursor");
    });

    it("Codex config is stored in phrenPath not homeDir", () => {
      setupFakeBinaries();
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const codexFile = path.join(phrenPath, "codex.json");
      expect(fs.existsSync(codexFile)).toBe(true);
      const codex = JSON.parse(fs.readFileSync(codexFile, "utf8"));
      const sharedLifecycle = buildSharedLifecycleCommands();
      expect(codex.hooks.SessionStart[0].command).toContain(sharedLifecycle.sessionStart);
      expect(codex.hooks.SessionStart[0].command).toContain("PHREN_HOOK_TOOL");
      expect(codex.hooks.SessionStart[0].command).toContain("codex");
      expect(codex.hooks.SessionStart[0].command).not.toContain(phrenPath);
      // Should NOT be in home directory
      expect(fs.existsSync(path.join(homeDir, "codex.json"))).toBe(false);
    });

    it("Copilot config uses .github/hooks/ directory structure", () => {
      setupFakeBinaries();
      configureAllHooks(phrenPath, { tools: new Set(["copilot"]) });
      const copilotFile = path.join(homeDir, ".github", "hooks", "phren.json");
      expect(fs.existsSync(copilotFile)).toBe(true);
    });
  });

  describe("custom hooks edge cases", () => {
    it("readCustomHooks handles malformed JSON gracefully", () => {
      writeInstallPrefs("{ invalid json }}}");
      expect(readCustomHooks(phrenPath)).toEqual([]);
    });

    it("readCustomHooks filters hooks with whitespace-only commands", () => {
      writeInstallPrefs(
        JSON.stringify({
          customHooks: [
            { event: "pre-save", command: "   " },
            { event: "post-save", command: "echo ok" },
          ],
        })
      );
      const hooks = readCustomHooks(phrenPath);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].event).toBe("post-save");
    });

    it("readCustomHooks handles all valid event types", () => {
      const validEvents: CustomHookEvent[] = [
        "pre-save", "post-save", "post-search",
        "pre-finding", "post-finding",
        "pre-index", "post-index",
      ];
      writeInstallPrefs(
        JSON.stringify({
          customHooks: validEvents.map((event) => ({ event, command: "echo test" })),
        })
      );
      const hooks = readCustomHooks(phrenPath);
      expect(hooks).toHaveLength(validEvents.length);
    });

    it("runCustomHooks sets PHREN_PATH and PHREN_HOOK_EVENT env vars", () => {
      if (process.platform === "win32") return; // echo $VAR is POSIX sh syntax; cmd.exe treats $VAR as literal
      const envFile = path.join(phrenPath, "env-vars.txt");
      writeInstallPrefs(
        JSON.stringify({
          customHooks: [
            { event: "pre-index", command: `echo "$PHREN_PATH|$PHREN_HOOK_EVENT" > "${envFile}"` },
          ],
        })
      );
      runCustomHooks(phrenPath, "pre-index");
      const content = fs.readFileSync(envFile, "utf8").trim();
      expect(content).toContain(phrenPath);
      expect(content).toContain("pre-index");
    });

    it("runCustomHooks respects custom timeout", () => {
      if (process.platform === "win32") return; // sleep is POSIX
      writeInstallPrefs(
        JSON.stringify({
          customHooks: [
            // Very short timeout should cause a timeout error
            { event: "pre-save", command: "sleep 10", timeout: 100 },
          ],
        })
      );
      const result = runCustomHooks(phrenPath, "pre-save");
      expect(result.ran).toBe(1);
      // errors[0] is a HookError object with {code, message} properties
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toHaveProperty("code");
      expect(result.errors[0]).toHaveProperty("message");
      expect(result.errors[0].message).toContain("pre-save");
    });

    it("runCustomHooks runs multiple matching hooks in sequence", () => {
      if (process.platform === "win32") return; // shell >> append redirect unreliable in cmd.exe via Node stdio:ignore
      const outputFile = path.join(phrenPath, "multi-hook.txt");
      writeInstallPrefs(
        JSON.stringify({
          customHooks: [
            { event: "post-finding", command: `echo "first" >> "${outputFile}"` },
            { event: "post-finding", command: `echo "second" >> "${outputFile}"` },
            { event: "pre-save", command: "echo not-this" },
          ],
        })
      );
      const result = runCustomHooks(phrenPath, "post-finding");
      expect(result.ran).toBe(2);
      expect(result.errors).toHaveLength(0);
      const content = fs.readFileSync(outputFile, "utf8");
      expect(content).toContain("first");
      expect(content).toContain("second");
    });
  });

  describe("hook preferences and tool-level control", () => {
    it("missing install-preferences.json defaults to hooks enabled", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      // Wrapper should be installed because default is enabled
      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      expect(fs.existsSync(wrapper)).toBe(true);
    });

    it("empty hookTools object defaults all tools to hooksEnabled value", () => {
      setupFakeBinaries(["copilot", "cursor"]);
      writeInstallPrefs(JSON.stringify({ hooksEnabled: true, hookTools: {} }));
      configureAllHooks(phrenPath, { tools: new Set(["copilot", "cursor"]) });
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "copilot"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "cursor"))).toBe(true);
    });

    it("handles non-object hookTools gracefully", () => {
      setupFakeBinaries(["codex"]);
      writeInstallPrefs(JSON.stringify({ hooksEnabled: true, hookTools: "not-an-object" }));
      // Should not throw, just default to enabled
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "codex"))).toBe(true);
    });
  });

  describe("wrapper script structure", () => {
    it.skipIf(process.platform === "win32")("wrapper contains run_with_timeout function", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      if (fs.existsSync(wrapper)) {
        const content = fs.readFileSync(wrapper, "utf8");
        expect(content).toContain("run_with_timeout");
        expect(content).toContain("PHREN_HOOK_TIMEOUT_S");
        expect(content).toContain("14}");
      }
    });

    it.skipIf(process.platform === "win32")("wrapper passes through help/version/completion flags", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      if (fs.existsSync(wrapper)) {
        const content = fs.readFileSync(wrapper, "utf8");
        expect(content).toContain("--help");
        expect(content).toContain("--version");
        expect(content).toContain("completion");
      }
    });

    it.skipIf(process.platform === "win32")("wrapper uses set -u for undefined variable safety", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      if (fs.existsSync(wrapper)) {
        const content = fs.readFileSync(wrapper, "utf8");
        expect(content).toContain("set -u");
      }
    });
  });
});
