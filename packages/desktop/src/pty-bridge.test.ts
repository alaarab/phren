import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { spawn } from "node-pty";
import { attachTerminal } from "./pty-bridge.js";
vi.mock("node-pty", () => ({ spawn: vi.fn(() => ({})) }));
vi.mock("node:child_process", async (original) => ({ ...await original<object>(), execFileSync: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<object>(), existsSync: () => false }));
afterEach(() => vi.clearAllMocks());
it.each(["tmux", "tmux-login"])("attaches the returned pane in its actual session/window on %s", (server) => {
  vi.mocked(execFileSync).mockReturnValue("$7:@19.%42\n");
  attachTerminal({ name: "Desk", local: true, server: "tmux" }, server, 100, 30, "p42");
  const socket = server === "tmux" ? [] : ["-L", "login"];
  expect(execFileSync).toHaveBeenCalledWith("tmux", [...socket, "display-message", "-p", "-t", "%42", "#{session_id}:#{window_id}.#{pane_id}"], expect.any(Object));
  expect(spawn).toHaveBeenCalledWith("tmux", [...socket, "attach-session", "-t", "$7", ";", "select-window", "-t", "$7:@19", ";", "select-pane", "-t", "$7:@19.%42"], expect.objectContaining({ cols: 100, rows: 30 }));
});
it("refuses a stale pane rather than attaching another session", () => {
  vi.mocked(execFileSync).mockReturnValue("$0:@0.%1\n");
  expect(() => attachTerminal({ name: "Desk", local: true, server: "tmux" }, "tmux", 100, 30, "p42")).toThrow("That pane is not open anymore");
  expect(spawn).not.toHaveBeenCalled();
});
