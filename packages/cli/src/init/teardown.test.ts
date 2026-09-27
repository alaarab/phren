import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir, suppressOutput } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import { generatedRootMemoryPath, removeGeneratedHomeFiles, removeGitExcludes, removePhrenHomeSymlinks, removePhrenWrappers } from "./teardown.js";

describe("teardown helpers", () => {
  let tmpRoot: string;
  let homeDir: string;
  let cleanup: () => void;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup } = makeTempDir("phren-teardown-test-"));
    homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    cleanup();
  });

  it("removeGitExcludes strips the phren marker + entries but keeps user lines", () => {
    const repo = path.join(tmpRoot, "repo");
    const infoDir = path.join(repo, ".git", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, "exclude");
    fs.writeFileSync(excludePath, "node_modules/\n*.log\n# phren-managed\nAGENTS.md\nCLAUDE.md\n");

    removeGitExcludes(repo, ["AGENTS.md", "CLAUDE.md"]);

    const content = fs.readFileSync(excludePath, "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("*.log");
    expect(content).not.toContain("# phren-managed");
    expect(content).not.toContain("AGENTS.md");
    expect(content).not.toContain("CLAUDE.md");
  });

  it("removePhrenHomeSymlinks removes phren symlinks but never regular files", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const store = path.join(tmpRoot, "phren", "global");
    fs.mkdirSync(store, { recursive: true });
    const src = path.join(store, "AGENTS.md");
    fs.writeFileSync(src, "# global\n");

    // A phren-owned symlink...
    const link = path.join(claudeDir, "CLAUDE.md");
    fs.symlinkSync(src, link);
    // ...and a user-owned regular copilot-instructions file that must be kept.
    fs.mkdirSync(path.join(homeDir, ".github"), { recursive: true });
    const userFile = path.join(homeDir, ".github", "copilot-instructions.md");
    fs.writeFileSync(userFile, "my own instructions\n");

    suppressOutput(() => removePhrenHomeSymlinks());

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(userFile)).toBe(true);
    expect(fs.readFileSync(userFile, "utf8")).toContain("my own instructions");
  });

  it("removePhrenWrappers removes only phren-marked wrappers", () => {
    const binDir = path.join(homeDir, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const phrenWrapper = path.join(binDir, "phren");
    fs.writeFileSync(phrenWrapper, "#!/bin/sh\n# PHREN_PATH wrapper for phren\nexec node phren\n");
    const otherBin = path.join(binDir, "codex");
    fs.writeFileSync(otherBin, "#!/bin/sh\necho not phren\n");

    suppressOutput(() => removePhrenWrappers());

    expect(fs.existsSync(phrenWrapper)).toBe(false);
    expect(fs.existsSync(otherBin)).toBe(true);
  });

  it("removes generated blocks while preserving surrounding user notes byte for byte", () => {
    const context = path.join(homeDir, ".phren-context.md");
    const memory = generatedRootMemoryPath();
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    fs.writeFileSync(context, "my heading\n<!-- phren-managed -->\nold wiring\n<!-- phren-managed -->\nmy notes\n");
    fs.writeFileSync(memory, "custom intro\n<!-- phren:projects:start -->\nold projects\n<!-- phren:projects:end -->\nremember this\n");
    suppressOutput(() => removeGeneratedHomeFiles());
    expect(fs.readFileSync(context, "utf8")).toBe("my heading\n\nmy notes\n");
    expect(fs.readFileSync(memory, "utf8")).toBe("custom intro\n\nremember this\n");
  });

  it("deletes files containing only generated content, including the known root introduction", () => {
    const context = path.join(homeDir, ".phren-context.md");
    const memory = generatedRootMemoryPath();
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    fs.writeFileSync(context, "<!-- phren-managed -->\ncontext\n<!-- phren-managed -->\n");
    fs.writeFileSync(memory, "# Root Memory\n\n## Machine Context\nRead `~/.phren-context.md` for profile, active projects, and sync metadata.\n\n<!-- phren:projects:start -->\nprojects\n<!-- phren:projects:end -->\n");
    suppressOutput(() => removeGeneratedHomeFiles());
    expect(fs.existsSync(context)).toBe(false);
    expect(fs.existsSync(memory)).toBe(false);
  });

  it("leaves unmarked, incomplete and symlinked home files alone", () => {
    const context = path.join(homeDir, ".phren-context.md");
    const memory = generatedRootMemoryPath();
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    fs.writeFileSync(context, "my own machine context\n");
    fs.writeFileSync(memory, "<!-- phren:projects:start -->\nunfinished user edit\n");
    expect(removeGeneratedHomeFiles()).toEqual([]);
    expect(fs.readFileSync(context, "utf8")).toBe("my own machine context\n");
    expect(fs.readFileSync(memory, "utf8")).toContain("unfinished user edit");
    const target = path.join(tmpRoot, "user-context.md");
    fs.writeFileSync(target, "<!-- phren-managed -->\nuser's source\n<!-- phren-managed -->\n");
    fs.unlinkSync(context);
    fs.symlinkSync(target, context);
    expect(removeGeneratedHomeFiles()).toEqual([]);
    expect(fs.lstatSync(context).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("user's source");
  });

  it("removes the link-generated introduction without removing added notes", () => {
    const memory = generatedRootMemoryPath();
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    const introduction = "# Root Memory\n\n## Machine Context\nRead `~/.phren-context.md` for profile, active projects, last sync date.\n\n## Cross-Project Notes\n- Read a project's AGENTS.md before making changes.\n- Per-project memory files (MEMORY-{name}.md) have commands, versions, findings.\n\n";
    const projects = "<!-- phren:projects:start -->\nprojects\n<!-- phren:projects:end -->";
    fs.writeFileSync(memory, introduction + projects + "\n");
    suppressOutput(() => removeGeneratedHomeFiles());
    expect(fs.existsSync(memory)).toBe(false);
    fs.writeFileSync(memory, introduction + "Owner's cross-project note\n" + projects + "\nmore notes\n");
    suppressOutput(() => removeGeneratedHomeFiles());
    expect(fs.readFileSync(memory, "utf8")).toBe("Owner's cross-project note\n\nmore notes\n");
  });
});
