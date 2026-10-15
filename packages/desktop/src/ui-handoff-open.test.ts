import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  rows: [] as Array<{ computer: string; child: Record<string, unknown> }>,
  options: [] as unknown[],
  show: vi.fn(), open: vi.fn(),
}));
vi.mock("../ui/shell/store.js", () => ({ store: { sessions: (options: unknown) => { hooks.options.push(options); return hooks.rows; } } }));
vi.mock("../ui/shell/sections.js", () => ({
  showSection: hooks.show,
  sectionHandle: (id: string) => id === "agents" ? { openSession: hooks.open } : null,
}));
// @ts-expect-error plain browser ESM
import { openHandoffChat } from "../ui/shell/handoff-view.js";

const target = (pane: string, session = pane, source = "codex") => ({ server: "tmux", workspace: "work", tab: "one", pane, source, session });
afterEach(() => { hooks.rows = []; hooks.options = []; hooks.show.mockReset(); hooks.open.mockReset(); });

it("opens the destination only on the tag's own computer, by the exact Hook target", () => {
  const laptop = { id: "on-laptop", target: target("b") };
  const desk = { id: "on-desk", target: target("b") };
  const lookalike = { id: "same-pane-new-session", target: target("b", "other") };
  hooks.rows = [{ computer: "Laptop", child: laptop }, { computer: "Desk", child: lookalike }, { computer: "Desk", child: desk }];
  expect(openHandoffChat("Desk", target("b"))).toBe(true);
  expect(hooks.show).toHaveBeenCalledExactlyOnceWith("agents");
  expect(hooks.open).toHaveBeenCalledExactlyOnceWith("Desk", desk);
  // Rows from offline computers count too, as when the tag was drawn.
  expect(hooks.options).toEqual([{ includeOffline: true }]);
});

it("leaves the current section alone when the destination chat is gone", () => {
  hooks.rows = [{ computer: "Laptop", child: { id: "elsewhere", target: target("b") } }, { computer: "Desk", child: { id: "replaced", target: target("b", "new") } }];
  expect(openHandoffChat("Desk", target("b"))).toBe(false);
  expect(openHandoffChat("Desk", { ...target("b"), session: undefined })).toBe(false);
  expect(hooks.show).not.toHaveBeenCalled();
  expect(hooks.open).not.toHaveBeenCalled();
});
