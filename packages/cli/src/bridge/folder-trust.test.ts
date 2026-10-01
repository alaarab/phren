import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeGlobalConfigFile, claudeProjectKey, codexTrustedText, ensureClaudeFolderTrusted, ensureCodexDirTrusted, ensureCopilotFolderTrusted, pretrustEnabled, pretrustFolder } from "./folder-trust.js";

describe("folder trust", () => {
  const temporary: string[] = [];
  afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

  /** A fake home with its own Claude and Codex config; never the developer's. */
  async function sandbox(): Promise<{ home: string; env: NodeJS.ProcessEnv; claudeFile: string; codexFile: string; project: string }> {
    const home = await realpath(await mkdtemp(path.join(tmpdir(), "phren-trust-"))); temporary.push(home);
    const project = path.join(home, "Projects", "demo");
    await mkdir(project, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "claude"), CODEX_HOME: path.join(home, "codex") };
    await mkdir(path.join(home, "claude"));
    return { home, env, project, claudeFile: path.join(home, "claude", ".claude.json"), codexFile: path.join(home, "codex", "config.toml") };
  }

  it("keys Claude's projects the way Claude does: forward slashes on Windows", () => {
    expect(claudeProjectKey("/home/me/repo", "linux")).toBe("/home/me/repo");
    expect(claudeProjectKey("/home/me/./repo", "linux")).toBe("/home/me/repo");
    expect(claudeProjectKey("C:\\Users\\me\\repo", "win32")).toBe("C:/Users/me/repo");
    expect(claudeProjectKey("C:\\Users\\me\\.\\repo\\", "win32")).toBe("C:/Users/me/repo/");
  });

  it("resolves Claude's config file the way Claude does", async () => {
    const { home, env } = await sandbox();
    expect(await claudeGlobalConfigFile(env)).toBe(path.join(home, "claude", ".claude.json"));
    expect(await claudeGlobalConfigFile({ HOME: home })).toBe(path.join(home, ".claude.json"));
    // A legacy .config.json in the config directory wins when it exists.
    await writeFile(path.join(home, "claude", ".config.json"), "{}");
    expect(await claudeGlobalConfigFile(env)).toBe(path.join(home, "claude", ".config.json"));
  });

  it("adds only hasTrustDialogAccepted for the one folder and keeps the rest of Claude's config", async () => {
    const { env, claudeFile, project } = await sandbox();
    const original = { numStartups: 7, oauthAccount: { emailAddress: "a@b.c" }, projects: {
      "/elsewhere": { allowedTools: ["Bash"], hasTrustDialogAccepted: false },
      [claudeProjectKey(project)]: { allowedTools: ["Read"], hasClaudeMdExternalIncludesApproved: false },
    } };
    await writeFile(claudeFile, JSON.stringify(original, null, 2), { mode: 0o600 });
    await chmod(claudeFile, 0o640);
    expect(await ensureClaudeFolderTrusted(project, env)).toBe("trusted");
    const written = JSON.parse(await readFile(claudeFile, "utf8"));
    expect(written).toEqual({ ...original, projects: { ...original.projects,
      [claudeProjectKey(project)]: { allowedTools: ["Read"], hasClaudeMdExternalIncludesApproved: false, hasTrustDialogAccepted: true } } });
    // Windows has no POSIX modes to keep.
    if (process.platform !== "win32") expect((await stat(claudeFile)).mode & 0o777).toBe(0o640);
    // Nothing left behind: no lock directory, no temporary file.
    expect((await readdir(path.dirname(claudeFile))).sort()).toEqual([".claude.json"]);
    expect(await ensureClaudeFolderTrusted(project, env)).toBe("already");
  });

  it("leaves a missing or unreadable Claude config alone", async () => {
    const { env, claudeFile, project } = await sandbox();
    expect(await ensureClaudeFolderTrusted(project, env)).toBe("skipped");
    expect(await stat(claudeFile).catch(() => undefined)).toBeUndefined();
    await writeFile(claudeFile, "{ not json");
    await expect(ensureClaudeFolderTrusted(project, env)).rejects.toThrow();
    expect(await readFile(claudeFile, "utf8")).toBe("{ not json");
  });

  it("writes through a symlinked Claude config to its target", async () => {
    const { home, env, claudeFile, project } = await sandbox();
    const target = path.join(home, "dotfiles-claude.json");
    await writeFile(target, JSON.stringify({ projects: {} }));
    await symlink(target, claudeFile);
    expect(await ensureClaudeFolderTrusted(project, env)).toBe("trusted");
    expect(JSON.parse(await readFile(target, "utf8")).projects[claudeProjectKey(project)]).toEqual({ hasTrustDialogAccepted: true });
    expect((await lstat(claudeFile)).isSymbolicLink()).toBe(true);
  });

  it("takes over Claude's config lock only when it is stale", async () => {
    const { env, claudeFile, project } = await sandbox();
    await writeFile(claudeFile, JSON.stringify({ projects: {} }));
    const lock = `${claudeFile}.lock`;
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await ensureClaudeFolderTrusted(project, env)).toBe("trusted");
    expect(await stat(lock).catch(() => undefined)).toBeUndefined();
    // A live lock (another Claude writing) is waited on, then given up on.
    await mkdir(lock);
    const other = path.join(project, "..", "other");
    await mkdir(other);
    await expect(ensureClaudeFolderTrusted(other, env)).rejects.toThrow(/held by another process/);
    expect(JSON.parse(await readFile(claudeFile, "utf8")).projects[claudeProjectKey(other)]).toBeUndefined();
  });

  it("writes a quoted trusted-project entry for a dotted Codex project directory", async () => {
    const { home, env, codexFile } = await sandbox();
    const dotted = path.join(home, "my.repo");
    expect(await ensureCodexDirTrusted(dotted, env)).toBe("trusted");
    const written = await readFile(codexFile, "utf8");
    expect(written).toBe(`[projects.${JSON.stringify(dotted)}]\ntrust_level = "trusted"\n`);
    expect(await ensureCodexDirTrusted(dotted, env)).toBe("already");
    expect(await readFile(codexFile, "utf8")).toBe(written);
  });

  it("edits Codex's config.toml minimally: appends a table, flips one line, keeps everything else", () => {
    const text = `# my settings\nmodel = "gpt-5"   # keep this comment\n\n[projects."/a"]\ntrust_level = "untrusted"\nother = 1\n\n[mcp_servers.x]\ncommand = "x"\n`;
    expect(codexTrustedText(text, "/a")).toBe(text.replace('trust_level = "untrusted"', 'trust_level = "trusted"'));
    expect(codexTrustedText(text, "/b")).toBe(`${text}\n[projects."/b"]\ntrust_level = "trusted"\n`);
    expect(codexTrustedText("model = \"x\"", "/b")).toBe(`model = "x"\n\n[projects."/b"]\ntrust_level = "trusted"\n`);
    expect(codexTrustedText(`[projects."/c"]\nfoo = 1\n`, "/c")).toBe(`[projects."/c"]\ntrust_level = "trusted"\nfoo = 1\n`);
    expect(codexTrustedText(`[projects."/a"]\ntrust_level = "trusted"\n`, "/a")).toBeUndefined();
    expect(codexTrustedText("", 'C:\\a "b"')).toBe(`[projects."C:\\\\a \\"b\\""]\ntrust_level = "trusted"\n`);
  });

  it("adds the folder to Copilot's trustedFolders once, keeping its other settings", async () => {
    const { home, env, project } = await sandbox();
    const copilotEnv = { ...env, COPILOT_HOME: path.join(home, "copilot") };
    const file = path.join(home, "copilot", "settings.json");
    // No settings yet: the file is created with just the list.
    expect(await pretrustFolder("copilot", project, "test", copilotEnv)).toBe("trusted");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ trustedFolders: [project] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await ensureCopilotFolderTrusted(project, copilotEnv)).toBe("already");
    // The owner's own settings and folders stay as they were.
    await writeFile(file, JSON.stringify({ hooks: { SessionStart: [] }, trustedFolders: ["/elsewhere"] }));
    expect(await ensureCopilotFolderTrusted(project, copilotEnv)).toBe("trusted");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hooks: { SessionStart: [] }, trustedFolders: ["/elsewhere", project] });
    // A file that is not a settings object is left alone, and the launch goes on.
    await writeFile(file, "// comments\n{}");
    await expect(ensureCopilotFolderTrusted(path.join(home, "Projects"), copilotEnv)).rejects.toThrow();
    expect(await pretrustFolder("copilot", path.join(home, "Projects"), "test", copilotEnv)).toBe("skipped");
    expect(await readFile(file, "utf8")).toBe("// comments\n{}");
  });

  it("refuses to touch an unreadable Codex config and says why", async () => {
    const { env, codexFile, project } = await sandbox();
    await mkdir(codexFile, { recursive: true });
    await expect(ensureCodexDirTrusted(project, env)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("trusts the folder for Claude and Codex only, by given and real path, and stays off when asked", async () => {
    const { home, env, claudeFile, codexFile, project } = await sandbox();
    await writeFile(claudeFile, JSON.stringify({ projects: {} }));
    const linked = path.join(home, "linked-demo");
    await symlink(project, linked);
    expect(await pretrustFolder("claude", linked, "test", env)).toBe("trusted");
    expect(Object.keys(JSON.parse(await readFile(claudeFile, "utf8")).projects).sort()).toEqual([linked, project].map(dir => claudeProjectKey(dir)).sort());
    expect(await pretrustFolder("claude", project, "test", env)).toBe("already");
    expect(await pretrustFolder("codex", project, "test", env)).toBe("trusted");
    expect(await readFile(codexFile, "utf8")).toBe(`[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
    // No trust screen to skip, no such folder, or a relative path: nothing is written.
    const other = path.join(home, "Projects", "other");
    await mkdir(other);
    expect(await pretrustFolder("opencode", other, "test", env)).toBe("skipped");
    expect(await pretrustFolder("claude", path.join(home, "missing"), "test", env)).toBe("skipped");
    expect(await pretrustFolder("claude", "Projects/other", "test", env)).toBe("skipped");
    // PHREN_PRETRUST=off turns it off.
    expect(pretrustEnabled({ PHREN_PRETRUST: "off" })).toBe(false);
    expect(pretrustEnabled({})).toBe(true);
    expect(await pretrustFolder("claude", other, "test", { ...env, PHREN_PRETRUST: "off" })).toBe("skipped");
    expect(await pretrustFolder("codex", other, "test", { ...env, PHREN_PRETRUST: "0" })).toBe("skipped");
    expect(JSON.parse(await readFile(claudeFile, "utf8")).projects[claudeProjectKey(other)]).toBeUndefined();
    expect(await readFile(codexFile, "utf8")).not.toContain(other);
    // A failure is logged, never thrown: the launch goes on.
    await writeFile(claudeFile, "not json");
    expect(await pretrustFolder("claude", other, "test", env)).toBe("skipped");
  });
});
