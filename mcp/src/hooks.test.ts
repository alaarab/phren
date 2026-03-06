import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { commandExists, detectInstalledTools, buildLifecycleCommands, configureAllHooks } from "./hooks.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

    it("detects cursor when ~/.cursor exists", () => {
      const cursorDir = path.join(os.homedir(), ".cursor");
      if (fs.existsSync(cursorDir)) {
        const tools = detectInstalledTools();
        expect(tools.has("cursor")).toBe(true);
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

  describe("configureAllHooks - config validation", () => {
    let tmpRoot: string;
    let homeDir: string;
    let cortexPath: string;
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPath = process.env.PATH;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hooks-test-"));
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

    function setupFakeBinaries() {
      const fakeBin = path.join(tmpRoot, "bin");
      fs.mkdirSync(fakeBin, { recursive: true });
      for (const tool of ["copilot", "cursor", "codex"]) {
        const file = path.join(fakeBin, tool);
        fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(file, 0o755);
      }
      process.env.PATH = `${fakeBin}:${origPath || ""}`;
    }

    it("writes valid Copilot hook config with correct schema", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, new Set(["copilot"]));

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
    });

    it("writes valid Cursor hook config with correct schema", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, new Set(["cursor"]));

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
    });

    it("writes valid Codex hook config with correct schema", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, new Set(["codex"]));

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
    });

    it("Cursor config preserves existing fields", () => {
      setupFakeBinaries();
      const cursorDir = path.join(homeDir, ".cursor");
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(
        path.join(cursorDir, "hooks.json"),
        JSON.stringify({ customField: "preserved", version: 0 })
      );

      configureAllHooks(cortexPath, new Set(["cursor"]));

      const config = JSON.parse(fs.readFileSync(path.join(cursorDir, "hooks.json"), "utf8"));
      expect(config.customField).toBe("preserved");
      expect(config.version).toBe(1);
    });

    it("session wrappers use POSIX shebang", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, new Set(["copilot", "cursor", "codex"]));

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
      configureAllHooks(cortexPath, new Set(["codex"]));

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
      const govDir = path.join(cortexPath, ".governance");
      fs.mkdirSync(govDir, { recursive: true });
      fs.writeFileSync(
        path.join(govDir, "install-preferences.json"),
        JSON.stringify({ hooksEnabled: false })
      );

      configureAllHooks(cortexPath, new Set(["copilot", "cursor", "codex"]));

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

    it("installs wrappers when hooks are enabled", () => {
      setupFakeBinaries();

      // Write preferences with hooks enabled
      const govDir = path.join(cortexPath, ".governance");
      fs.mkdirSync(govDir, { recursive: true });
      fs.writeFileSync(
        path.join(govDir, "install-preferences.json"),
        JSON.stringify({ hooksEnabled: true })
      );

      configureAllHooks(cortexPath, new Set(["codex"]));

      const wrapper = path.join(homeDir, ".local", "bin", "codex");
      expect(fs.existsSync(wrapper)).toBe(true);
    });

    it("Set param only configures the specified tools", () => {
      setupFakeBinaries();
      const configured = configureAllHooks(cortexPath, new Set(["cursor"]));

      expect(configured).toContain("Cursor");
      expect(configured).not.toContain("Copilot CLI");
      expect(configured).not.toContain("Codex");

      // Only cursor config should exist
      expect(fs.existsSync(path.join(homeDir, ".cursor", "hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, ".github", "hooks", "cortex.json"))).toBe(false);
      expect(fs.existsSync(path.join(cortexPath, "codex.json"))).toBe(false);
    });

    it("boolean true configures all three tools", () => {
      setupFakeBinaries();
      const configured = configureAllHooks(cortexPath, true);

      expect(configured).toContain("Copilot CLI");
      expect(configured).toContain("Cursor");
      expect(configured).toContain("Codex");
    });

    it("wrappers are written to ~/.local/bin/<tool>", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, new Set(["copilot", "cursor", "codex"]));

      for (const tool of ["copilot", "cursor", "codex"]) {
        const expected = path.join(homeDir, ".local", "bin", tool);
        expect(fs.existsSync(expected)).toBe(true);
        const stat = fs.statSync(expected);
        // Should be executable
        expect(stat.mode & 0o111).toBeGreaterThan(0);
      }
    });

    it("wrapper content references the real binary", () => {
      setupFakeBinaries();
      configureAllHooks(cortexPath, new Set(["codex"]));

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
      configureAllHooks(cortexPath, new Set(["copilot", "cursor", "codex"]));

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
    const localEntryScript = path.join(path.dirname(new URL(import.meta.url).pathname), "index.js");

    afterEach(() => {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUserProfile;
      process.env.PATH = origPath;
      if (fs.existsSync(localEntryScript)) fs.rmSync(localEntryScript, { force: true });
    });

    it("detects all tools from binaries on PATH", () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-detect-bin-"));
      const fakeBin = path.join(tmpRoot, "bin");
      fs.mkdirSync(fakeBin, { recursive: true });
      for (const tool of ["github-copilot-cli", "cursor", "codex"]) {
        const file = path.join(fakeBin, tool);
        fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
        fs.chmodSync(file, 0o755);
      }
      process.env.PATH = `${fakeBin}:${origPath || ""}`;

      const detected = detectInstalledTools();
      expect(detected).toEqual(new Set(["copilot", "cursor", "codex"]));

      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("detects all tools from home-directory markers when binaries are absent", () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-detect-home-"));
      const homeDir = path.join(tmpRoot, "home");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.PATH = "";

      fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".local", "share", "gh", "extensions", "gh-copilot"), { recursive: true });

      const detected = detectInstalledTools();
      expect(detected).toEqual(new Set(["copilot", "cursor", "codex"]));

      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("buildLifecycleCommands uses npx fallback when local entry script is missing", () => {
      if (fs.existsSync(localEntryScript)) fs.rmSync(localEntryScript, { force: true });

      const cmds = buildLifecycleCommands('/tmp/my "cortex" path\\nested');
      expect(cmds.sessionStart).toContain("npx @alaarab/cortex hook-session-start");
      expect(cmds.userPromptSubmit).toContain("npx @alaarab/cortex hook-prompt");
      expect(cmds.stop).toContain("npx @alaarab/cortex hook-stop");
      expect(cmds.sessionStart).toContain('CORTEX_PATH="/tmp/my \\"cortex\\" path\\\\nested"');
    });

    it("buildLifecycleCommands uses local node entry script when available", () => {
      fs.writeFileSync(localEntryScript, "// test entry for hooks unit tests\n");

      const cmds = buildLifecycleCommands("/tmp/cortex");
      expect(cmds.sessionStart).toContain(" node ");
      expect(cmds.userPromptSubmit).toContain(" node ");
      expect(cmds.stop).toContain(" node ");
      expect(cmds.sessionStart).toContain("index.js");
      expect(cmds.sessionStart).not.toContain("npx @alaarab/cortex");
    });

    it("configureAllHooks(false) wires configs from auto-detected tools", () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-config-detect-"));
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
      fs.writeFileSync(
        path.join(cortexPath, ".governance", "install-preferences.json"),
        JSON.stringify({ hooksEnabled: false })
      );

      const configured = configureAllHooks(cortexPath, false);
      expect(configured).toEqual(["Copilot CLI", "Cursor", "Codex"]);

      const lifecycle = buildLifecycleCommands(cortexPath);
      const copilot = JSON.parse(fs.readFileSync(path.join(homeDir, ".github", "hooks", "cortex.json"), "utf8"));
      expect(copilot.hooks.sessionStart[0].bash).toBe(lifecycle.sessionStart);
      expect(copilot.hooks.userPromptSubmitted[0].bash).toBe(lifecycle.userPromptSubmit);
      expect(copilot.hooks.sessionEnd[0].bash).toBe(lifecycle.stop);

      const cursor = JSON.parse(fs.readFileSync(path.join(homeDir, ".cursor", "hooks.json"), "utf8"));
      expect(cursor.sessionStart.command).toBe(lifecycle.sessionStart);
      expect(cursor.beforeSubmitPrompt.command).toBe(lifecycle.userPromptSubmit);
      expect(cursor.stop.command).toBe(lifecycle.stop);

      const codex = JSON.parse(fs.readFileSync(path.join(cortexPath, "codex.json"), "utf8"));
      expect(codex.hooks.SessionStart[0].command).toBe(lifecycle.sessionStart);
      expect(codex.hooks.UserPromptSubmit[0].command).toBe(lifecycle.userPromptSubmit);
      expect(codex.hooks.Stop[0].command).toBe(lifecycle.stop);

      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "copilot"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "cursor"))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, ".local", "bin", "codex"))).toBe(false);

      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
  });
});
