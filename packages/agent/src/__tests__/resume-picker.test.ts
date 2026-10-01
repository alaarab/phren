import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createCommandContext } from "../commands.js";
import { resumeCommand } from "../commands/session.js";
import { createSession } from "../agent-loop/types.js";
import { SessionLog } from "../session/log.js";
import { fileSink } from "../session/persist.js";

function writeSession(root: string, id: string, prompt: string, extra: { project?: string; cwd?: string; ageMs?: number } = {}) {
  const log = new SessionLog({ sessionId: id, project: extra.project, cwd: extra.cwd ?? "/w", createdAt: new Date().toISOString() }, fileSink(root, id));
  log.append("user/message", { message: { role: "user", content: prompt }, source: "user", turn: 0 });
  log.append("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: `answer to ${prompt}` }] }, stop_reason: "end_turn", turn: 0 });
  if (extra.ageMs) {
    const when = new Date(Date.now() - extra.ageMs);
    fs.utimesSync(path.join(root, ".sessions", `session-${id}.events.jsonl`), when, when);
  }
}

describe("/resume", () => {
  let store: string;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), "resume-store-"));
    writeSession(store, "aaaa1111", "fix the login bug", { project: "app", ageMs: 60_000 });
    writeSession(store, "bbbb2222", "add a --json flag", { project: "app" });
    writeSession(store, "cccc3333", "other project", { project: "elsewhere" });
    stderr.mockClear();
  });
  afterEach(() => fs.rmSync(store, { recursive: true, force: true }));

  function ctx() {
    const c = createCommandContext(createSession(), 200_000);
    c.phrenPath = store;
    c.phrenCtx = { project: "app" } as never;
    return c;
  }
  const printed = () => stderr.mock.calls.map((c) => String(c[0])).join("");

  it("opens the picker with this project's sessions, newest first, and loads the one picked", async () => {
    const c = ctx();
    let offered: string[] = [];
    c.pickFromList = async (_title, items) => { offered = items.map((i) => i.label); return 1; };
    await resumeCommand(["/resume"], c);
    expect(offered).toEqual(["add a --json flag", "fix the login bug"]);
    expect(c.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.session.messages[0].content).toBe("fix the login bug");
  });

  it("does nothing when the picker is cancelled", async () => {
    const c = ctx();
    c.pickFromList = async () => null;
    await resumeCommand(["/resume"], c);
    expect(c.session.messages).toHaveLength(0);
  });

  it("takes a number or an id prefix, and lists the sessions without a picker", async () => {
    const byNumber = ctx();
    await resumeCommand(["/resume", "1"], byNumber);
    expect(byNumber.session.messages[0].content).toBe("add a --json flag");
    const byId = ctx();
    await resumeCommand(["/resume", "aaaa"], byId);
    expect(byId.session.messages[0].content).toBe("fix the login bug");
    const listed = ctx();
    await resumeCommand(["/resume"], listed);
    expect(listed.session.messages).toHaveLength(0);
    expect(printed()).toContain("1. add a --json flag");
    expect(printed()).not.toContain("other project");
  });

  it("refuses a session that already has history", async () => {
    const c = ctx();
    await resumeCommand(["/resume", "1"], c);
    await resumeCommand(["/resume", "2"], c);
    expect(c.session.messages).toHaveLength(2);
    expect(printed()).toContain("only works on a fresh session");
  });

  it("without a store, offers the sessions run in this directory from ~/.phren-agent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resume-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const root = path.join(home, ".phren-agent");
      writeSession(root, "dddd4444", "here", { cwd: process.cwd() });
      writeSession(root, "eeee5555", "somewhere else", { cwd: "/elsewhere" });
      const c = createCommandContext(createSession(), 200_000);
      let offered: string[] = [];
      c.pickFromList = async (_t, items) => { offered = items.map((i) => i.label); return 0; };
      await resumeCommand(["/resume"], c);
      expect(offered).toEqual(["here"]);
      expect(c.session.messages[0].content).toBe("here");
    } finally {
      process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
