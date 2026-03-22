import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTempDir, suppressOutput } from "./test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
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
  listTemplates,
  parseMcpMode,
  resetVSCodeProbeCache,
  runInit,
  getVerifyOutcomeNote,
  runPostInitVerify,
  setHooksEnabledPreference,
  setMcpEnabledPreference,
  warmSemanticSearch,
} from "./init/init.js";
import { applyStarterTemplateUpdates, getHookEntrypointCheck } from "./init/setup.js";
import { VERSION } from "./init/shared.js";
import { collectNativeMemoryFiles } from "./shared.js";

describe.sequential("mcp mode configuration", () => {
  let tmpRoot: string;
  let homeDir: string;
  let phrenPath: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-init-test-"));
    homeDir = path.join(tmpRoot, "home");
    phrenPath = path.join(tmpRoot, "phren");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(phrenPath, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    resetVSCodeProbeCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    tmpCleanup();
  });

  it("parses mcp mode values", () => {
    expect(parseMcpMode("on")).toBe("on");
    expect(parseMcpMode("OFF")).toBe("off");
    expect(parseMcpMode("status")).toBeUndefined();
    expect(parseMcpMode("")).toBeUndefined();
  });

  it("supports init --dry-run without creating files", async () => {
    const dryRunPath = path.join(tmpRoot, "dry-run-phren");
    process.env.PHREN_PATH = dryRunPath;
    expect(fs.existsSync(dryRunPath)).toBe(false);

    await runInit({ dryRun: true });

    expect(fs.existsSync(dryRunPath)).toBe(false);
    delete process.env.PHREN_PATH;
  });

  it("dry-run reports project enrollment when run inside an untracked repo", async () => {
    const dryRunPath = path.join(tmpRoot, "dry-run-bootstrap-phren");
    const projectDir = path.join(tmpRoot, "tracked-repo");
    const origCwd = process.cwd();
    process.env.PHREN_PATH = dryRunPath;
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
    process.chdir(projectDir);

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => { chunks.push(String(chunk)); return true; }) as any;
    try {
      await runInit({ dryRun: true });
    } finally {
      process.stdout.write = origWrite;
      process.chdir(origCwd);
    }

    const output = chunks.join("");
    expect(output).toContain("Would offer to add current project directory");
    expect(output).toContain(projectDir);
    delete process.env.PHREN_PATH;
  });

  it("stages starter updates for modified global skills instead of overwriting them", () => {
    const targetSkill = path.join(phrenPath, "global", "skills", "audit.md");
    fs.mkdirSync(path.dirname(targetSkill), { recursive: true });
    fs.writeFileSync(targetSkill, "# custom audit\n");

    const updates = applyStarterTemplateUpdates(phrenPath);
    const stagedSkill = path.join(phrenPath, ".runtime", "starter-updates", "global", "skills", "audit.md.new");
    const currentSkill = path.join(phrenPath, ".runtime", "starter-updates", "global", "skills", "audit.md.current");

    expect(fs.readFileSync(targetSkill, "utf8")).toBe("# custom audit\n");
    expect(fs.existsSync(`${targetSkill}.bak`)).toBe(false);
    expect(fs.existsSync(`${targetSkill}.new`)).toBe(false);
    expect(fs.existsSync(stagedSkill)).toBe(true);
    expect(fs.existsSync(currentSkill)).toBe(true);
    expect(updates).toContain(path.join(".runtime", "starter-updates", "global", "skills", "audit.md.new"));
  });

  it("ships starter gitignore entries for local governance runtime state", () => {
    const starterGitignore = fs.readFileSync(path.join("starter", ".gitignore"), "utf8");

    expect(starterGitignore).not.toContain(".config/runtime-health.json");
    expect(starterGitignore).not.toContain(".config/memory-scores.json");
    expect(starterGitignore).not.toContain(".config/shell-state.json");
    expect(starterGitignore).toContain(".runtime/");
    expect(starterGitignore).toContain(".sessions/");
  });

  it("defaults to mcp enabled and persists preference updates", () => {
    expect(getMcpEnabledPreference(phrenPath)).toBe(true);
    setMcpEnabledPreference(phrenPath, false);
    expect(getMcpEnabledPreference(phrenPath)).toBe(false);
    setMcpEnabledPreference(phrenPath, true);
    expect(getMcpEnabledPreference(phrenPath)).toBe(true);
  });

  it("defaults to hooks enabled and persists preference updates", () => {
    expect(getHooksEnabledPreference(phrenPath)).toBe(true);
    setHooksEnabledPreference(phrenPath, false);
    expect(getHooksEnabledPreference(phrenPath)).toBe(false);
    setHooksEnabledPreference(phrenPath, true);
    expect(getHooksEnabledPreference(phrenPath)).toBe(true);
  });

  it("toggles Claude MCP config on and off while keeping hooks", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          servers: {
            phren: { command: "npx", args: ["-y", "phren", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureClaude(phrenPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(offCfg.mcpServers?.phren).toBeUndefined();
    expect(Array.isArray(offCfg.hooks?.UserPromptSubmit)).toBe(true);
    expect(Array.isArray(offCfg.hooks?.Stop)).toBe(true);
    expect(Array.isArray(offCfg.hooks?.SessionStart)).toBe(true);

    const onStatus = configureClaude(phrenPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(onCfg.mcpServers?.phren?.command).toMatch(/^(node|npx)$/);
    expect(onCfg.mcpServers?.phren?.args).toContain(phrenPath);
  });

  it("can disable and re-enable Claude hooks independently from MCP", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    configureClaude(phrenPath, { mcpEnabled: true, hooksEnabled: false });
    const offCfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const offHooks = JSON.stringify(offCfg.hooks || {});
    expect(offHooks).not.toContain("hook-prompt");
    expect(offHooks).not.toContain("hook-stop");
    expect(offHooks).not.toContain("hook-session-start");

    configureClaude(phrenPath, { mcpEnabled: true, hooksEnabled: true });
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
          mcpServers: {
            phren: { command: "npx", args: ["-y", "phren", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureVSCode(phrenPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(offCfg.servers?.phren).toBeUndefined();

    const onStatus = configureVSCode(phrenPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.servers?.phren?.command).toMatch(/^(node|npx)$/);
    expect(onCfg.servers?.phren?.args).toContain(phrenPath);
  });

  it("detects VS Code in USERPROFILE/AppData/Roaming path", () => {
    const roamingDir = path.join(homeDir, "AppData", "Roaming", "Code", "User");
    fs.mkdirSync(roamingDir, { recursive: true });
    const mcpPath = path.join(roamingDir, "mcp.json");

    const onStatus = configureVSCode(phrenPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");

    const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(cfg.servers?.phren?.command).toMatch(/^(node|npx)$/);
    expect(cfg.servers?.phren?.args).toContain(phrenPath);
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
            phren: { command: "npx", args: ["-y", "phren", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureCursorMcp(phrenPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(offCfg.mcpServers?.phren).toBeUndefined();

    const onStatus = configureCursorMcp(phrenPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.mcpServers?.phren?.command).toMatch(/^(node|npx)$/);
    expect(onCfg.mcpServers?.phren?.args).toContain(phrenPath);
  });

  it("toggles Copilot CLI MCP config on and off with canonical mcpServers config", () => {
    const copilotDir = path.join(homeDir, ".github");
    fs.mkdirSync(copilotDir, { recursive: true });
    const mcpPath = path.join(copilotDir, "mcp.json");
    fs.writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            phren: { command: "npx", args: ["-y", "phren", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureCopilotMcp(phrenPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(offCfg.mcpServers?.phren).toBeUndefined();

    const onStatus = configureCopilotMcp(phrenPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.mcpServers?.phren?.command).toMatch(/^(node|npx)$/);
    expect(onCfg.mcpServers?.phren?.args).toContain(phrenPath);
  });

  it("uses mcpServers key for fresh Copilot CLI config", () => {
    const copilotDir = path.join(homeDir, ".copilot");
    fs.mkdirSync(copilotDir, { recursive: true });

    const onStatus = configureCopilotMcp(phrenPath, { mcpEnabled: true });
    // First internal call installs, but the returned status is from the final call
    expect(["installed", "already_configured"]).toContain(onStatus);
    const mcpPath = path.join(copilotDir, "mcp-config.json");
    const onCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    expect(onCfg.mcpServers?.phren?.command).toBeDefined();
    expect(onCfg.mcpServers?.phren?.args).toContain(phrenPath);
  });

  it("throws on malformed JSON via patchJsonFile (tested through configureClaude)", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, "{ this is not valid json !!!");

    expect(() => configureClaude(phrenPath, { mcpEnabled: true })).toThrow("Malformed JSON");
  });

  it("rejects null JSON roots in provider config files", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, "null");

    expect(() => configureClaude(phrenPath, { mcpEnabled: true })).toThrow("top-level JSON value must be an object");
  });

  it("rejects array JSON roots in provider config files", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, "[]");

    expect(() => configureClaude(phrenPath, { mcpEnabled: true })).toThrow("top-level JSON value must be an object");
  });

  it("normalizes non-object hooks values before writing Claude hooks", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: [] }, null, 2));

    configureClaude(phrenPath, { mcpEnabled: true, hooksEnabled: true });

    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(Array.isArray(cfg.hooks)).toBe(false);
    expect(Array.isArray(cfg.hooks?.UserPromptSubmit)).toBe(true);
    expect(Array.isArray(cfg.hooks?.Stop)).toBe(true);
    expect(Array.isArray(cfg.hooks?.SessionStart)).toBe(true);
  });

  it("preserves non-phren hooks when configuring (isPhrenCommand filtering)", () => {
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

    configureClaude(phrenPath, { mcpEnabled: true, hooksEnabled: true });
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
            phren: { command: "npx", args: ["-y", "phren", "/old/path"] },
          },
        },
        null,
        2
      )
    );

    const offStatus = configureCodexMcp(phrenPath, { mcpEnabled: false });
    expect(offStatus).toBe("disabled");
    const offCfg = JSON.parse(fs.readFileSync(codexConfig, "utf8"));
    expect(offCfg.mcpServers?.phren).toBeUndefined();
    expect(Array.isArray(offCfg.hooks?.Stop)).toBe(true);

    const onStatus = configureCodexMcp(phrenPath, { mcpEnabled: true });
    expect(onStatus).toBe("installed");
    const onCfg = JSON.parse(fs.readFileSync(codexConfig, "utf8"));
    expect(onCfg.mcpServers?.phren?.command).toMatch(/^(node|npx)$/);
    expect(onCfg.mcpServers?.phren?.args).toContain(phrenPath);
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
  let tmpCleanup: () => void;
  const origActor = process.env.PHREN_ACTOR;

  beforeEach(() => {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-gov-test-"));
  });

  afterEach(() => {
    if (origActor === undefined) delete process.env.PHREN_ACTOR;
    else process.env.PHREN_ACTOR = origActor;
    tmpCleanup();
  });

  it("creates all governance files in a fresh directory", () => {
    ensureGovernanceFiles(tmpDir);
    const govDir = path.join(tmpDir, ".config");

    expect(fs.existsSync(path.join(govDir, "retention-policy.json"))).toBe(true);
    expect(fs.existsSync(path.join(govDir, "workflow-policy.json"))).toBe(true);
    expect(fs.existsSync(path.join(govDir, "index-policy.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".runtime", "runtime-health.json"))).toBe(true);
  });

  it("writes valid JSON in each governance file", () => {
    ensureGovernanceFiles(tmpDir);
    const govDir = path.join(tmpDir, ".config");

    const policy = JSON.parse(fs.readFileSync(path.join(govDir, "retention-policy.json"), "utf8"));
    expect(policy.ttlDays).toBe(120);
    expect(policy.retentionDays).toBe(365);

    const workflow = JSON.parse(fs.readFileSync(path.join(govDir, "workflow-policy.json"), "utf8"));
    expect(typeof workflow.lowConfidenceThreshold).toBe("number");

    const indexPol = JSON.parse(fs.readFileSync(path.join(govDir, "index-policy.json"), "utf8"));
    expect(Array.isArray(indexPol.includeGlobs)).toBe(true);
  });

  it("does not overwrite existing governance files", () => {
    const govDir = path.join(tmpDir, ".config");
    fs.mkdirSync(govDir, { recursive: true });
    const policyPath = path.join(govDir, "retention-policy.json");
    fs.writeFileSync(policyPath, JSON.stringify({ ttlDays: 999 }, null, 2) + "\n");

    ensureGovernanceFiles(tmpDir);

    const after = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    expect(after.ttlDays).toBe(999);
  });

});

describe("runInit walkthrough integration", () => {
  let tmpRoot: string;
  let homeDir: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPhrenPath = process.env.PHREN_PATH;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-walk-test-"));
    homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    resetVSCodeProbeCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    if (origPhrenPath) process.env.PHREN_PATH = origPhrenPath;
    else delete process.env.PHREN_PATH;
    tmpCleanup();
  });

  it("--yes skips walkthrough and uses defaults", async () => {
    const phrenPath = path.join(tmpRoot, "phren-yes");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true }));
    expect(fs.existsSync(phrenPath)).toBe(true);
    // Should have governance files created
    expect(fs.existsSync(path.join(phrenPath, ".config", "retention-policy.json"))).toBe(true);
  });

  it("fresh init starts empty and initializes a local git repo", async () => {
    const phrenPath = path.join(tmpRoot, "phren-empty");
    process.env.PHREN_PATH = phrenPath;

    await suppressOutput(() => runInit({ yes: true }));

    expect(fs.existsSync(path.join(phrenPath, "my-api"))).toBe(false);
    expect(fs.existsSync(path.join(phrenPath, "my-frontend"))).toBe(false);
    expect(fs.existsSync(path.join(phrenPath, "my-first-project"))).toBe(false);

    const defaultProfile = fs.readFileSync(path.join(phrenPath, "profiles", "default.yaml"), "utf8");
    expect(defaultProfile).toContain("- global");
    expect(defaultProfile).not.toContain("my-api");
    expect(defaultProfile).not.toContain("my-frontend");
    const envFile = fs.readFileSync(path.join(phrenPath, ".env"), "utf8");
    expect(envFile).toContain("PHREN_FEATURE_AUTO_CAPTURE=1");

    const insideWorkTree = execFileSync("git", ["-C", phrenPath, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    expect(insideWorkTree).toBe("true");
  });

  it("fresh init writes detached ownership as the clean-install default", async () => {
    const phrenPath = path.join(tmpRoot, "phren-clean-defaults");
    process.env.PHREN_PATH = phrenPath;

    await suppressOutput(() => runInit({ yes: true }));

    const installPrefs = JSON.parse(fs.readFileSync(path.join(phrenPath, ".runtime", "install-preferences.json"), "utf8"));
    expect(installPrefs.projectOwnershipDefault).toBe("detached");
    expect(installPrefs.skillsScope).toBe("global");
  });

  it("fresh init creates generated skill assets for first-run agent discovery", async () => {
    const phrenPath = path.join(tmpRoot, "phren-generated-assets");
    process.env.PHREN_PATH = phrenPath;

    await suppressOutput(() => runInit({ yes: true }));

    expect(fs.existsSync(path.join(phrenPath, "phren.SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".claude", "skill-manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".claude", "skill-commands.json"))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude", "skill-manifest.json"), "utf8"));
    expect(manifest.scope).toBe("global");
  });

  it("update flow removes legacy sample projects and recreates generated assets", async () => {
    const phrenPath = path.join(tmpRoot, "phren-repair-existing");
    process.env.PHREN_PATH = phrenPath;
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "global"), { recursive: true });
    fs.writeFileSync(path.join(phrenPath, "machines.yaml"), `${os.hostname()}: default\n`);
    fs.writeFileSync(
      path.join(phrenPath, "profiles", "default.yaml"),
      [
        "name: default",
        "description: Default profile",
        "projects:",
        "  - global",
        "  - my-api",
        "  - my-frontend",
        "  - real-project",
        "",
      ].join("\n"),
    );

    await suppressOutput(() => runInit({ yes: true }));

    const profileText = fs.readFileSync(path.join(phrenPath, "profiles", "default.yaml"), "utf8");
    expect(profileText).not.toContain("my-api");
    expect(profileText).not.toContain("my-frontend");
    expect(profileText).toContain("real-project");
    expect(fs.existsSync(path.join(phrenPath, ".runtime"))).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, ".config"))).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, ".sessions"))).toBe(true);
    // canonical-locks.json removed (canonical locks feature was stripped)
    expect(fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, "global", "skills", "audit.md"))).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, "phren.SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(phrenPath, ".env"), "utf8")).toContain("PHREN_FEATURE_AUTO_CAPTURE=1");
    expect(fs.existsSync(path.join(homeDir, ".claude", "skill-manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".claude", "skill-commands.json"))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, ".phren-context.md"))).toBe(true);
    const memoryFile = path.join(
      homeDir,
      ".claude",
      "projects",
      homeDir.replace(/[/\\:]/g, "-").replace(/^-/, ""),
      "memory",
      "MEMORY.md",
    );
    expect(fs.existsSync(memoryFile)).toBe(true);
  });

  it("update flow preserves explicit auto-capture opt-out in existing .env", async () => {
    const phrenPath = path.join(tmpRoot, "phren-repair-existing-explicit-off");
    process.env.PHREN_PATH = phrenPath;
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "global"), { recursive: true });
    fs.writeFileSync(path.join(phrenPath, "machines.yaml"), `${os.hostname()}: default\n`);
    fs.writeFileSync(
      path.join(phrenPath, "profiles", "default.yaml"),
      "name: default\ndescription: Default profile\nprojects:\n  - global\n",
    );
    fs.writeFileSync(path.join(phrenPath, ".env"), "PHREN_FEATURE_AUTO_CAPTURE=0\n");

    await suppressOutput(() => runInit({ yes: true }));

    const envFile = fs.readFileSync(path.join(phrenPath, ".env"), "utf8");
    expect(envFile).toContain("PHREN_FEATURE_AUTO_CAPTURE=0");
    expect(envFile).not.toContain("PHREN_FEATURE_AUTO_CAPTURE=1");
  });

  it("repair flow targets active agent home when HOME and USERPROFILE differ", async () => {
    const phrenPath = path.join(tmpRoot, "phren-repair-devcontainer");
    const fakeHome = path.join(tmpRoot, "fake-home");
    const actualAgentHome = path.join(tmpRoot, "agent-home");
    process.env.PHREN_PATH = phrenPath;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = actualAgentHome;
    fs.mkdirSync(path.join(actualAgentHome, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "global"), { recursive: true });
    fs.writeFileSync(path.join(phrenPath, "machines.yaml"), `${os.hostname()}: default\n`);
    fs.writeFileSync(
      path.join(phrenPath, "profiles", "default.yaml"),
      "name: default\ndescription: Default profile\nprojects:\n  - global\n",
    );

    await suppressOutput(() => runInit({ yes: true }));

    expect(fs.existsSync(path.join(actualAgentHome, ".phren-context.md"))).toBe(true);
    expect(fs.existsSync(path.join(fakeHome, ".phren-context.md"))).toBe(false);
    const memoryFile = path.join(
      actualAgentHome,
      ".claude",
      "projects",
      actualAgentHome.replace(/[/\\:]/g, "-").replace(/^-/, ""),
      "memory",
      "MEMORY.md",
    );
    expect(fs.existsSync(memoryFile)).toBe(true);
    expect(fs.existsSync(path.join(actualAgentHome, ".claude", "skill-manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(actualAgentHome, ".claude", "skill-commands.json"))).toBe(true);
    expect(fs.existsSync(path.join(fakeHome, ".claude", "skill-manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(fakeHome, ".claude", "skill-commands.json"))).toBe(false);
  });

  it("init output explains next steps without a restart step", async () => {
    const phrenPath = path.join(tmpRoot, "phren-restart-msg");
    process.env.PHREN_PATH = phrenPath;
    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => { chunks.push(String(chunk)); return true; }) as any;
    try {
      await runInit({ yes: true });
    } finally {
      process.stdout.write = origWrite;
    }
    const output = chunks.join("");
    expect(output).toContain("Start a new Claude session");
    expect(output).toContain("Next steps:");
    expect(output).not.toContain("Restart your agent");
  });

  it("walkthrough project name seeds the requested starter project only", async () => {
    const phrenPath = path.join(tmpRoot, "phren-rename");
    process.env.PHREN_PATH = phrenPath;
    const opts: any = { yes: true, _walkthroughProject: "my-app" };
    opts.yes = true;
    await suppressOutput(() => runInit(opts));

    expect(fs.existsSync(phrenPath)).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, "my-app", "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(phrenPath, "my-first-project"))).toBe(false);
  });

  it("walkthrough auto-capture opt-out writes explicit default to .env", async () => {
    const phrenPath = path.join(tmpRoot, "phren-walkthrough-autocapture-off");
    process.env.PHREN_PATH = phrenPath;

    await suppressOutput(() => runInit({ yes: true, _walkthroughAutoCapture: false }));

    const envFile = fs.readFileSync(path.join(phrenPath, ".env"), "utf8");
    expect(envFile).toContain("PHREN_FEATURE_AUTO_CAPTURE=0");
    expect(envFile).not.toContain("PHREN_FEATURE_AUTO_CAPTURE=1");
  });

  it("per-project storage writes repo bindings and initializes .phren in the repo root", async () => {
    const repoRoot = path.join(tmpRoot, "repo-storage");
    const phrenPath = path.join(repoRoot, ".phren");
    const origCwd = process.cwd();
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    process.chdir(repoRoot);

    try {
      await suppressOutput(() => runInit({
        yes: true,
        _walkthroughStorageChoice: "project",
        _walkthroughStoragePath: phrenPath,
        _walkthroughStorageRepoRoot: repoRoot,
      }));
    } finally {
      process.chdir(origCwd);
    }

    expect(fs.existsSync(path.join(phrenPath, "phren.root.yaml"))).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8")).toContain(".phren/");
    expect(fs.readFileSync(path.join(repoRoot, ".env"), "utf8")).toContain(`PHREN_PATH=${phrenPath}`);
  });

  it("persists onboarding defaults for ownership, proactivity, and task mode", async () => {
    const phrenPath = path.join(tmpRoot, "phren-onboarding-defaults");
    process.env.PHREN_PATH = phrenPath;

    await suppressOutput(() => runInit({
      yes: true,
      projectOwnershipDefault: "detached",
      findingsProactivity: "medium",
      taskProactivity: "low",
      taskMode: "suggest",
    }));

    const installPrefs = JSON.parse(fs.readFileSync(path.join(phrenPath, ".runtime", "install-preferences.json"), "utf8"));
    const governancePrefs = JSON.parse(fs.readFileSync(path.join(phrenPath, ".config", "install-preferences.json"), "utf8"));
    const workflowPolicy = JSON.parse(fs.readFileSync(path.join(phrenPath, ".config", "workflow-policy.json"), "utf8"));

    expect(installPrefs.projectOwnershipDefault).toBe("detached");
    expect(installPrefs.proactivityFindings).toBe("medium");
    expect(installPrefs.proactivityTask).toBe("low");
    expect(governancePrefs.proactivityFindings).toBe("medium");
    expect(governancePrefs.proactivityTask).toBe("low");
    expect(workflowPolicy.taskMode).toBe("suggest");
  });

  it("honors a declined current-project enrollment from onboarding", async () => {
    const phrenPath = path.join(tmpRoot, "phren-skip-bootstrap");
    const repoDir = path.join(tmpRoot, "tracked-repo");
    const origCwd = process.cwd();
    process.env.PHREN_PATH = phrenPath;
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    process.chdir(repoDir);
    try {
      await suppressOutput(() => runInit({
        yes: true,
        _walkthroughBootstrapCurrentProject: false,
      }));
    } finally {
      process.chdir(origCwd);
    }

    expect(fs.existsSync(path.join(phrenPath, "tracked-repo"))).toBe(false);
  });
});

describe("warmSemanticSearch", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("phren-semantic-warmup-");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("warms embeddings during init and reports warm/cold coverage", async () => {
    const ollama = await import("./shared/ollama.js");
    const index = await import("./shared/index.js");
    const embeddingCache = await import("./shared/embedding-cache.js");
    const startup = await import("./startup-embedding.js");
    const vectorIndex = await import("./shared/vector-index.js");

    vi.spyOn(ollama, "getOllamaUrl").mockReturnValue("http://localhost:11434");
    vi.spyOn(ollama, "getEmbeddingModel").mockReturnValue("nomic-embed-text");
    vi.spyOn(ollama, "checkOllamaAvailable").mockResolvedValue(true);
    vi.spyOn(ollama, "checkModelAvailable").mockResolvedValue(true);

    const fakeDb = {
      run: () => {},
      exec: () => [],
      export: () => new Uint8Array(),
      close: vi.fn(),
    };
    vi.spyOn(index, "buildIndex").mockResolvedValue(fakeDb as any);
    vi.spyOn(index, "listIndexedDocumentPaths").mockReturnValue(["/a.md", "/b.md", "/c.md"]);

    const cache = {
      load: vi.fn().mockResolvedValue(undefined),
      coverage: vi.fn()
        .mockReturnValueOnce({ total: 3, embedded: 1, missing: 2, pct: 33, missingPct: 67, state: "warming" })
        .mockReturnValueOnce({ total: 3, embedded: 3, missing: 0, pct: 100, missingPct: 0, state: "warm" }),
      size: vi.fn().mockReturnValue(3),
      getAllEntries: vi.fn().mockReturnValue([
        { path: "/a.md", model: "nomic-embed-text", vec: [0.1] },
        { path: "/b.md", model: "nomic-embed-text", vec: [0.2] },
        { path: "/c.md", model: "nomic-embed-text", vec: [0.3] },
      ]),
    };
    vi.spyOn(embeddingCache, "getEmbeddingCache").mockReturnValue(cache as any);
    vi.spyOn(startup, "backgroundEmbedMissingDocs").mockResolvedValue(2);

    const ensure = vi.fn();
    vi.spyOn(vectorIndex, "getPersistentVectorIndex").mockReturnValue({ ensure } as any);

    const message = await warmSemanticSearch(tmp.path, "personal");

    expect(message).toContain("Semantic search warmed");
    expect(message).toContain("nomic-embed-text");
    expect(message).toContain("3/3 docs embedded (100% warm, 0% cold)");
    expect(message).toContain("embedded 2 new docs during init");
    expect(startup.backgroundEmbedMissingDocs).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenCalledOnce();
    expect(fakeDb.close).toHaveBeenCalledOnce();
  });
});

describe("collectNativeMemoryFiles", () => {
  let tmpRoot: string;
  const origHome = process.env.HOME;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-native-mem-"));
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    tmpCleanup();
  });

  it("returns empty when no claude projects dir exists", () => {
    const result = collectNativeMemoryFiles();
    expect(result).toEqual([]);
  });

  it("finds MEMORY-project.md files and derives project names", () => {
    const memDir = path.join(tmpRoot, ".claude", "projects", "-home-user", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY-myapp.md"), "# myapp notes");
    fs.writeFileSync(path.join(memDir, "MEMORY-backend.md"), "# backend notes");

    const result = collectNativeMemoryFiles();
    expect(result.length).toBe(2);
    const names = result.map(r => r.project).sort();
    expect(names).toEqual(["backend", "myapp"]);
  });

  it("skips root MEMORY.md to avoid duplicating phren-managed content", () => {
    const memDir = path.join(tmpRoot, ".claude", "projects", "-home-user", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# root memory");
    fs.writeFileSync(path.join(memDir, "MEMORY-custom.md"), "# custom notes");

    const result = collectNativeMemoryFiles();
    expect(result.length).toBe(1);
    expect(result[0].project).toBe("custom");
  });

  it("skips non-md files", () => {
    const memDir = path.join(tmpRoot, ".claude", "projects", "-home-user", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "notes.txt"), "not markdown");
    fs.writeFileSync(path.join(memDir, "MEMORY-valid.md"), "# valid");

    const result = collectNativeMemoryFiles();
    expect(result.length).toBe(1);
    expect(result[0].project).toBe("valid");
  });
});

describe("runPostInitVerify", () => {
  it("reports setup hardening checks for git, node, remote, and config writability", () => {
    const { path: tmpDir, cleanup } = makeTempDir("phren-verify-test-");
    const home = path.join(tmpDir, "home");
    const phren = path.join(tmpDir, "phren");
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(phren, "global"), { recursive: true });
      fs.mkdirSync(path.join(phren, ".config"), { recursive: true });
      fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: {} }, null, 2));
      fs.writeFileSync(path.join(phren, "global", "CLAUDE.md"), "# Global\n");

      const result = runPostInitVerify(phren);
      const names = result.checks.map((check) => check.name);
      expect(names).toContain("git-installed");
      expect(names).toContain("node-version");
      expect(names).toContain("git-remote");
      expect(names).toContain("config-writable");
      expect(names).toContain("installed-version");
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      cleanup();
    }
  });

  it("accepts npx fallback when local hook entrypoint is not built", () => {
    const hookCheck = getHookEntrypointCheck({
      pathExists: () => false,
      versionReader: (cmd, args = ["--version"]) => {
        expect(cmd).toBe("npx");
        expect(args).toEqual(["--version"]);
        return "10.0.0";
      },
    });

    expect(hookCheck.ok).toBe(true);
    expect(hookCheck.detail).toContain("npx fallback");
  });

  it("flags install metadata drift when installedVersion does not match runtime", () => {
    const { path: tmpDir, cleanup } = makeTempDir("phren-verify-version-test-");
    const home = path.join(tmpDir, "home");
    const phren = path.join(tmpDir, "phren");
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(phren, "global"), { recursive: true });
      fs.mkdirSync(path.join(phren, ".config"), { recursive: true });
      fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: {} }, null, 2));
      fs.writeFileSync(path.join(phren, "global", "CLAUDE.md"), "# Global\n");
      fs.writeFileSync(
        path.join(phren, ".runtime", "install-preferences.json"),
        JSON.stringify({ installedVersion: "0.0.0-fake" }, null, 2)
      );

      const result = runPostInitVerify(phren);
      const versionCheck = result.checks.find((check) => check.name === "installed-version");
      expect(versionCheck?.ok).toBe(false);
      expect(versionCheck?.detail).toContain("runtime");
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      cleanup();
    }
  });

  it("explains hooks-only or local-only verify failures without hiding them", () => {
    const { path: tmpDir, cleanup } = makeTempDir("phren-verify-mode-note-");
    const home = path.join(tmpDir, "home");
    const phren = path.join(tmpDir, "phren");
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(phren, "global"), { recursive: true });
      fs.mkdirSync(path.join(phren, ".config"), { recursive: true });
      fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "hook-prompt" }] }],
            Stop: [{ hooks: [{ command: "hook-stop" }] }],
            SessionStart: [{ hooks: [{ command: "hook-session-start" }] }],
          },
        }, null, 2)
      );
      fs.writeFileSync(path.join(phren, "global", "CLAUDE.md"), "# Global\n");
      fs.writeFileSync(
        path.join(phren, ".runtime", "install-preferences.json"),
        JSON.stringify({ mcpEnabled: false, hooksEnabled: true, installedVersion: VERSION }, null, 2)
      );
      fs.mkdirSync(path.join(phren, "demo"), { recursive: true });

      const result = runPostInitVerify(phren);
      const mcpCheck = result.checks.find((check) => check.name === "mcp-config");
      expect(mcpCheck?.ok).toBe(false);
      expect(mcpCheck?.detail).toContain("expected while MCP mode is OFF");
      expect(getVerifyOutcomeNote(phren, result.checks)).toContain("local-only / hooks-only mode");
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      cleanup();
    }
  });
});

describe("project templates", () => {
  it("listTemplates returns available template names", () => {
    const templates = listTemplates();
    expect(templates).toContain("python-project");
    expect(templates).toContain("monorepo");
    expect(templates).toContain("library");
    expect(templates).toContain("frontend");
  });

  it("runInit with --template applies template files to project", async () => {
    const { path: tmpDir, cleanup } = makeTempDir("phren-template-test-");
    const origHome = process.env.HOME;
    const origPhren = process.env.PHREN_PATH;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    process.env.PHREN_PATH = path.join(tmpDir, "phren");
    resetVSCodeProbeCache();

    try {
      await suppressOutput(() => runInit({ yes: true, template: "python-project" }));
      const phrenDir = path.join(tmpDir, "phren");
      const claudeMd = fs.readFileSync(path.join(phrenDir, "my-first-project", "CLAUDE.md"), "utf8");
      const profile = fs.readFileSync(path.join(phrenDir, "profiles", "default.yaml"), "utf8");
      expect(claudeMd).toContain("Python project");
      expect(claudeMd).toContain("pytest");
      expect(claudeMd).not.toContain("{{project}}");
      expect(profile).toContain("- my-first-project");
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origHome;
      if (origPhren) process.env.PHREN_PATH = origPhren;
      else delete process.env.PHREN_PATH;
      resetVSCodeProbeCache();
      cleanup();
    }
  });
});
