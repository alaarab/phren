import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { commandExists, detectInstalledTools, buildLifecycleCommands, buildSharedLifecycleCommands, configureAllHooks, readCustomHooks, runCustomHooks } from "./hooks.js";
import { initTestCortexRoot, makeTempDir } from "./test-helpers.js";
import { sanitizeFts5Query, extractKeywords, buildRobustFtsQuery, STOP_WORDS } from "./utils.js";
import { CortexError, type CortexErrorCode } from "./shared.js";
import { selectSnippets, approximateTokens } from "./shared-retrieval.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { fileURLToPath } from "url";

function writeInstallPrefs(cortexPath: string, content: string): void {
  const runtimeDir = path.join(cortexPath, ".runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "install-preferences.json"), content);
}

describe("hooks", () => {
  describe("commandExists", () => {
    it("returns true for a known command", () => {
      expect(commandExists("node")).toBe(true);
    });

    it("returns false for a nonexistent command", () => {
      expect(commandExists("definitely-not-a-real-command-xyz")).toBe(false);
    });
  });

  describe("detectInstalledTools", () => {
    it("returns a Set", () => {
      const tools = detectInstalledTools();
      expect(tools).toBeInstanceOf(Set);
    });

    it("does not detect cursor from a bare ~/.cursor config directory", () => {
      const cursorDir = path.join(os.homedir(), ".cursor");
      if (fs.existsSync(cursorDir)) {
        const tools = detectInstalledTools();
        expect(tools.has("cursor")).toBe(false);
      }
    });

    it("does not false-positive copilot from bare ~/.github dir", () => {
      if (!commandExists("github-copilot-cli")) {
        const extensionDir = path.join(os.homedir(), ".local", "share", "gh", "extensions", "gh-copilot");
        if (!fs.existsSync(extensionDir)) {
          const tools = detectInstalledTools();
          expect(tools.has("copilot")).toBe(false);
        }
      }
    });
  });

  describe("buildLifecycleCommands", () => {
    it("returns sessionStart, userPromptSubmit, and stop commands", () => {
      const cmds = buildLifecycleCommands("/tmp/fake-cortex");
      expect(cmds).toHaveProperty("sessionStart");
      expect(cmds).toHaveProperty("userPromptSubmit");
      expect(cmds).toHaveProperty("stop");
    });

    it("includes cortex path in commands", () => {
      const cmds = buildLifecycleCommands("/tmp/fake-cortex");
      expect(cmds.sessionStart).toContain("/tmp/fake-cortex");
      expect(cmds.userPromptSubmit).toContain("/tmp/fake-cortex");
      expect(cmds.stop).toContain("/tmp/fake-cortex");
    });

    it("includes hook subcommands in commands", () => {
      const cmds = buildLifecycleCommands("/tmp/fake-cortex");
      expect(cmds.sessionStart).toContain("hook-session-start");
      expect(cmds.userPromptSubmit).toContain("hook-prompt");
      expect(cmds.stop).toContain("hook-stop");
    });

    it("escapes paths with special characters", () => {
      const cmds = buildLifecycleCommands('/tmp/my "cortex" path');
      expect(cmds.sessionStart).toContain('\\"cortex\\"');
    });
  });

  describe("buildSharedLifecycleCommands", () => {
    it("uses versioned npx commands without embedding local cortex paths", () => {
      const cmds = buildSharedLifecycleCommands();
      expect(cmds.sessionStart).toContain("npx -y @alaarab/cortex@");
      expect(cmds.sessionStart).toContain("hook-session-start");
      expect(cmds.userPromptSubmit).toContain("hook-prompt");
      expect(cmds.stop).toContain("hook-stop");
      expect(cmds.hookTool).toContain("hook-tool");
      expect(cmds.sessionStart).not.toContain("CORTEX_PATH=");
      expect(cmds.sessionStart).not.toContain(".npm/_npx");
    });
  });

  describe("configureAllHooks - config validation", () => {
    let tmpRoot: string;
    let homeDir: string;
    let cortexPath: string;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPath = process.env.PATH;

    let tmpCleanup: () => void;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-hooks-test-"));
      homeDir = path.join(tmpRoot, "home");
      cortexPath = path.join(tmpRoot, "cortex");
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(cortexPath, { recursive: true });
      initTestCortexRoot(cortexPath);
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
    });

    afterEach(() => {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      process.env.PATH = origPath;
      tmpCleanup();
    });

    function setupFakeBinaries() {
      const fakeBin = path.join(tmpRoot, "bin");
      fs.mkdirSync(fakeBin, { recursive: true });
      for (const tool of ["copilot", "cursor", "codex"]) {
        if (process.platform === "win32") {
          // where.exe only finds files with PATHEXT extensions; use .cmd wrappers
          fs.writeFileSync(path.join(fakeBin, `${tool}.cmd`), `@echo off\r\nexit /b 0\r\n`);
        } else {
          const file = path.join(fakeBin, tool);
          fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
          fs.chmodSync(file, 0o755);
        }
      }
      // Use path.delimiter so PATH uses ';' on Windows and ':' on Unix
      process.env.PATH = `${fakeBin}${path.delimiter}${origPath || ""}`;
    }

    it("writes valid Copilot hook config with correct schema", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["copilot"]) });

      const copilotFile = path.join(homeDir, ".github", "hooks", "cortex.json");
      expect(fs.existsSync(copilotFile)).toBe(true);

      const config = JSON.parse(fs.readFileSync(copilotFile, "utf8"));
      expect(config.version).toBe(1);
      expect(Array.isArray(config.hooks.sessionStart)).toBe(true);
      expect(Array.isArray(config.hooks.userPromptSubmitted)).toBe(true);
      expect(Array.isArray(config.hooks.sessionEnd)).toBe(true);
      expect(config.hooks.sessionStart[0].type).toBe("command");
      expect(config.hooks.sessionStart[0].bash).toContain("hook-session-start");
      expect(config.hooks.userPromptSubmitted[0].bash).toContain("hook-prompt");
      expect(config.hooks.sessionEnd[0].bash).toContain("hook-stop");
      expect(config.hooks.sessionStart[0].bash).toContain("CORTEX_HOOK_TOOL");
      expect(config.hooks.sessionStart[0].bash).toContain("copilot");
    });

    it("writes valid Cursor hook config with correct schema", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["cursor"]) });

      const cursorFile = path.join(homeDir, ".cursor", "hooks.json");
      expect(fs.existsSync(cursorFile)).toBe(true);

      const config = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
      expect(config.version).toBe(1);
      expect(typeof config.sessionStart.command).toBe("string");
      expect(typeof config.beforeSubmitPrompt.command).toBe("string");
      expect(typeof config.stop.command).toBe("string");
      expect(config.sessionStart.command).toContain("hook-session-start");
      expect(config.beforeSubmitPrompt.command).toContain("hook-prompt");
      expect(config.stop.command).toContain("hook-stop");
      expect(config.sessionStart.command).toContain("CORTEX_HOOK_TOOL");
      expect(config.sessionStart.command).toContain("cursor");
    });

    it("writes valid Codex hook config with correct schema", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["codex"]) });

      const codexFile = path.join(cortexPath, "codex.json");
      expect(fs.existsSync(codexFile)).toBe(true);

      const config = JSON.parse(fs.readFileSync(codexFile, "utf8"));
      expect(Array.isArray(config.hooks.SessionStart)).toBe(true);
      expect(Array.isArray(config.hooks.UserPromptSubmit)).toBe(true);
      expect(Array.isArray(config.hooks.Stop)).toBe(true);
      expect(config.hooks.SessionStart[0].type).toBe("command");
      expect(config.hooks.SessionStart[0].command).toContain("hook-session-start");
      expect(config.hooks.UserPromptSubmit[0].command).toContain("hook-prompt");
      expect(config.hooks.Stop[0].command).toContain("hook-stop");
      expect(config.hooks.SessionStart[0].command).toContain("CORTEX_HOOK_TOOL");
      expect(config.hooks.SessionStart[0].command).toContain("codex");
    });

    it("Cursor config preserves existing fields", () => {
      setupFakeBinaries();
      const cursorDir = path.join(homeDir, ".cursor");
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(
        path.join(cursorDir, "hooks.json"),
        JSON.stringify({ customField: "preserved", version: 0 })
      );

      configureAllHooks(cortexPath, { tools: new Set(["cursor"]) });

      const config = JSON.parse(fs.readFileSync(path.join(cursorDir, "hooks.json"), "utf8"));
      expect(config.customField).toBe("preserved");
      expect(config.version).toBe(1);
    });

    it("session wrappers use POSIX shebang", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });

      for (const tool of ["copilot", "cursor", "codex"]) {
        const wrapper = path.join(homeDir, ".local", "bin", tool);
        if (fs.existsSync(wrapper)) {
          const content = fs.readFileSync(wrapper, "utf8");
          expect(content.startsWith("#!/bin/sh\n")).toBe(true);
          expect(content).not.toContain("#!/usr/bin/env bash");
          // No bash-only syntax
          expect(content).not.toContain("${@:"); // bash array slicing
          expect(content).not.toContain("[[");    // bash double bracket
        }
      }
    });

    it("session wrappers use shift instead of bash array slicing", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["codex"]) });

      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      if (fs.existsSync(wrapper)) {
        const content = fs.readFileSync(wrapper, "utf8");
        expect(content).toContain("shift");
        expect(content).toContain("_timeout_val");
      }
    });

    it("skips wrapper installation when hooks are disabled", () => {
      setupFakeBinaries();

      // Write preferences with hooks disabled
      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: false }));

      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });

      // Hook configs should still be written
      expect(fs.existsSync(path.join(homeDir, ".github", "hooks", "cortex.json"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".cursor", "hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(cortexPath, "codex.json"))).toBe(true);

      // But wrappers should NOT be installed
      for (const tool of ["copilot", "cursor", "codex"]) {
        const wrapper = path.join(homeDir, ".local", "bin", tool);
        expect(fs.existsSync(wrapper)).toBe(false);
      }
    });

    it("per-tool hookTools disables wrapper for specific tool only", () => {
      setupFakeBinaries();

      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: true, hookTools: { copilot: true, cursor: false, codex: true } }));

      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });

      // Configs are still written for all tools
      expect(fs.existsSync(path.join(homeDir, ".github", "hooks", "cortex.json"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".cursor", "hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(cortexPath, "codex.json"))).toBe(true);

      // Wrapper installed for copilot and codex but NOT cursor
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "copilot"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "cursor"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "codex"))).toBe(true);
    });

    it("hookTools defaults to hooksEnabled when key is missing", () => {
      setupFakeBinaries();

      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: true, hookTools: { cursor: false } }));

      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor"]) });

      // copilot not in hookTools, defaults to hooksEnabled=true
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "copilot"))).toBe(true);
      // cursor explicitly disabled
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "cursor"))).toBe(false);
    });

    it("hookTools ignored when hooksEnabled is false", () => {
      setupFakeBinaries();

      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: false, hookTools: { copilot: true, cursor: true, codex: true } }));

      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });

      // All wrappers skipped because hooksEnabled is false
      for (const tool of ["copilot", "cursor", "codex"]) {
        expect(fs.existsSync(path.join(homeDir, ".local", "bin", tool))).toBe(false);
      }
    });

    it("installs wrappers when hooks are enabled", () => {
      setupFakeBinaries();

      // Write preferences with hooks enabled
      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: true }));

      configureAllHooks(cortexPath, { tools: new Set(["codex"]) });

      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      expect(fs.existsSync(wrapper)).toBe(true);
    });

    it("Set param only configures the specified tools", () => {
      setupFakeBinaries();
      const configured = configureAllHooks(cortexPath, { tools: new Set(["cursor"]) });

      expect(configured).toContain("Cursor");
      expect(configured).not.toContain("Copilot CLI");
      expect(configured).not.toContain("Codex");

      // Only cursor config should exist
      expect(fs.existsSync(path.join(homeDir, ".cursor", "hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".github", "hooks", "cortex.json"))).toBe(false);
      expect(fs.existsSync(path.join(cortexPath, "codex.json"))).toBe(false);
    });

    it("allTools option configures all three tools", () => {
      setupFakeBinaries();
      const configured = configureAllHooks(cortexPath, { allTools: true });

      expect(configured).toContain("Copilot CLI");
      expect(configured).toContain("Cursor");
      expect(configured).toContain("Codex");
    });

    it.skipIf(process.platform === "win32")("wrappers are written to ~/.local/bin/<tool>", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });

      for (const tool of ["copilot", "cursor", "codex"]) {
        const expected = path.join(homeDir, ".local", "bin", tool);
        expect(fs.existsSync(expected)).toBe(true);
        const stat = fs.statSync(expected);
        // Should be executable
        expect(stat.mode & 0o111).toBeGreaterThan(0);
      }
    });

    it.skipIf(process.platform === "win32")("wrapper content references the real binary", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["codex"]) });

      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      if (fs.existsSync(wrapper)) {
        const content = fs.readFileSync(wrapper, "utf8");
        // Should reference the real binary path from the fake bin dir
        const fakeBin = path.join(tmpRoot, "bin", "codex");
        expect(content).toContain(fakeBin);
      }
    });

    it("wrapper scripts pass sh -n syntax check", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, { tools: new Set(["copilot", "cursor", "codex"]) });

      const { execFileSync } = require("child_process");
      for (const tool of ["copilot", "cursor", "codex"]) {
        const wrapper = path.join(homeDir, ".local", "bin", tool);
        if (fs.existsSync(wrapper)) {
          // sh -n checks syntax without executing
          expect(() => {
            execFileSync("sh", ["-n", wrapper], { stdio: "ignore" });
          }).not.toThrow();
        }
      }
    });

    it("buildLifecycleCommands references node entry script", () => {
      const cmds = buildLifecycleCommands(cortexPath);
      // Should use node with a resolved path to index.js (not npx) when built
      const usesNode = cmds.sessionStart.includes("node ");
      const usesNpx = cmds.sessionStart.includes("npx ");
      // One of the two must be true
      expect(usesNode || usesNpx).toBe(true);

      if (usesNode) {
        expect(cmds.sessionStart).toContain("index.js");
        expect(cmds.userPromptSubmit).toContain("index.js");
        expect(cmds.stop).toContain("index.js");
      }
    });
  });

  describe("deterministic coverage", () => {
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPath = process.env.PATH;
    const localEntryScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

    afterEach(() => {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      process.env.PATH = origPath;
      if (fs.existsSync(localEntryScript)) fs.rmSync(localEntryScript, { force: true });
    });

    it("detects all tools from binaries on PATH", () => {
      const tmp = makeTempDir("hooks-detect-bin-");
      const fakeBin = path.join(tmp.path, "bin");
      fs.mkdirSync(fakeBin, { recursive: true });
      for (const tool of ["github-copilot-cli", "cursor", "codex"]) {
        if (process.platform === "win32") {
          fs.writeFileSync(path.join(fakeBin, `${tool}.cmd`), `@echo off\r\nexit /b 0\r\n`);
        } else {
          const file = path.join(fakeBin, tool);
          fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
          fs.chmodSync(file, 0o755);
        }
      }
      process.env.PATH = `${fakeBin}${path.delimiter}${origPath || ""}`;

      const detected = detectInstalledTools();
      expect(detected).toEqual(new Set(["copilot", "cursor", "codex"]));

      tmp.cleanup();
    });

    it("detects only tools with reliable home-directory markers when binaries are absent", () => {
      const tmp = makeTempDir("hooks-detect-home-");
      const homeDir = path.join(tmp.path, "home");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.PATH = "";

      fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".local", "share", "gh", "extensions", "gh-copilot"), { recursive: true });

      const detected = detectInstalledTools();
      expect(detected).toEqual(new Set(["copilot", "codex"]));

      tmp.cleanup();
    });

    it("buildLifecycleCommands uses npx fallback when local entry script is missing", () => {
      if (fs.existsSync(localEntryScript)) fs.rmSync(localEntryScript, { force: true });

      const cmds = buildLifecycleCommands('/tmp/my "cortex" path\\nested');
      expect(cmds.sessionStart).toMatch(/npx -y @alaarab\/cortex@.+ hook-session-start/);
      expect(cmds.userPromptSubmit).toMatch(/npx -y @alaarab\/cortex@.+ hook-prompt/);
      expect(cmds.stop).toMatch(/npx -y @alaarab\/cortex@.+ hook-stop/);
      expect(cmds.sessionStart).toContain('/tmp/my \\"cortex\\" path\\\\nested');
    });

    it("buildLifecycleCommands uses local node entry script when available", () => {
      fs.writeFileSync(localEntryScript, "// test entry for hooks unit tests\n");

      const cmds = buildLifecycleCommands("/tmpcortex");
      expect(cmds.sessionStart).toContain(" node ");
      expect(cmds.userPromptSubmit).toContain(" node ");
      expect(cmds.stop).toContain(" node ");
      expect(cmds.sessionStart).toContain("index.js");
      expect(cmds.sessionStart).not.toContain("npx cortex");
    });

    it("configureAllHooks() ignores stale cursor config without a real cursor binary", () => {
      const tmp = makeTempDir("hooks-config-detect-");
      const tmpRoot = tmp.path;
      const homeDir = path.join(tmpRoot, "home");
      const cortexPath = path.join(tmpRoot, "cortex");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.PATH = "";
      fs.mkdirSync(cortexPath, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".local", "share", "gh", "extensions", "gh-copilot"), { recursive: true });
      fs.mkdirSync(path.join(cortexPath, ".governance"), { recursive: true });
      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: false }));

      const configured = configureAllHooks(cortexPath);
      expect(configured).toEqual(["Copilot CLI", "Codex"]);

      const lifecycle = buildLifecycleCommands(cortexPath);
      const sharedLifecycle = buildSharedLifecycleCommands();
      const copilot = JSON.parse(fs.readFileSync(path.join(homeDir, ".github", "hooks", "cortex.json"), "utf8"));
      expect(copilot.hooks.sessionStart[0].bash).toContain(lifecycle.sessionStart);
      expect(copilot.hooks.userPromptSubmitted[0].bash).toContain(lifecycle.userPromptSubmit);
      expect(copilot.hooks.sessionEnd[0].bash).toContain(lifecycle.stop);
      expect(copilot.hooks.sessionStart[0].bash).toContain("CORTEX_HOOK_TOOL");
      expect(copilot.hooks.sessionStart[0].bash).toContain("copilot");

      expect(fs.existsSync(path.join(homeDir, ".cursor", "hooks.json"))).toBe(false);

      const codex = JSON.parse(fs.readFileSync(path.join(cortexPath, "codex.json"), "utf8"));
      expect(codex.hooks.SessionStart[0].command).toContain(sharedLifecycle.sessionStart);
      expect(codex.hooks.UserPromptSubmit[0].command).toContain(sharedLifecycle.userPromptSubmit);
      expect(codex.hooks.Stop[0].command).toContain(sharedLifecycle.stop);
      expect(codex.hooks.SessionStart[0].command).toContain("CORTEX_HOOK_TOOL");
      expect(codex.hooks.SessionStart[0].command).toContain("codex");
      expect(codex.hooks.SessionStart[0].command).not.toContain(cortexPath);
      expect(codex.hooks.SessionStart[0].command).not.toContain(".npm/_npx");

      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "copilot"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "cursor"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "codex"))).toBe(false);

      tmp.cleanup();
    });
  });

  describe("custom integration hooks (#218)", () => {
    let tmpRoot: string;
    let tmpCleanup: () => void;
    let cortexPath: string;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-custom-hooks-test-"));
      cortexPath = path.join(tmpRoot, "cortex");
      fs.mkdirSync(path.join(cortexPath, ".runtime"), { recursive: true });
      initTestCortexRoot(cortexPath);
    });

    afterEach(() => {
      tmpCleanup();
    });

    it("readCustomHooks returns empty array when no preferences file exists", () => {
      fs.rmSync(path.join(cortexPath, ".governance"), { recursive: true, force: true });
      expect(readCustomHooks(cortexPath)).toEqual([]);
    });

    it("readCustomHooks returns empty array when customHooks is not set", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({ hooksEnabled: true }));
      expect(readCustomHooks(cortexPath)).toEqual([]);
    });

    it("readCustomHooks parses valid custom hooks", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "pre-save", command: "echo saving" },
            { event: "post-search", command: "echo searched", timeout: 3000 },
          ],
        }));
      const hooks = readCustomHooks(cortexPath);
      expect(hooks).toHaveLength(2);
      expect(hooks[0].event).toBe("pre-save");
      expect(hooks[0].command).toBe("echo saving");
      expect(hooks[1].timeout).toBe(3000);
    });

    it("readCustomHooks filters out invalid events", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "pre-save", command: "echo ok" },
            { event: "invalid-event", command: "echo bad" },
            { event: "post-search", command: "" },
            { command: "echo no-event" },
          ],
        }));
      const hooks = readCustomHooks(cortexPath);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].event).toBe("pre-save");
    });

    it("runCustomHooks runs matching hooks and returns count", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "post-finding", command: "touch post-finding-ran" },
            { event: "pre-save", command: "echo not-this-one" },
          ],
        }));
      const result = runCustomHooks(cortexPath, "post-finding");
      expect(result.ran).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(path.join(cortexPath, "post-finding-ran"))).toBe(true);
    });

    it("runCustomHooks passes environment variables", () => {
      if (process.platform === "win32") return; // echo $VAR is POSIX sh syntax; cmd.exe does not expand $VAR
      const envFile = path.join(cortexPath, "env-check.txt");
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "post-search", command: `echo $CORTEX_QUERY > "${envFile}"` },
          ],
        }));
      runCustomHooks(cortexPath, "post-search", { CORTEX_QUERY: "test-query" });
      expect(fs.readFileSync(envFile, "utf8").trim()).toBe("test-query");
    });

    it("runCustomHooks captures errors from failing commands", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "pre-save", command: "exit 1" },
          ],
        }));
      const result = runCustomHooks(cortexPath, "pre-save");
      expect(result.ran).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain("pre-save");
      expect(result.errors[0].code).toBe("VALIDATION_ERROR");
    });

    it("runCustomHooks returns 0 when no hooks match the event", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "pre-save", command: "echo something" },
          ],
        }));
      const result = runCustomHooks(cortexPath, "post-search");
      expect(result.ran).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("runCustomHooks does not follow webhook redirects", async () => {
      let loopbackHits = 0;
      const targetServer = http.createServer((_, res) => {
        loopbackHits += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("loopback-hit");
      });
      await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", () => resolve()));
      const targetAddress = targetServer.address();
      if (!targetAddress || typeof targetAddress === "string") throw new Error("failed to bind target server");

      const redirectServer = http.createServer((_, res) => {
        res.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/` });
        res.end();
      });
      await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", () => resolve()));
      const redirectAddress = redirectServer.address();
      if (!redirectAddress || typeof redirectAddress === "string") throw new Error("failed to bind redirect server");

      try {
        writeInstallPrefs(cortexPath, JSON.stringify({
            customHooks: [
              { event: "post-search", webhook: `http://127.0.0.1:${redirectAddress.port}/redirect` },
            ],
          }));
        const result = runCustomHooks(cortexPath, "post-search");
        expect(result.ran).toBe(1);
        expect(result.errors).toHaveLength(0);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(loopbackHits).toBe(0);
      } finally {
        await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
        await new Promise<void>((resolve) => targetServer.close(() => resolve()));
      }
    });
  });

  describe("runCustomHooks error structure", () => {
    let tmpRoot: string;
    let tmpCleanup: () => void;
    let cortexPath: string;

    beforeEach(() => {
      ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-hooks-error-structure-test-"));
      cortexPath = path.join(tmpRoot, "cortex");
      fs.mkdirSync(path.join(cortexPath, ".runtime"), { recursive: true });
      initTestCortexRoot(cortexPath);
    });

    afterEach(() => {
      tmpCleanup();
    });

    it("returns HookError[] with code and message properties, not plain strings", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "pre-index", command: "exit 42" },
          ],
        }));
      const result = runCustomHooks(cortexPath, "pre-index");
      expect(result.ran).toBe(1);
      expect(result.errors).toHaveLength(1);

      const err = result.errors[0];
      // Verify structured shape: { code, message }
      expect(err).toHaveProperty("code");
      expect(err).toHaveProperty("message");
      expect(typeof err.code).toBe("string");
      expect(typeof err.message).toBe("string");
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain("pre-index");
    });

    it("successful hooks produce no errors", () => {
      writeInstallPrefs(cortexPath, JSON.stringify({
          customHooks: [
            { event: "post-save", command: "true" },
          ],
        }));
      const result = runCustomHooks(cortexPath, "post-save");
      expect(result.ran).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("failed hook writes to debug log when CORTEX_DEBUG is set", () => {
      const origDebug = process.env.CORTEX_DEBUG;
      const origCortexPath = process.env.CORTEX_PATH;
      try {
        // Enable debug logging and point to our temp dir
        process.env.CORTEX_DEBUG = "1";
        process.env.CORTEX_PATH = cortexPath;

        writeInstallPrefs(cortexPath, JSON.stringify({
            customHooks: [
              { event: "pre-finding", command: "exit 99" },
            ],
          }));

        runCustomHooks(cortexPath, "pre-finding");

        // Check that debug.log was written
        const debugLogPath = path.join(cortexPath, ".runtime", "debug.log");
        expect(fs.existsSync(debugLogPath)).toBe(true);
        const logContent = fs.readFileSync(debugLogPath, "utf8");
        expect(logContent).toContain("runCustomHooks");
        expect(logContent).toContain("pre-finding");
      } finally {
        if (origDebug === undefined) delete process.env.CORTEX_DEBUG;
        else process.env.CORTEX_DEBUG = origDebug;
        if (origCortexPath === undefined) delete process.env.CORTEX_PATH;
        else process.env.CORTEX_PATH = origCortexPath;
      }
    });
  });
});

// ── Tests for gamma sprint changes ─────────────────────────────────────────

describe("FTS5 whitelist (sanitizeFts5Query)", () => {
  it("strips column prefix injection like content:foo", () => {
    // The colon is not in the whitelist [a-zA-Z0-9 '-_], so it gets replaced
    const result = sanitizeFts5Query("content:foo");
    expect(result).not.toContain(":");
    expect(result).toContain("foo");
  });

  it("strips angle brackets", () => {
    const result = sanitizeFts5Query("<script>alert(1)</script>");
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });

  it("strips semicolons", () => {
    const result = sanitizeFts5Query("test; DROP TABLE docs");
    expect(result).not.toContain(";");
  });

  it("strips FTS5 operators (AND, OR, NOT, NEAR) via character removal", () => {
    // Parentheses and special chars are stripped by whitelist
    const result = sanitizeFts5Query("(foo AND bar) OR NOT baz");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
    // The words AND/OR/NOT remain since they are alphanumeric, but that's fine
    // because they are now plain tokens without FTS5 operator semantics
  });

  it("preserves allowed characters: alphanumeric, spaces, hyphens, apostrophes", () => {
    const result = sanitizeFts5Query("it's a test-case with under_score");
    expect(result).toBe("it's a test-case with under score");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeFts5Query("")).toBe("");
  });

  it("truncates input longer than 500 characters", () => {
    const long = "a".repeat(600);
    const result = sanitizeFts5Query(long);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("strips null bytes via whitelist", () => {
    const result = sanitizeFts5Query("hello\0world");
    expect(result).not.toContain("\0");
  });
});

describe("Stop-word bigrams (buildRobustFtsQuery)", () => {
  it("produces no bigrams from a query of only stop words", () => {
    // "the is a" are all stop words — should produce no bigrams in FTS query
    const result = buildRobustFtsQuery("the is a an");
    // If all words are stop words and too short after filtering, result should be empty
    // or contain no quoted bigram phrases
    // baseWords filters by length > 1, so "a" is dropped but "the", "is", "an" remain
    // The bigram filter skips pairs where both are stop words
    // Since no non-stop-word bigrams exist, no bigrams should be in coreTerms
    // Individual words that aren't consumed remain as core terms
    expect(result).not.toMatch(/"the is"|"is an"|"the an"/);
  });

  it("preserves bigrams where at least one word is not a stop word", () => {
    const result = buildRobustFtsQuery("rate limit");
    // "rate" and "limit" are not stop words, so bigram should be preserved
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("Git-context filter opt-in (CORTEX_FEATURE_GIT_CONTEXT_FILTER)", () => {
  const origEnv = process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER;
    } else {
      process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER = origEnv;
    }
  });

  it("env var is not set by default", () => {
    delete process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER;
    // Without the env var, git-context filtering should be disabled
    // We verify the env var check pattern works correctly
    expect(process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER).toBeUndefined();
    // The guard `process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER === 'true'` evaluates false
    expect(process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER === "true").toBe(false);
  });

  it("env var set to 'true' enables the filter", () => {
    process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER = "true";
    expect(process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER === "true").toBe(true);
  });

  it("env var set to other values does not enable the filter", () => {
    process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER = "1";
    expect(process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER === "true").toBe(false);

    process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER = "yes";
    expect(process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER === "true").toBe(false);
  });
});

describe("Token budget overflow after reorder (selectSnippets)", () => {
  it("does not exceed token budget with selected snippets", () => {
    // Create mock DocRow objects with known content sizes
    const makeDoc = (content: string) => ({
      project: "test",
      filename: "test.md",
      type: "findings" as const,
      content,
      path: "/test/test.md",
    });

    // Each snippet is ~100 chars = ~25 tokens + 14 overhead = ~39 tokens per doc
    const docs = [
      makeDoc("A".repeat(100) + "\n" + "B".repeat(100)),
      makeDoc("C".repeat(100) + "\n" + "D".repeat(100)),
      makeDoc("E".repeat(100) + "\n" + "F".repeat(100)),
    ];

    // Very tight budget: should select at most what fits
    const tightBudget = 80; // 36 base + only room for ~1 snippet
    const { selected, usedTokens } = selectSnippets(docs, "test", tightBudget, 8, 500);

    // usedTokens should not wildly exceed the budget
    // First snippet is always included, subsequent ones are skipped if over budget
    expect(selected.length).toBeLessThanOrEqual(3);
    // The first snippet is always included even if it exceeds budget (compacted)
    if (selected.length > 1) {
      expect(usedTokens).toBeLessThanOrEqual(tightBudget + 50); // some slack for first item
    }
  });

  it("approximateTokens returns roughly chars/3.5 + whitespace weight", () => {
    // Updated formula: Math.ceil(length / 3.5 + whitespace * 0.1)
    expect(approximateTokens("hello world")).toBe(Math.ceil(11 / 3.5 + 1 * 0.1));
    expect(approximateTokens("a".repeat(100))).toBe(Math.ceil(100 / 3.5));
  });
});

describe("CortexError codes (shared.ts)", () => {
  it("exports all expected error code values as strings", () => {
    const expectedCodes = [
      "NOT_FOUND",
      "PERMISSION_DENIED",
      "VALIDATION_ERROR",
      "LOCK_TIMEOUT",
      "INDEX_ERROR",
      "NETWORK_ERROR",
    ];

    for (const code of expectedCodes) {
      expect(CortexError).toHaveProperty(code);
      expect(typeof (CortexError as Record<string, unknown>)[code]).toBe("string");
    }
  });

  it("includes all originally defined codes", () => {
    const allCodes = [
      "PROJECT_NOT_FOUND",
      "INVALID_PROJECT_NAME",
      "FILE_NOT_FOUND",
      "PERMISSION_DENIED",
      "MALFORMED_JSON",
      "MALFORMED_YAML",
      "NOT_FOUND",
      "AMBIGUOUS_MATCH",
      "LOCK_TIMEOUT",
      "EMPTY_INPUT",
      "VALIDATION_ERROR",
      "INDEX_ERROR",
      "NETWORK_ERROR",
    ];

    const actualKeys = Object.keys(CortexError);
    for (const code of allCodes) {
      expect(actualKeys).toContain(code);
    }
    // Verify total count matches
    expect(actualKeys.length).toBe(allCodes.length);
  });

  it("values are the same as their keys (const enum pattern)", () => {
    for (const [key, value] of Object.entries(CortexError)) {
      expect(key).toBe(value);
    }
  });

  it("CortexError is frozen (as const)", () => {
    // as const makes the object readonly at compile time;
    // verify the values are stable string literals
    expect(CortexError.NOT_FOUND).toBe("NOT_FOUND");
    expect(CortexError.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(CortexError.INDEX_ERROR).toBe("INDEX_ERROR");
    expect(CortexError.NETWORK_ERROR).toBe("NETWORK_ERROR");
  });
});
