import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import { claudeFooterMode, PERMISSION_CYCLE, type PermissionModeName, PermissionModeSwitcher, permissionModes } from "./permission-mode.js";
import type { Target } from "./protocol.js";
import type { PaneRouteContext } from "./server-pane-routes.js";
import { paneRouteOnce } from "./server-pane-routes.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(), validateTarget: vi.fn() }));

const fixture = (name: string) => readFileSync(new URL(`./fixtures/claude/2.1.284/permission-mode-${name}-herdr.ansi`, import.meta.url), "utf8");

describe("claudeFooterMode", () => {
  it("reads each recorded 2.1.284 footer fixture", () => {
    expect(claudeFooterMode(fixture("default"))).toBe("default");
    expect(claudeFooterMode(fixture("accept-edits"))).toBe("acceptEdits");
    expect(claudeFooterMode(fixture("plan"))).toBe("plan");
    expect(claudeFooterMode(fixture("auto"))).toBe("auto");
  });

  it("ignores a mode word that is not the footer's start", () => {
    expect(claudeFooterMode("❯\nI will turn plan mode on and retry\n")).toBeUndefined();
    expect(claudeFooterMode("❯\n")).toBeUndefined();
  });
});

describe("permissionModes", () => {
  it("lists the standard cycle, adding bypass only when the session allows it", () => {
    expect(PERMISSION_CYCLE).toEqual(["default", "acceptEdits", "plan", "auto"]);
    expect(permissionModes(false)).toEqual(["default", "acceptEdits", "plan", "auto"]);
    expect(permissionModes(true)).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
  });
});

describe("permission-mode route", () => {
  const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "ses_claude1" };
  let switcher: PermissionModeSwitcher, status: string, mode: PermissionModeName, screen: string, cycle: PermissionModeName[], keys: string[][], restore: () => void;
  const readScreen = async () => screen;
  beforeEach(() => {
    status = "idle"; mode = "default"; cycle = ["default", "acceptEdits", "plan", "auto"]; keys = [];
    screen = fixture("default");
    switcher = new PermissionModeSwitcher(new AgentHooks(), 30);
    vi.mocked(validateTarget).mockReset().mockImplementation(async () => ({ terminal_id: "t1", agent_status: status }));
    restore = setTerminalProvider({ kind: "fake",
      sendKeys: async (_server, _pane, pressed) => {
        keys.push(pressed);
        mode = cycle[(cycle.indexOf(mode) + 1) % cycle.length];
        screen = fixture(mode === "acceptEdits" ? "accept-edits" : mode);
      },
      readScreen,
    } as unknown as TerminalProvider);
  });
  afterEach(() => restore());

  it("steps Shift+Tab until the wanted mode, then reports who chose it", async () => {
    expect(await switcher.set(target, "plan")).toEqual({ ok: true, permissionMode: "plan", setBy: "owner" });
    expect(keys).toEqual([["shift+tab"], ["shift+tab"]]);
  });

  it("returns at once, pressing nothing, when the footer already shows the mode", async () => {
    expect(await switcher.set(target, "default")).toEqual({ ok: true, permissionMode: "default", setBy: "owner" });
    expect(keys).toEqual([]);
  });

  it("refuses any mode chosen by an agent, bypass included, before touching the pane", async () => {
    const origin = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" };
    for (const mode of ["acceptEdits", "auto", "bypassPermissions"] as const) {
      await expect(switcher.set(target, mode, origin)).rejects.toMatchObject({ status: 403 });
    }
    // Even a malformed origin is an agent's call, not the owner's.
    await expect(switcher.set(target, "auto", {})).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a working pane and never presses into it", async () => {
    status = "working";
    await expect(switcher.set(target, "acceptEdits")).rejects.toMatchObject({ status: 409 });
    expect(keys).toEqual([]);
  });

  it("refuses while a permission prompt or dialog is open", async () => {
    status = "blocked";
    await expect(switcher.set(target, "acceptEdits")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("prompt or dialog") });
    status = "idle";
    screen = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
    await expect(switcher.set(target, "acceptEdits")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("prompt or dialog") });
    expect(keys).toEqual([]);
  });

  it("answers 422 after at most a full lap that never reaches the mode", async () => {
    await expect(switcher.set(target, "bypassPermissions")).rejects.toMatchObject({ status: 422 });
    expect(keys.length).toBe(PERMISSION_CYCLE.length + 1);
  });

  it("refuses a non-Claude harness", async () => {
    await expect(switcher.set({ ...target, source: "codex" }, "acceptEdits")).rejects.toMatchObject({ status: 422 });
    expect(keys).toEqual([]);
  });

  it("is reachable as POST /v1/agents/permission-mode with the pane in the body", async () => {
    const context = { agentHooks: new AgentHooks(), modelSwitcher: { assertAvailable() {} }, settingsSwitcher: { assertAvailable() {} },
      permissionModeSwitcher: switcher, sideQuestions: { assertAvailable() {} } } as unknown as PaneRouteContext;
    const url = new URL("http://phren.local/v1/agents/permission-mode");
    expect(await paneRouteOnce(context, url, { target, mode: "plan" }, {} as never, () => {})).toEqual({ ok: true, permissionMode: "plan", setBy: "owner" });
    await expect(paneRouteOnce(context, url, { target, mode: "turbo" }, {} as never, () => {})).rejects.toBeInstanceOf(Error);
    // An agent's call names its pane as origin: refused for every mode, bypass included, and no key is pressed.
    const origin = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" };
    const before = keys.length;
    for (const mode of ["auto", "bypassPermissions"]) {
      await expect(paneRouteOnce(context, url, { target, mode, origin }, {} as never, () => {})).rejects.toMatchObject({ status: 403 });
    }
    await expect(paneRouteOnce(context, url, { target, mode: "auto", origin: null }, {} as never, () => {})).rejects.toMatchObject({ status: 403 });
    expect(keys.length).toBe(before);
  });
});
