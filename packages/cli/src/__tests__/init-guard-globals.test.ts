import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findConflictingGlobalWiring,
  assertNoGlobalWiringConflict,
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
  const wrapperPath = path.join(binDir, "phren");
  const content = [
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
                  timeout: 3,
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
      "~/.local/bin/phren wrapper",
    ]);
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
    fs.writeFileSync(path.join(binDir, "phren"), "#!/bin/sh\necho not ours\n");
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
});
