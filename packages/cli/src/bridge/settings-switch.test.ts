import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { codexServers, type CodexServerEntry } from "./codex-servers.js";
import { rpc, validateTarget } from "./herdr.js";
import type { Target } from "./protocol.js";
import { claudeFooterMode, SettingsSwitcher, settingsCapabilities } from "./settings-switch.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn() }));
let transcript = "";
vi.mock("./transcripts.js", async original => ({ ...await original<typeof import("./transcripts.js")>(), transcriptPath: vi.fn(async () => transcript) }));

const codex: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session: "s-codex" };
const claude: Target = { ...codex, source: "claude", session: "s-claude" };
const footers: Record<string, string> = { default: "⏸ manual mode on (shift+tab to cycle) · ← 1 agent", acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "⏸ plan mode on (shift+tab to cycle)", auto: "⏵⏵ auto mode on (shift+tab to cycle)", bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle)" };
const stdout = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } }) + "\n";

describe("claudeFooterMode", () => {
  it("reads the mode from the footer line, whatever trails it", () => {
    for (const [mode, line] of Object.entries(footers)) expect(claudeFooterMode(`some reply\n❯\n──\n  ${line}\n`)).toBe(mode);
    expect(claudeFooterMode("plan mode on is what I said\n❯\n")).toBeUndefined();
    expect(claudeFooterMode("❯\n")).toBeUndefined();
    expect(claudeFooterMode("Turn bypass permissions on and retry\n❯\n")).toBeUndefined();
  });
});

describe("settingsCapabilities", () => {
  it("describes what each pane can change", () => {
    expect(settingsCapabilities("codex", true)).toEqual({ permissionModes: ["supervised", "auto-edits", "auto", "full-access"], plan: true, fast: false });
    expect(settingsCapabilities("codex", false)).toEqual({ permissionModes: [], plan: false, fast: false });
    expect(settingsCapabilities("claude", false)).toEqual({ permissionModes: ["supervised", "auto-edits", "auto"], plan: true, fast: true });
    expect(settingsCapabilities("claude", false, true)?.permissionModes).toContain("full-access");
    expect(settingsCapabilities("opencode", false)).toBeUndefined();
  });
});

describe("settings route transaction", () => {
  let switcher: SettingsSwitcher, status: string, cycle: string[], modes: string[], screen: string, fastAnswer: (text: string) => string;
  const keys = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.send_keys").map(call => (call[2] as { keys: string[] }).keys);
  const prompts = () => vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.prompt").map(call => (call[2] as { text: string }).text);
  beforeEach(async () => {
    transcript = path.join(await mkdtemp(path.join(os.tmpdir(), "settings-")), "s-claude.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", permissionMode: "default", message: { role: "user", content: "hi" } }) + "\n");
    fastAnswer = text => `Fast mode ${text.endsWith("on") ? "ON" : "OFF"}`;
    status = "idle"; modes = ["default"]; screen = "";
    cycle = ["acceptEdits", "plan", "default"];
    switcher = new SettingsSwitcher(new AgentHooks(), 30);
    vi.mocked(validateTarget).mockReset().mockImplementation(async () => ({ terminal_id: "t1", agent_status: status }));
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method, params) => {
      if (method === "agent.send_keys" && (params?.keys as string[])[0] === "shift+tab") {
        modes.push(cycle[(cycle.indexOf(modes.at(-1)!) + 1) % cycle.length]);
        return {};
      }
      if (method === "agent.prompt") {
        const text = String(params?.text);
        if (text === "/plan") modes.push("plan");
        if (text.startsWith("/fast")) await appendFile(transcript, stdout(fastAnswer(text)));
        return {};
      }
      if (method === "agent.read") return { read: { text: `${screen}❯\n──\n  ${footers[modes.at(-1)!]}\n` } };
      throw Error(`Unexpected ${method}`);
    });
  });

  it("holds a Hook-run Codex pane's permission mode and plan for its next turn, merged, typing nothing, even while it works", async () => {
    status = "working";
    const entry = { id: "0123456789ab" } as CodexServerEntry;
    const forTarget = vi.spyOn(codexServers, "forTarget").mockReturnValue(entry);
    const hold = vi.spyOn(codexServers, "holdSettings").mockImplementation(() => {});
    try {
      expect(await switcher.switch(codex, { permissionMode: "auto", plan: true })).toEqual({ ok: true, permissionMode: "auto", plan: true, applies: "next-turn" });
      expect(hold).toHaveBeenCalledWith(entry, { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" }, collaborationMode: { mode: "plan" } });
      await switcher.switch(codex, { permissionMode: "full-access" });
      expect(hold).toHaveBeenLastCalledWith(entry, { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } });
      await expect(switcher.switch(codex, { fast: true })).rejects.toThrow("Fast mode is Claude's");
      await expect(switcher.switch(codex, {})).rejects.toThrow();
      expect(vi.mocked(rpc)).not.toHaveBeenCalled();
    } finally { forTarget.mockRestore(); hold.mockRestore(); }
  });

  it("refuses a hand-started Codex pane and other harnesses", async () => {
    vi.spyOn(codexServers, "forTarget").mockReturnValue(undefined);
    await expect(switcher.switch(codex, { plan: true })).rejects.toThrow("not supported");
    await expect(switcher.switch({ ...codex, source: "opencode" }, { plan: true })).rejects.toThrow("not supported");
    expect(vi.mocked(rpc)).not.toHaveBeenCalled();
  });

  it("presses Shift+Tab until the transcript shows the wanted mode, then stops", async () => {
    expect(await switcher.switch(claude, { permissionMode: "auto-edits" })).toEqual({ ok: true, permissionMode: "auto-edits", plan: false });
    expect(keys()).toEqual([["shift+tab"]]);
    cycle = ["acceptEdits", "plan", "auto", "default"];
    expect(await switcher.switch(claude, { permissionMode: "auto" })).toEqual({ ok: true, permissionMode: "auto", plan: false });
    expect(keys()).toHaveLength(3);
    // Leaving plan takes the next mode Claude offers (auto, in this cycle).
    await switcher.switch(claude, { plan: true });
    expect(await switcher.switch(claude, { plan: false })).toEqual({ ok: true, permissionMode: "auto", plan: false });
  });

  it("answers 422 when a full cycle never reaches the mode", async () => {
    await expect(switcher.switch(claude, { permissionMode: "auto" })).rejects.toMatchObject({ status: 422, message: "Claude doesn't offer that mode in this session." });
    expect(keys()).toHaveLength(3);
    await expect(switcher.switch(claude, { permissionMode: "full-access" })).rejects.toMatchObject({ status: 422 });
    expect(keys()).toHaveLength(3);
  });

  it("stops without typing further when the footer never changes", async () => {
    vi.mocked(rpc).mockImplementation(async (_server, method) => method === "agent.read" ? { read: { text: `❯\n  ${footers.default}\n` } } : {});
    await expect(switcher.switch(claude, { permissionMode: "auto-edits" })).rejects.toMatchObject({ status: 409 });
    expect(keys()).toHaveLength(1);
  });

  it("refuses to press keys when the footer cannot be read", async () => {
    vi.mocked(rpc).mockImplementation(async () => ({ read: { text: "❯\n" } }));
    await expect(switcher.switch(claude, { permissionMode: "auto-edits" })).rejects.toMatchObject({ status: 409 });
    expect(keys()).toEqual([]);
  });

  it("types /plan and /fast, verifying fast from Claude's transcript row", async () => {
    expect(await switcher.switch(claude, { plan: true })).toEqual({ ok: true, plan: true });
    expect(prompts()).toEqual(["/plan"]);
    expect(await switcher.switch(claude, { fast: true })).toMatchObject({ ok: true, fast: true, verified: true });
    fastAnswer = () => "Fast mode unavailable: Fast mode requires usage credits · /usage-credits to turn them on";
    await expect(switcher.switch(claude, { fast: true })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("requires usage credits") });
    fastAnswer = text => `Fast mode ${text.endsWith("on") ? "OFF" : "ON"}`;
    await expect(switcher.switch(claude, { fast: false })).rejects.toMatchObject({ status: 409 });
  });

  it("falls back to the screen for fast when no row arrives, and says it is unverified when nothing shows", async () => {
    fastAnswer = () => "";
    vi.mocked(rpc).mockImplementation(async (_server, method, params) => method === "agent.read" ? { read: { text: `${screen}❯\n  ${footers.default}\n` } }
      : (method === "agent.prompt" && (screen = `  ⎿  Fast mode ${String(params?.text).endsWith("on") ? "ON" : "OFF"}\n`), {}));
    expect(await switcher.switch(claude, { fast: true })).toMatchObject({ fast: true, verified: true });
    screen = "";
    vi.mocked(rpc).mockImplementation(async (_server, method) => method === "agent.read" ? { read: { text: `❯\n  ${footers.default}\n` } } : {});
    expect(await switcher.switch(claude, { fast: false })).toMatchObject({ fast: false, verified: false });
  });

  it("says nothing of the mode when a fast-only change cannot read the footer", async () => {
    vi.mocked(rpc).mockImplementation(async (_server, method, params) => {
      if (method === "agent.prompt") await appendFile(transcript, stdout("Fast mode ON"));
      return method === "agent.read" ? { read: { text: "❯\n" } } : {};
    });
    expect(await switcher.switch(claude, { fast: true })).toEqual({ ok: true, fast: true, verified: true });
    await expect(switcher.switch(claude, { fast: true, mode: "x" } as never)).rejects.toThrow();
  });

  it("reports the footer's state and offers full access once bypass shows", async () => {
    expect(await switcher.streamSettings(claude, "t1", false)).toEqual({ settings: { permissionModes: ["supervised", "auto-edits", "auto"], plan: true, fast: true },
      settingsState: { permissionMode: "supervised", plan: false }, permissionMode: "default", permissionModes: ["default", "acceptEdits", "plan", "auto"] });
    modes.push("plan");
    const fresh = new SettingsSwitcher(new AgentHooks(), 30);
    expect((await fresh.streamSettings(claude, "t1", false)).settingsState).toEqual({ plan: true });
    modes.push("bypassPermissions");
    const seen = await new SettingsSwitcher(new AgentHooks(), 30).streamSettings(claude, "t2", false);
    expect(seen.settings?.permissionModes).toContain("full-access");
    expect(seen.settingsState).toEqual({ permissionMode: "full-access", plan: false });
  });

  it("carries Claude's suggested next prompt from the same styled footer read, stamped with the read's time", async () => {
    const suggested = readFileSync(new URL("./fixtures/claude/2.1.284/next-suggestion-herdr.ansi", import.meta.url), "utf8");
    vi.mocked(rpc).mockImplementation(async (_server, method, params) => method === "agent.read" && params?.format === "ansi" ? { read: { text: suggested } } : {});
    const before = Date.now();
    const read = await switcher.streamSettings(claude, "t1", false);
    expect(read.suggestion?.text).toBe("merged 313 and 314");
    expect(read.suggestion?.readAt).toBeGreaterThanOrEqual(before);
    expect(read.settingsState).toEqual({ permissionMode: "auto", plan: false });
    expect(vi.mocked(rpc).mock.calls.filter(call => call[1] === "agent.read")).toHaveLength(1);
    expect(await switcher.streamSettings(codex, "t1", false)).not.toHaveProperty("suggestion");
  });

  it("refuses a busy Claude pane and never types into it", async () => {
    status = "working";
    await expect(switcher.switch(claude, { permissionMode: "auto-edits" })).rejects.toMatchObject({ status: 409 });
    expect(keys()).toEqual([]);
    expect(prompts()).toEqual([]);
  });
});
