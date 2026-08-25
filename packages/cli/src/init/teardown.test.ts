import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir, suppressOutput } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import { removeGitExcludes, removePhrenHomeSymlinks, removePhrenWrappers } from "./teardown.js";

describe.sequential("teardown helpers", () => {
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
    fs.writeFileSync(excludePath, "node_modules/\n*.log\n# phren-managed\nCLAUDE.md\nAGENTS.md\n");

    removeGitExcludes(repo, ["CLAUDE.md", "AGENTS.md"]);

    const content = fs.readFileSync(excludePath, "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("*.log");
    expect(content).not.toContain("# phren-managed");
    expect(content).not.toContain("CLAUDE.md");
    expect(content).not.toContain("AGENTS.md");
  });

  it("removePhrenHomeSymlinks removes phren symlinks but never regular files", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const store = path.join(tmpRoot, "phren", "global");
    fs.mkdirSync(store, { recursive: true });
    const src = path.join(store, "CLAUDE.md");
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
});
