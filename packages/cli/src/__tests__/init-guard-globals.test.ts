import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findConflictingGlobalWiring,
  assertNoGlobalWiringConflict,
  isLiveForeignPhrenRoot,
  phrenRootFromGlobalClaudeLink,
} from "../init/guard-globals.js";

function makeRealRoot(parent: string, name = "real-phren"): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "global"), { recursive: true });
  fs.writeFileSync(path.join(root, "phren.root.yaml"), "version: 1\n");
  fs.writeFileSync(path.join(root, "machines.yaml"), "");
  return root;
}

function writeWrapper(homeDir: string, defaultPhrenPath: string): string {
  const binDir = path.join(homeDir, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const isWindows = process.platform === "win32";
  const wrapperPath = path.join(binDir, isWindows ? "phren.cmd" : "phren");
  const content = isWindows
    ? [
        "@echo off",
        "rem PHREN_CLI_WRAPPER — managed by phren init; safe to delete",
        `if not defined PHREN_PATH set "PHREN_PATH=${defaultPhrenPath}"`,
        'node "C:\\tmp\\index.js" %*',
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        "# PHREN_CLI_WRAPPER — managed by phren init; safe to delete",
        "set -u",
        `PHREN_PATH="\${PHREN_PATH:-${defaultPhrenPath}}"`,
        "export PHREN_PATH",
        'exec node /tmp/index.js "$@"',
        "",
      ].join("\n");
  fs.writeFileSync(wrapperPath, content);
  return wrapperPath;
}

const wrapperLocationLabel = `~/.local/bin/${process.platform === "win32" ? "phren.cmd" : "phren"} wrapper`;

/** Point ~/.claude/CLAUDE.md at <phrenRoot>/global/CLAUDE.md, as init does. */
function linkClaudeMd(homeDir: string, phrenRoot: string): string {
  const src = path.join(phrenRoot, "global", "CLAUDE.md");
  fs.mkdirSync(path.dirname(src), { recursive: true });
  if (!fs.existsSync(src)) fs.writeFileSync(src, "# Global Context\n");
  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const dest = path.join(claudeDir, "CLAUDE.md");
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(src, dest);
  return dest;
}

function writeClaudeSettings(homeDir: string, phrenPathInWiring: string): string {
  const dir = path.join(homeDir, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `PHREN_PATH='${phrenPathInWiring}' '${homeDir}/.local/bin/phren' hook-prompt`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
        mcpServers: {
          phren: {
            command: "node",
            args: ["/tmp/index.js", phrenPathInWiring],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return settingsPath;
}

describe("init guard against repointing global wiring", () => {
  let tmp: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phren-guard-test-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns no conflicts when no wrapper or settings exist", () => {
    const conflicts = findConflictingGlobalWiring(makeRealRoot(tmp));
    expect(conflicts).toEqual([]);
  });

  it("returns no conflicts when existing wrapper points at the same root", () => {
    const realRoot = makeRealRoot(tmp);
    writeWrapper(tmp, realRoot);
    expect(findConflictingGlobalWiring(realRoot)).toEqual([]);
  });

  it("flags wrapper, mcpServers entry, and hook command when they reference a different valid root", () => {
    const realRoot = makeRealRoot(tmp, "real-phren");
    const newRoot = path.join(tmp, "new-phren");
    fs.mkdirSync(newRoot, { recursive: true });
    writeWrapper(tmp, realRoot);
    writeClaudeSettings(tmp, realRoot);

    const conflicts = findConflictingGlobalWiring(newRoot);
    const locations = conflicts.map((c) => c.location).sort();
    expect(locations).toEqual([
      "~/.claude/settings.json hooks.UserPromptSubmit",
      "~/.claude/settings.json mcpServers.phren",
      wrapperLocationLabel,
    ].sort());
    for (const c of conflicts) {
      expect(path.resolve(c.existingPath)).toBe(path.resolve(realRoot));
    }
  });

  it("does not flag wiring that points at a stale (missing or non-phren) path", () => {
    const stalePath = path.join(tmp, "ghost-phren");
    writeWrapper(tmp, stalePath);
    writeClaudeSettings(tmp, stalePath);
    const newRoot = makeRealRoot(tmp, "new-phren");
    expect(findConflictingGlobalWiring(newRoot)).toEqual([]);
  });

  it("ignores wrapper files that lack the PHREN_CLI_WRAPPER marker", () => {
    const realRoot = makeRealRoot(tmp);
    const binDir = path.join(tmp, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const wrapperName = process.platform === "win32" ? "phren.cmd" : "phren";
    fs.writeFileSync(path.join(binDir, wrapperName), "#!/bin/sh\necho not ours\n");
    expect(findConflictingGlobalWiring(path.join(tmp, "new-phren"))).toEqual([]);
    void realRoot; // ensure realRoot isn't garbage collected/unused warning
  });

  it("assertNoGlobalWiringConflict throws on conflict but is silenced by force", () => {
    const realRoot = makeRealRoot(tmp);
    const newRoot = path.join(tmp, "smoke");
    fs.mkdirSync(newRoot, { recursive: true });
    writeWrapper(tmp, realRoot);

    expect(() => assertNoGlobalWiringConflict(newRoot, false)).toThrow(/refusing to repoint/);
    expect(() => assertNoGlobalWiringConflict(newRoot, true)).not.toThrow();
  });

  // ── ~/.claude/CLAUDE.md ─────────────────────────────────────────────────
  //
  // The symlink is global wiring exactly like the wrapper is, and it was the
  // one piece the scan did not look at — so `phren init` with a throwaway
  // PHREN_PATH reported "no conflict" and then repointed the user's real
  // global context file at a temp directory.

  it("flags a CLAUDE.md symlink into a different live root", () => {
    const realRoot = makeRealRoot(tmp, "real-phren");
    const newRoot = path.join(tmp, "new-phren");
    fs.mkdirSync(newRoot, { recursive: true });
    linkClaudeMd(tmp, realRoot);

    const conflicts = findConflictingGlobalWiring(newRoot);
    expect(conflicts.map((c) => c.location)).toEqual(["~/.claude/CLAUDE.md symlink"]);
    expect(path.resolve(conflicts[0].existingPath)).toBe(path.resolve(realRoot));
  });

  it("does not flag a CLAUDE.md symlink into the root being installed", () => {
    const realRoot = makeRealRoot(tmp, "real-phren");
    linkClaudeMd(tmp, realRoot);
    expect(findConflictingGlobalWiring(realRoot)).toEqual([]);
  });

  it("does not flag a CLAUDE.md symlink into a root that no longer exists", () => {
    const ghost = path.join(tmp, "ghost-phren");
    fs.mkdirSync(path.join(ghost, "global"), { recursive: true });
    linkClaudeMd(tmp, ghost);
    fs.rmSync(ghost, { recursive: true, force: true });

    expect(findConflictingGlobalWiring(makeRealRoot(tmp, "new-phren"))).toEqual([]);
  });

  it("does not flag a regular ~/.claude/CLAUDE.md file", () => {
    makeRealRoot(tmp, "real-phren");
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# hand-written\n");

    expect(findConflictingGlobalWiring(path.join(tmp, "new-phren"))).toEqual([]);
  });

  it("does not flag a CLAUDE.md symlink into something that is not a phren store", () => {
    const dotfiles = path.join(tmp, "dotfiles");
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.writeFileSync(path.join(dotfiles, "CLAUDE.md"), "# mine\n");
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.symlinkSync(path.join(dotfiles, "CLAUDE.md"), path.join(claudeDir, "CLAUDE.md"));

    expect(findConflictingGlobalWiring(makeRealRoot(tmp, "new-phren"))).toEqual([]);
  });
});

// ── link-target helpers ──────────────────────────────────────────────────────

describe("phrenRootFromGlobalClaudeLink", () => {
  it("recovers the root from a <root>/global/CLAUDE.md target", () => {
    expect(phrenRootFromGlobalClaudeLink("/home/me/.phren/global/CLAUDE.md")).toBe(
      path.resolve("/home/me/.phren"),
    );
  });

  it("returns null for a target that is not a phren global file", () => {
    expect(phrenRootFromGlobalClaudeLink("/home/me/dotfiles/CLAUDE.md")).toBeNull();
    expect(phrenRootFromGlobalClaudeLink("/home/me/global/NOTES.md")).toBeNull();
    expect(phrenRootFromGlobalClaudeLink("/home/me/.phren/CLAUDE.md")).toBeNull();
  });
});

describe("isLiveForeignPhrenRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phren-foreign-root-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("is false for the root being installed", () => {
    const root = makeRealRoot(tmp);
    expect(isLiveForeignPhrenRoot(root, root)).toBe(false);
  });

  it("is true for a different root that still looks live", () => {
    const other = makeRealRoot(tmp, "other");
    expect(isLiveForeignPhrenRoot(other, path.join(tmp, "mine"))).toBe(true);
  });

  it("is false for a different path that no longer exists", () => {
    expect(isLiveForeignPhrenRoot(path.join(tmp, "gone"), path.join(tmp, "mine"))).toBe(false);
  });
});
