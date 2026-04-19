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
    // On Windows, paths in commands get double-backslash escaped inside set "VAR=..."
    const isWin = process.platform === "win32";
    function cmdContainsPath(cmd: string, p: string): boolean {
      if (cmd.includes(p)) return true;
      // On Windows, backslashes are doubled in the set command
      if (isWin && cmd.includes(p.replace(/\\/g, "\\\\"))) return true;
      return false;
    }

    it("generates hookTool command alongside other lifecycle commands", () => {
      const cmds = buildLifecycleCommands(phrenPath);
      expect(cmds).toHaveProperty("hookTool");
      expect(cmds.hookTool).toContain("hook-tool");
      expect(cmdContainsPath(cmds.hookTool, phrenPath)).toBe(true);
    });

    it("handles paths with spaces correctly", () => {
      const spacedPath = path.join(tmpRoot, "my phren path");
      fs.mkdirSync(spacedPath, { recursive: true });
      const cmds = buildLifecycleCommands(spacedPath);
      expect(cmds.sessionStart).toContain("my phren path");
      // Path should be quoted — single quotes on POSIX, double quotes on Windows
      if (isWin) {
        expect(cmds.sessionStart).toContain('set "PHREN_PATH=');
      } else {
        expect(cmds.sessionStart).toContain("PHREN_PATH='");
      }
    });

    it("handles paths with backslashes", () => {
      const cmds = buildLifecycleCommands("/tmp/path\\with\\backslashes");
      expect(cmdContainsPath(cmds.sessionStart, "/tmp/path\\with\\backslashes")).toBe(true);
    });

    it("all four commands reference the same phren path", () => {
      const cmds = buildLifecycleCommands(phrenPath);
      for (const cmd of [cmds.sessionStart, cmds.userPromptSubmit, cmds.stop, cmds.hookTool]) {
        expect(cmdContainsPath(cmd, phrenPath)).toBe(true);
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
      const helperScript = path.join(phrenPath, "env-helper.sh");
      fs.writeFileSync(helperScript, `#!/bin/sh\necho "$PHREN_PATH|$PHREN_HOOK_EVENT" > "${envFile}"\n`);
      fs.chmodSync(helperScript, 0o755);
      writeInstallPrefs(
        JSON.stringify({
          customHooks: [
            { event: "pre-index", command: helperScript },
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
      const helperScript1 = path.join(phrenPath, "hook1.sh");
      const helperScript2 = path.join(phrenPath, "hook2.sh");
      fs.writeFileSync(helperScript1, `#!/bin/sh\necho "first" >> "${outputFile}"\n`);
      fs.writeFileSync(helperScript2, `#!/bin/sh\necho "second" >> "${outputFile}"\n`);
      fs.chmodSync(helperScript1, 0o755);
      fs.chmodSync(helperScript2, 0o755);
      writeInstallPrefs(
        JSON.stringify({
          customHooks: [
            { event: "post-finding", command: helperScript1 },
            { event: "post-finding", command: helperScript2 },
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
    const wrapperExt = process.platform === "win32" ? ".cmd" : "";

    it("missing install-preferences.json defaults to hooks enabled", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      // Wrapper should be installed because default is enabled
      const wrapper = path.join(homeDir, ".local", "bin", `codex${wrapperExt}`);
      expect(fs.existsSync(wrapper)).toBe(true);
    });

    it("empty hookTools object defaults all tools to hooksEnabled value", () => {
      setupFakeBinaries(["copilot", "cursor"]);
      writeInstallPrefs(JSON.stringify({ hooksEnabled: true, hookTools: {} }));
      configureAllHooks(phrenPath, { tools: new Set(["copilot", "cursor"]) });
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", `copilot${wrapperExt}`))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", `cursor${wrapperExt}`))).toBe(true);
    });

    it("handles non-object hookTools gracefully", () => {
      setupFakeBinaries(["codex"]);
      writeInstallPrefs(JSON.stringify({ hooksEnabled: true, hookTools: "not-an-object" }));
      // Should not throw, just default to enabled
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", `codex${wrapperExt}`))).toBe(true);
    });
  });

  describe("wrapper script structure", () => {
    const wrapperExt = process.platform === "win32" ? ".cmd" : "";

    it("wrapper carries a run_with_timeout mechanism on every platform", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", `codex${wrapperExt}`);
      expect(fs.existsSync(wrapper)).toBe(true);
      const content = fs.readFileSync(wrapper, "utf8");
      // POSIX wrapper: shell function. Windows wrapper: :run_with_timeout label.
      expect(content).toContain("run_with_timeout");
      expect(content).toContain("PHREN_HOOK_TIMEOUT_S");
    });

    it("wrapper passes through help/version/completion flags", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", `codex${wrapperExt}`);
      expect(fs.existsSync(wrapper)).toBe(true);
      const content = fs.readFileSync(wrapper, "utf8");
      expect(content).toContain("--help");
      expect(content).toContain("--version");
      expect(content).toContain("completion");
    });

    it.skipIf(process.platform === "win32")("wrapper uses set -u for undefined variable safety", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", `codex${wrapperExt}`);
      expect(fs.existsSync(wrapper)).toBe(true);
      const content = fs.readFileSync(wrapper, "utf8");
      expect(content).toContain("set -u");
    });

    it.skipIf(process.platform !== "win32")("Windows wrapper bounds hook calls via PowerShell Start-Job", () => {
      setupFakeBinaries(["codex"]);
      configureAllHooks(phrenPath, { tools: new Set(["codex"]) });
      const wrapper = path.join(homeDir, ".local", "bin", `codex${wrapperExt}`);
      expect(fs.existsSync(wrapper)).toBe(true);
      const content = fs.readFileSync(wrapper, "utf8");
      expect(content).toContain("PHREN_HOOK_CMD");
      expect(content).toContain("Start-Job");
      expect(content).toContain("Wait-Job");
    });
  });

  describe("forcePosix output (Copilot's bash: key) works on Windows", () => {
    it("forcePosix=true yields POSIX-style env prefixing even on Windows", () => {
      const cmds = buildLifecycleCommands(phrenPath, { forcePosix: true });
      // Should use POSIX `VAR=value command` prefix, not cmd `set "VAR=..." && ...`.
      expect(cmds.sessionStart.startsWith("set \"")).toBe(false);
      expect(cmds.sessionStart).toMatch(/^PHREN_PATH=/);
      expect(cmds.userPromptSubmit).toMatch(/^PHREN_PATH=/);
      expect(cmds.stop).toMatch(/^PHREN_PATH=/);
    });

    it.skipIf(process.platform !== "win32")("Copilot hook config ships bash-compatible commands on Windows", () => {
      setupFakeBinaries(["copilot"]);
      configureAllHooks(phrenPath, { tools: new Set(["copilot"]) });
      const copilotFile = path.join(homeDir, ".github", "hooks", "phren.json");
      expect(fs.existsSync(copilotFile)).toBe(true);
      const cfg = JSON.parse(fs.readFileSync(copilotFile, "utf8"));
      const bash = cfg.hooks.sessionStart[0].bash as string;
      // cmd's `set "VAR=..." && ...` would not parse in Git Bash — reject it.
      expect(bash.startsWith("set \"")).toBe(false);
      // Should look like: PHREN_HOOK_TOOL='copilot' PHREN_PATH='...' ... hook-session-start
      expect(bash).toMatch(/PHREN_HOOK_TOOL=/);
      expect(bash).toContain("hook-session-start");
    });
  });
});
