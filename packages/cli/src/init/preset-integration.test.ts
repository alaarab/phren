import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir, suppressOutput } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import { runInit } from "./init.js";
import { repairPreexistingInstall } from "./setup.js";
import {
  readInstallPreferences,
  writeInstallPreferences,
  getHooksEnabledPreference,
} from "./preferences.js";
import { getProjectOwnershipDefault } from "../project-config.js";

describe.sequential("management preset init integration", () => {
  let tmpRoot: string;
  let homeDir: string;
  let cleanup: () => void;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  const origPhrenPath = process.env.PHREN_PATH;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup } = makeTempDir("phren-preset-int-"));
    homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    if (origPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = origPhrenPath;
    cleanup();
  });

  it("managed init symlinks global CLAUDE.md into ~/.claude", async () => {
    const phrenPath = path.join(tmpRoot, "managed");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));

    expect(readInstallPreferences(phrenPath).managementPreset).toBe("managed");
    const homeClaude = path.join(homeDir, ".claude", "CLAUDE.md");
    expect(fs.existsSync(homeClaude)).toBe(true);
    expect(fs.lstatSync(homeClaude).isSymbolicLink()).toBe(true);
  });

  it("assisted init does not write into ~/.claude but keeps hooks", async () => {
    const phrenPath = path.join(tmpRoot, "assisted");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "assisted" }));

    const prefs = readInstallPreferences(phrenPath);
    expect(prefs.managementPreset).toBe("assisted");
    // Store-internal file exists...
    expect(fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))).toBe(true);
    // ...but nothing is written into ~/.claude.
    expect(fs.existsSync(path.join(homeDir, ".claude", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, ".claude", "skill-manifest.json"))).toBe(false);
    // No CLI wrapper under the assisted preset.
    expect(fs.existsSync(path.join(homeDir, ".local", "bin", "phren"))).toBe(false);
    // Hooks remain enabled.
    expect(getHooksEnabledPreference(phrenPath)).toBe(true);
  });

  it("manual init disables hooks and writes automation opt-out flags", async () => {
    const phrenPath = path.join(tmpRoot, "manual");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "manual" }));

    expect(readInstallPreferences(phrenPath).managementPreset).toBe("manual");
    expect(getHooksEnabledPreference(phrenPath)).toBe(false);
    expect(fs.existsSync(path.join(homeDir, ".claude", "CLAUDE.md"))).toBe(false);

    const env = fs.readFileSync(path.join(phrenPath, ".env"), "utf8");
    expect(env).toMatch(/PHREN_FEATURE_AUTO_CAPTURE=0/);
    expect(env).toMatch(/PHREN_FEATURE_AUTO_EXTRACT=0/);
    expect(env).toMatch(/PHREN_FEATURE_DAILY_MAINTENANCE=0/);
  });

  it("assisted forces detached ownership even on the express fast-path", async () => {
    // express (without --yes) runs the walkthrough express path, which relocates
    // the store to ~/.phren and would otherwise default ownership to phren-managed.
    delete process.env.PHREN_PATH;
    await suppressOutput(() => runInit({ express: true, managementPreset: "assisted" }));
    const expressPhrenPath = path.join(homeDir, ".phren");
    expect(readInstallPreferences(expressPhrenPath).managementPreset).toBe("assisted");
    expect(getProjectOwnershipDefault(expressPhrenPath)).toBe("detached");
  });

  it("self-heal recreates the CLAUDE.md symlink under managed but not assisted", async () => {
    const phrenPath = path.join(tmpRoot, "selfheal");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));

    const homeClaude = path.join(homeDir, ".claude", "CLAUDE.md");
    expect(fs.existsSync(homeClaude)).toBe(true);

    // Managed: deleting the symlink and repairing brings it back.
    fs.unlinkSync(homeClaude);
    suppressOutput(() => repairPreexistingInstall(phrenPath));
    expect(fs.existsSync(homeClaude)).toBe(true);

    // Switch to assisted: repair must NOT recreate it.
    writeInstallPreferences(phrenPath, { managementPreset: "assisted" });
    fs.unlinkSync(homeClaude);
    suppressOutput(() => repairPreexistingInstall(phrenPath));
    expect(fs.existsSync(homeClaude)).toBe(false);
  });

  it("phren preset managed -> assisted tears down home symlink, and back restores it", async () => {
    const phrenPath = path.join(tmpRoot, "switch");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));
    const homeClaude = path.join(homeDir, ".claude", "CLAUDE.md");
    expect(fs.existsSync(homeClaude)).toBe(true);

    const { runPreset } = await import("./init-preset.js");

    // Downgrade to assisted removes the phren-owned home symlink.
    await suppressOutput(() => runPreset("assisted", { yes: true }));
    expect(readInstallPreferences(phrenPath).managementPreset).toBe("assisted");
    expect(fs.existsSync(homeClaude)).toBe(false);
    expect(getHooksEnabledPreference(phrenPath)).toBe(true); // hooks stay on

    // Upgrade back to managed re-creates it.
    await suppressOutput(() => runPreset("managed", { yes: true }));
    expect(readInstallPreferences(phrenPath).managementPreset).toBe("managed");
    expect(fs.existsSync(homeClaude)).toBe(true);
  });

  // ── ~/.claude/CLAUDE.md ownership ──────────────────────────────────────
  //
  // repairPreexistingInstall() runs on every SessionStart hook, from the web
  // UI, and from `phren doctor` — none of which go through
  // assertNoGlobalWiringConflict. So a phren process pointed at a throwaway
  // PHREN_PATH used to silently steal the user's real ~/.claude/CLAUDE.md and
  // repoint it into a temp directory that later disappears, leaving every
  // Claude session with no global context. The old ownership test —
  // `target.endsWith("global/CLAUDE.md")` — treated any live root's global
  // file as fair game.

  it("a throwaway store does not steal a CLAUDE.md symlink owned by a live store", async () => {
    const realStore = path.join(tmpRoot, "real-store");
    process.env.PHREN_PATH = realStore;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));

    const homeClaude = path.join(homeDir, ".claude", "CLAUDE.md");
    const realTarget = fs.realpathSync(homeClaude);
    expect(realTarget).toBe(fs.realpathSync(path.join(realStore, "global", "CLAUDE.md")));

    // A second, still-live store — a smoke test run, or phren's own web UI
    // pointed at a temp path — self-heals against the same $HOME.
    const throwaway = path.join(tmpRoot, "throwaway-store");
    process.env.PHREN_PATH = throwaway;
    await suppressOutput(() => runInit({ yes: true, force: true, managementPreset: "managed" }));
    suppressOutput(() => repairPreexistingInstall(throwaway));

    expect(fs.realpathSync(homeClaude)).toBe(realTarget);
  });

  it("still repairs a symlink into a store that no longer exists", async () => {
    const ghost = path.join(tmpRoot, "ghost-store");
    process.env.PHREN_PATH = ghost;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));

    const homeClaude = path.join(homeDir, ".claude", "CLAUDE.md");
    expect(fs.existsSync(homeClaude)).toBe(true);

    // The store goes away — `rm -rf /tmp/foo` — leaving a dangling link. That
    // is the case this repair exists for and it must still fire.
    fs.rmSync(ghost, { recursive: true, force: true });
    expect(fs.existsSync(homeClaude)).toBe(false); // dangling
    expect(fs.lstatSync(homeClaude).isSymbolicLink()).toBe(true);

    const live = path.join(tmpRoot, "live-store");
    process.env.PHREN_PATH = live;
    await suppressOutput(() => runInit({ yes: true, force: true, managementPreset: "managed" }));
    suppressOutput(() => repairPreexistingInstall(live));

    expect(fs.realpathSync(homeClaude)).toBe(fs.realpathSync(path.join(live, "global", "CLAUDE.md")));
  });

  it("never replaces a hand-written ~/.claude/CLAUDE.md", async () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const homeClaude = path.join(claudeDir, "CLAUDE.md");
    fs.writeFileSync(homeClaude, "# my own global context\n");

    const phrenPath = path.join(tmpRoot, "respects-file");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));
    suppressOutput(() => repairPreexistingInstall(phrenPath));

    expect(fs.lstatSync(homeClaude).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(homeClaude, "utf8")).toBe("# my own global context\n");
  });

  it("phren preset manual disables hooks", async () => {
    const phrenPath = path.join(tmpRoot, "switch-manual");
    process.env.PHREN_PATH = phrenPath;
    await suppressOutput(() => runInit({ yes: true, managementPreset: "managed" }));
    expect(getHooksEnabledPreference(phrenPath)).toBe(true);

    const { runPreset } = await import("./init-preset.js");
    await suppressOutput(() => runPreset("manual", { yes: true }));
    expect(readInstallPreferences(phrenPath).managementPreset).toBe("manual");
    expect(getHooksEnabledPreference(phrenPath)).toBe(false);
  });
});
