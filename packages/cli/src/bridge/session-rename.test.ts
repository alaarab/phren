import { describe, expect, it } from "vitest";
import { workspaceSnapshot } from "./herdr.js";
import type { PaneClient } from "./opencode-pane-server.js";
import type { Json } from "./protocol.js";
import { lastCustomTitle, lastIndexedName, renameLabel, renamePane, renameSession, type RenameDeps } from "./session-rename.js";
import type { ScreenRead, TerminalProvider } from "./terminal.js";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const EMPTY_COMPOSER = "  Some earlier output\n\n\x1b[2m❯ Try \"how do I log an error?\"\x1b[0m\n";

const pane = (id: string, extra: Json = {}): Json => ({ pane_id: id, tab_id: "w1:t1", workspace_id: "w1", terminal_id: `term_${id}`, ...extra });
const agentPane = (id: string, agent: string, status = "idle"): Json => pane(id, { agent, agent_status: status });

/** A terminal that records labels and typed prompts; `screen` is what a read returns. */
function fakeTerminal(screen = EMPTY_COMPOSER) {
  const log = { panes: [] as [string, string][], groups: [] as unknown[], typed: [] as string[], reads: [] as ScreenRead[] };
  const refuse = async () => { throw new Error("not used"); };
  const terminal: TerminalProvider = { kind: "fake", ping: async () => {}, snapshot: async () => ({}), listPanes: async () => [],
    processes: async () => ({ foregroundPids: [] }), sendKeys: refuse, create: refuse, startAgent: refuse, focusPane: refuse,
    readScreen: async (_server, _pane, read) => { log.reads.push(read); return screen; },
    prompt: async (_server, _pane, text) => { log.typed.push(text); },
    renamePane: async (_server, id, label) => { log.panes.push([id, label]); },
    groupAction: async (_server, operation, group, label) => { log.groups.push({ operation, ...group, label }); } };
  return { terminal, log };
}

interface Options { panes: Json[]; session?: string; screen?: string; claudeTitle?: () => string | undefined; codexIndex?: () => string | undefined;
  codex?: () => Promise<boolean | undefined>; opencode?: PaneClient; verifyMs?: number }

function setup(options: Options) {
  const { terminal, log } = fakeTerminal(options.screen);
  const deps: RenameDeps = {
    snapshot: async () => ({ tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }], panes: options.panes }),
    identity: async () => "session" in options ? options.session : SESSION,
    terminal: () => terminal,
    codexRename: async () => options.codex?.(),
    opencodeClient: () => options.opencode,
    claudeTitle: async () => options.claudeTitle?.(),
    codexIndexTitle: async () => options.codexIndex?.(),
    sleep: async () => {},
    verifyMs: options.verifyMs ?? 0,
  };
  const rename = (data: Json = {}) => renameSession("herdr", { workspaceId: "w1", tabId: "w1:t1", label: "Tide charts", ...data }, deps);
  return { rename, log };
}

describe("the rename label", () => {
  it("is trimmed, 1 to 80 characters, with no control characters", () => {
    expect(renameLabel.parse("  Tide charts  ")).toBe("Tide charts");
    expect(renameLabel.parse("x".repeat(80))).toHaveLength(80);
    for (const bad of ["", "   ", "x".repeat(81), "a\nb", "a\u0000b", "a\u007fb"]) expect(renameLabel.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("is refused before anything is touched", async () => {
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude")] });
    await expect(rename({ label: "bad\nlabel" })).rejects.toThrow();
    await expect(rename({ label: "" })).rejects.toThrow();
    await expect(rename({ tabId: undefined })).rejects.toThrow();
    expect(log.panes).toEqual([]);
    expect(log.typed).toEqual([]);
  });
});

describe("choosing the pane", () => {
  it("takes the named pane, else the tab's only agent pane, else its only pane", () => {
    const shell = pane("w1:p1"), claude = agentPane("w1:p2", "claude"), codex = agentPane("w1:p3", "codex");
    expect(renamePane([shell, claude], undefined)).toEqual({ pane: claude, renameTab: true });
    expect(renamePane([shell], undefined)).toEqual({ pane: shell, renameTab: true });
    // Named: the tab is renamed only when the pane is the tab's single agent, or the tab's single pane.
    expect(renamePane([shell, claude], "w1:p2")).toEqual({ pane: claude, renameTab: true });
    expect(renamePane([shell, claude, codex], "w1:p3")).toEqual({ pane: codex, renameTab: false });
    expect(renamePane([shell, claude], "w1:p1")).toEqual({ pane: shell, renameTab: false });
    expect(renamePane([shell], "w1:p1")).toEqual({ pane: shell, renameTab: true });
  });

  it("asks which pane when several agents or several plain panes could be meant", () => {
    expect(() => renamePane([agentPane("w1:p1", "claude"), agentPane("w1:p2", "codex")], undefined)).toThrow("Choose a pane to rename.");
    expect(() => renamePane([pane("w1:p1"), pane("w1:p2")], undefined)).toThrow("Choose a pane to rename.");
  });

  it("refuses a tab or pane that is gone", async () => {
    expect(() => renamePane([], undefined)).toThrow("The tab changed.");
    expect(() => renamePane([agentPane("w1:p1", "claude")], "w1:p9")).toThrow("The pane changed.");
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude")] });
    await expect(rename({ tabId: "w1:t9" })).rejects.toThrow("The tab changed.");
    await expect(rename({ workspaceId: "w9" })).rejects.toThrow("The tab changed.");
    expect(log.panes).toEqual([]);
  });
});

describe("terminal labels", () => {
  it("names the pane, and the tab when the pane is its only agent", async () => {
    const { rename, log } = setup({ panes: [pane("w1:p1"), agentPane("w1:p2", "gemini")] });
    const result = await rename();
    expect(log.panes).toEqual([["w1:p2", "Tide charts"]]);
    expect(log.groups).toEqual([{ operation: "rename", workspace: "w1", tab: "w1:t1", label: "Tide charts" }]);
    expect(result).toEqual({ ok: true, label: "Tide charts", pane: "w1:p2",
      native: { harness: "gemini", mechanism: "none", applied: false, reason: "This harness has no remote rename." } });
  });

  it("leaves the tab alone when the tab holds several agents", async () => {
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "gemini"), agentPane("w1:p2", "gemini")] });
    await rename({ paneId: "w1:p2" });
    expect(log.panes).toEqual([["w1:p2", "Tide charts"]]);
    expect(log.groups).toEqual([]);
  });

  it("reports a plain shell as labels only", async () => {
    const { rename } = setup({ panes: [pane("w1:p1")] });
    expect((await rename()).native).toMatchObject({ harness: "none", mechanism: "none", applied: false });
  });
});

describe("Claude Code", () => {
  it("types /rename and confirms it from the transcript's custom-title, idle or working", async () => {
    for (const status of ["idle", "done", "working"]) {
      let title: string | undefined;
      const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude", status)], claudeTitle: () => title });
      const pending = rename();
      title = "Tide charts";
      expect((await pending).native).toEqual({ harness: "claude", mechanism: "slash-command", applied: true });
      expect(log.typed).toEqual(["/rename Tide charts"]);
    }
  });

  it("reports a rename Claude did not record, without failing the request", async () => {
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude")], claudeTitle: () => "Old name" });
    const result = await rename();
    expect(result.ok).toBe(true);
    expect(result.native).toEqual({ harness: "claude", mechanism: "slash-command", applied: false, reason: "The harness did not confirm the new name." });
    expect(log.panes).toEqual([["w1:p1", "Tide charts"]]);
  });

  it("types nothing while the agent needs input, or over a draft or an open menu", async () => {
    for (const status of ["blocked", "waiting", "unknown"]) {
      const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude", status)] });
      const result = await rename();
      expect(result.native).toMatchObject({ harness: "claude", applied: false, reason: "The agent needs input in the terminal first." });
      expect(log.typed).toEqual([]);
      expect(log.panes).toEqual([["w1:p1", "Tide charts"]]);
    }
    for (const screen of ["❯ half a sentence I was typing\n", "no prompt here\n", " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n❯ \n"]) {
      const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude")], screen });
      expect((await rename()).native).toMatchObject({ applied: false, reason: expect.stringContaining("Not typed") });
      expect(log.typed).toEqual([]);
    }
  });

  it("skips the native step, and says why, when the session is not identified", async () => {
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "claude")], session: undefined });
    expect((await rename()).native).toMatchObject({ harness: "claude", applied: false, reason: "The session is not identified yet." });
    expect(log.typed).toEqual([]);
  });

  it("finds the custom-title in a transcript tail, the latest one winning", () => {
    const text = ['{"type":"user"}', '{"type":"custom-title","customTitle":"First","sessionId":"s"}', "not json custom-title",
      '{"type":"custom-title","customTitle":"Second","sessionId":"s"}', '{"type":"assistant"}'].join("\n");
    expect(lastCustomTitle(text)).toBe("Second");
    expect(lastCustomTitle('{"type":"user"}')).toBeUndefined();
  });
});

describe("Codex", () => {
  it("renames a pane on the Hook's app-server through thread/name/set, even while working", async () => {
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "codex", "working")], codex: async () => true });
    expect((await rename()).native).toEqual({ harness: "codex", mechanism: "app-server", applied: true });
    expect(log.typed).toEqual([]);
  });

  it("reports an app-server that refused, without falling back to typing", async () => {
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "codex")], codex: async () => { throw new Error("The Codex server is not reachable."); } });
    expect((await rename()).native).toEqual({ harness: "codex", mechanism: "app-server", applied: false, reason: "The Codex server is not reachable." });
    expect(log.typed).toEqual([]);
  });

  it("types /rename into a plain TUI and confirms it from session_index.jsonl", async () => {
    let name: string | undefined = "Older name";
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "codex")], codex: async () => undefined, codexIndex: () => name });
    const pending = rename();
    name = "Tide charts";
    expect((await pending).native).toEqual({ harness: "codex", mechanism: "slash-command", applied: true });
    expect(log.typed).toEqual(["/rename Tide charts"]);
  });

  it("does not type into a plain TUI that is working or has no confirmation", async () => {
    const working = setup({ panes: [agentPane("w1:p1", "codex", "working")], codex: async () => undefined });
    expect((await working.rename()).native).toEqual({ harness: "codex", mechanism: "slash-command", applied: false, reason: "The agent is working." });
    expect(working.log.typed).toEqual([]);
    const silent = setup({ panes: [agentPane("w1:p1", "codex")], codex: async () => undefined, codexIndex: () => undefined });
    expect((await silent.rename()).native).toMatchObject({ applied: false, reason: "The harness did not confirm the new name." });
  });

  it("reads the latest thread_name for a thread from the index", () => {
    const text = [`{"id":"${SESSION}","thread_name":"First","updated_at":"1"}`, '{"id":"other","thread_name":"Other","updated_at":"2"}',
      `{"id":"${SESSION}","thread_name":"Second","updated_at":"3"}`].join("\n");
    expect(lastIndexedName(text, SESSION)).toBe("Second");
    expect(lastIndexedName(text, "missing")).toBeUndefined();
  });
});

describe("OpenCode", () => {
  const client = (titles: { set: string[] }, answer?: string): PaneClient => ({ setTitle: async (_id: string, title: string) => { titles.set.push(title); return answer ?? title; },
    currentSession: async () => ({ id: "ses_root" }) } as unknown as PaneClient);

  it("sets the title through the pane's server", async () => {
    const titles = { set: [] as string[] };
    const { rename, log } = setup({ panes: [agentPane("w1:p1", "opencode")], opencode: client(titles) });
    expect((await rename()).native).toEqual({ harness: "opencode", mechanism: "opencode-api", applied: true });
    expect(titles.set).toEqual(["Tide charts"]);
    expect(log.typed).toEqual([]);
  });

  it("reports a title the server did not take, and a pane the Hook does not serve", async () => {
    const titles = { set: [] as string[] };
    const wrong = setup({ panes: [agentPane("w1:p1", "opencode")], opencode: client(titles, "Other") });
    expect((await wrong.rename()).native).toMatchObject({ mechanism: "opencode-api", applied: false, reason: "OpenCode did not confirm the new name." });
    const unserved = setup({ panes: [agentPane("w1:p1", "opencode")] });
    const result = await unserved.rename();
    expect(result.native).toMatchObject({ harness: "opencode", mechanism: "none", applied: false });
    expect(unserved.log.panes).toEqual([["w1:p1", "Tide charts"]]);
  });
});

describe("what the phone reads back", () => {
  it("adds the agent pane's label to its tab, absent until someone sets one", () => {
    const snapshot = (label?: string) => ({ workspaces: [{ workspace_id: "w1", label: "app" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "3" }],
      panes: [{ ...agentPane("w1:p1", "claude"), ...(label ? { label } : {}) }] });
    const tab = (label?: string) => (workspaceSnapshot(snapshot(label)).groups as Json[])[0].children as Json[];
    expect(tab("Tide charts")[0].paneLabel).toBe("Tide charts");
    expect(tab()[0].paneLabel).toBeUndefined();
  });
});
