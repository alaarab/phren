import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, DEFAULTS, DEFAULTS_APP, loadKeyConfig } from "./keys-config.js";
// @ts-expect-error plain browser module without types
import { installKeys, matches, parseBinding, shadowedByPrefix } from "../ui/keys.js";

const palette = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("../ui/shell/palette.js", () => ({ registerCommand: palette.register, closePalette: vi.fn(), isPaletteOpen: () => false, openPalette: vi.fn() }));

let dir: string;
const saved = { herdr: process.env.HERDR_CONFIG, desktop: process.env.PHREN_DESKTOP_CONFIG };
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "desktop-keys-"));
  process.env.HERDR_CONFIG = path.join(dir, "herdr", "config.toml");
  process.env.PHREN_DESKTOP_CONFIG = path.join(dir, "phren", "desktop.toml");
  await mkdir(path.join(dir, "herdr")); await mkdir(path.join(dir, "phren"));
});
afterEach(async () => {
  process.env.HERDR_CONFIG = saved.herdr; process.env.PHREN_DESKTOP_CONFIG = saved.desktop;
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  palette.register.mockClear();
});

describe("loadKeyConfig", () => {
  it("uses Herdr's defaults when nothing is configured", async () => {
    const config = await loadKeyConfig();
    expect(config.bindings).toEqual(DEFAULTS);
    expect(config.bindings.prefix).toEqual(["ctrl+b"]);
    expect(config.errors).toEqual([]);
  });

  it("gives the direct [keys.app] shortcuts their defaults", async () => {
    const config = await loadKeyConfig();
    expect(config.appBindings).toEqual(DEFAULTS_APP);
    expect(config.appBindings.palette).toEqual(["cmd+k"]);
    expect(config.appBindings.open_file).toEqual(["cmd+p"]);
    expect(config.appBindings.session_1).toEqual([]);
    expect(config.appBindings.session_9).toEqual([]);
    expect(config.appBindings.sidebar).toEqual(["cmd+b"]);
    expect(config.appSources.palette).toBe("default");
  });

  it("layers Herdr's [keys] then desktop.toml, ignores Herdr-only actions, and unbinds with an empty string", async () => {
    await writeFile(process.env.HERDR_CONFIG!, `[keys]\nprefix = "ctrl+a"\ngoto = ["prefix+g", "ctrl+alt+g"]\nsplit_vertical = "prefix+bar"\nremove_worktree = "prefix+shift+w"\nzoom = "prefix+m"\n`);
    await writeFile(process.env.PHREN_DESKTOP_CONFIG!, `[keys]\nzoom = "prefix+shift+z"\nclose_pane = ""\n`);
    const { bindings, sources } = await loadKeyConfig();
    expect(bindings.prefix).toEqual(["ctrl+a"]);
    expect(bindings.goto).toEqual(["prefix+g", "ctrl+alt+g"]);
    expect(bindings.zoom).toEqual(["prefix+shift+z"]);
    expect(bindings.close_pane).toEqual([]);
    expect(bindings).not.toHaveProperty("remove_worktree");
    expect(bindings.split_vertical).toEqual(["prefix+bar"]);
    expect(sources).toMatchObject({ prefix: "herdr", goto: "herdr", zoom: "desktop", close_pane: "desktop", help: "default" });
  });

  it("layers [keys.app], Herdr first then desktop.toml, and unbinds with an empty string", async () => {
    await writeFile(process.env.HERDR_CONFIG!, `[keys.app]\npalette = "cmd+shift+p"\nterminal = "cmd+t"\n`);
    await writeFile(process.env.PHREN_DESKTOP_CONFIG!, `[keys.app]\nterminal = ""\n`);
    const { appBindings, appSources } = await loadKeyConfig();
    expect(appBindings.palette).toEqual(["cmd+shift+p"]);
    expect(appBindings.terminal).toEqual([]);
    expect(appBindings.sidebar).toEqual(["cmd+b"]);
    expect(appSources).toMatchObject({ palette: "herdr", terminal: "desktop", sidebar: "default" });
  });

  it("reports broken files and wrong values without losing the defaults", async () => {
    await writeFile(process.env.HERDR_CONFIG!, "[keys\nbroken");
    await writeFile(process.env.PHREN_DESKTOP_CONFIG!, `[keys]\ngoto = 3\n`);
    const config = await loadKeyConfig();
    expect(config.bindings.goto).toEqual(DEFAULTS.goto);
    expect(config.errors.join("\n")).toMatch(/config\.toml/);
    expect(config.errors.join("\n")).toMatch(/keys\.goto must be a string/);
  });
});

describe("key matching", () => {
  const ev = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) =>
    ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  it("reads Herdr's binding syntax", () => {
    expect(parseBinding("prefix+shift+t")).toMatchObject({ prefix: true, shift: true, key: "t" });
    expect(parseBinding("prefix+minus").key).toBe("-");
    expect(parseBinding("prefix+1..9").range).toEqual([1, 9]);
    expect(parseBinding("ctrl+alt+g")).toMatchObject({ prefix: false, ctrl: true, alt: true, key: "g" });
  });
  it("matches presses, including shifted letters, implied-shift punctuation and ranges", () => {
    expect(matches(parseBinding("ctrl+b"), ev("b", { ctrlKey: true }))).toBe(true);
    expect(matches(parseBinding("ctrl+b"), ev("b"))).toBe(false);
    expect(matches(parseBinding("prefix+shift+t"), ev("T", { shiftKey: true }))).toBe(true);
    expect(matches(parseBinding("prefix+t"), ev("T", { shiftKey: true }))).toBe(false);
    expect(matches(parseBinding("prefix+?"), ev("?", { shiftKey: true }))).toBe(true);
    expect(matches(parseBinding("prefix+1..9"), ev("4"))).toBe(4);
    expect(matches(parseBinding("prefix+1..9"), ev("0"))).toBe(false);
    expect(matches(parseBinding("prefix+tab"), ev("Tab"))).toBe(true);
  });
});

describe("account usage access", () => {
  it("has a configurable app default free of other bindings and Linux Unicode input", async () => {
    const config = await loadKeyConfig();
    expect(config.appBindings.usage).toEqual(["cmd+alt+u"]);
    expect(ACTIONS.find(a => a.action === "usage")).toMatchObject({ app: true, label: "Show account usage" });
    const physical = (text: string, mac: boolean) => {
      const spec = parseBinding(text);
      if (!mac && spec.cmd) { spec.cmd = false; spec.ctrl = true; }
      return spec;
    };
    for (const mac of [true, false]) {
      for (const usage of config.appBindings.usage) {
        expect(shadowedByPrefix(usage, config.bindings.prefix, mac)).toBe(false);
        const spec = physical(usage, mac);
        const competitors = [...Object.values(DEFAULTS).flat(), ...Object.entries(DEFAULTS_APP).filter(([action]) => action !== "usage").flatMap(([, binds]) => binds)];
        // Check every prefix tail too, since an active prefix takes precedence.
        for (const other of competitors) expect(spec).not.toEqual({ ...physical(other, mac), prefix: false });
        expect(spec).not.toEqual(physical("ctrl+shift+u", mac));
      }
    }
  });

  it("registers Show account usage with the configured shortcut in the palette", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: loadKeyConfig })));
    vi.stubGlobal("document", { createElement: () => ({}), head: { append() {} }, getElementById: () => ({ addEventListener() {} }) });
    vi.stubGlobal("window", { addEventListener() {} });
    await installKeys({});
    const command = palette.register.mock.calls.map(([cmd]) => cmd).find(cmd => cmd.title === "Show account usage");
    expect(command).toMatchObject({ id: "keys.usage", run: expect.any(Function) });
    expect(command.keys).toContain("U");
  });
});
