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
