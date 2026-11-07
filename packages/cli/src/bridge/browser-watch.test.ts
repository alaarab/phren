import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
import { readFile } from "node:fs/promises";
import { browserWatch, noteBrowserLaunch, paneBrowserWatch } from "./browser-watch.js";
afterEach(() => { vi.restoreAllMocks(); });
it("returns unknown immediately, coalesces probes and distinguishes absent from unreadable environments", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const read = vi.mocked(readFile);
  read.mockResolvedValueOnce("PATH=/bin\0");
  expect(browserWatch(991001)).toBe("unknown");
  expect(browserWatch(991001)).toBe("unknown");
  expect(read).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(browserWatch(991001)).toBe("off");
  read.mockResolvedValueOnce('PHREN_BROWSER_SOCKET=/b.sock\0PHREN_BROWSER_SESSION=p1\0NODE_OPTIONS=--require="/shim.cjs"\0');
  expect(browserWatch(991002)).toBe("unknown");
  await Promise.resolve();
  expect(browserWatch(991002)).toBe("on");
  read.mockRejectedValueOnce(new Error("EACCES"));
  expect(browserWatch(991003)).toBe("unknown");
  await Promise.resolve();
  expect(browserWatch(991003)).toBe("unknown");
  expect(browserWatch(undefined)).toBe("unknown");
});
it("reports launch evidence and leaves unsupported platforms unknown without spawning ps", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  noteBrowserLaunch([process.pid], { PHREN_BROWSER_SOCKET: "/b.sock", PHREN_BROWSER_SESSION: "p1", NODE_OPTIONS: "--require=/shim" });
  expect(browserWatch(process.pid)).toBe("on");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 30_000);
  expect(browserWatch(process.pid)).toBe("unknown");
  expect(browserWatch(991005)).toBe("unknown");
});

it("keeps launch evidence across identity fast paths and retires it on session replacement", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const pane = { pane_id: "p1", terminal_id: "term1", agent: "codex" };
  noteBrowserLaunch([process.pid], { PHREN_BROWSER_SOCKET: "/b.sock", PHREN_BROWSER_SESSION: "p1", NODE_OPTIONS: "--require=/shim" }, { server: "default", pane });
  expect(paneBrowserWatch("default", pane, "session1")).toBe("on");
  expect(paneBrowserWatch("default", pane, "session1")).toBe("on");
  expect(paneBrowserWatch("default", pane, "replacement")).toBe("unknown");
});
