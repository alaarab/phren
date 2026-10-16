import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { longTranscript, startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");
const originalBridgeHome = process.env.PHREN_BRIDGE_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
let linkedUi = false;
let dir: string;
let hook: FakeHook;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;

const overview = {
  type: "overview", kind: "overview",
  groups: [{ id: "1", label: "phren", children: [{
    id: "long", title: "Long chat", label: "phren", agent: "claude", agentStatus: "idle", lastReply: "Done.", cwd: "/Users/you/phren",
    target: { server: "default", workspace: "1", tab: "long", pane: "long", source: "claude", session: "long" },
  }] }],
  phren: { computer: { id: "test-computer", name: LOCAL.name }, version: "0.3.49",
    capabilities: { transcript: true, prompt: true, overviewStream: true } },
};

test.beforeEach(async ({ page }, testInfo) => {
  if (!existsSync(UI_LINK)) { symlinkSync(path.resolve(SPEC_DIR, "../ui"), UI_LINK, "dir"); linkedUi = true; }
  await mkdir(path.resolve(".scratch"), { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/desktop-outline-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  hook = await startFakeHook({ dir, overviewFrames: [overview], transcriptFrames: testInfo.title.includes("80 prompts") ? longTranscript(80, 2) : longTranscript(6) });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-outline-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
});

test.afterEach(async ({ page }) => {
  await page.close();
  hub?.stop();
  await closeServer?.();
  await hook?.close();
  await rm(dir, { recursive: true, force: true });
  if (originalBridgeHome === undefined) delete process.env.PHREN_BRIDGE_HOME;
  else process.env.PHREN_BRIDGE_HOME = originalBridgeHome;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

test.afterAll(() => {
  if (linkedUi) { try { unlinkSync(UI_LINK); } catch { /* already gone */ } }
});

async function openLongChat(page: Page, width: number, height: number, last = "Step 9 of answer 6") {
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Long chat" }).first().click();
  await expect(page.locator(".ct-column")).toContainText(last);
}

/** The prompt row (1-based) whose top edge is closest to the transcript's top, as its text. */
const topPrompt = (page: Page) => page.locator(".ct-scroll").evaluate((scroll) => {
  const top = scroll.getBoundingClientRect().top;
  const rows = [...scroll.querySelectorAll<HTMLElement>(".ct-user-row")];
  const inView = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > top && b.top < top + scroll.clientHeight; });
  return inView[0]?.textContent ?? "";
});

test("a long chat shows the prompt rail; clicking a tick scrolls that prompt in and highlights it; Alt+Up/Down step", async ({ page }) => {
  await openLongChat(page, 1280, 800);
  const rail = page.locator(".ct-outline");
  // Folded by default: 2 turns drawn, yet every loaded prompt has a tick (4 hollow ones in the top segment).
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("aria-label", "Prompts");
  await expect(page.locator(".ct-fold")).toBeVisible();
  const ticks = rail.locator(".ct-outline-tick");
  await expect(ticks).toHaveCount(6);
  await expect(rail.locator(".ct-outline-tick.folded")).toHaveCount(4);
  await expect(ticks.nth(0)).toHaveAttribute("aria-label", "Prompt 1: Fix the login flow");
  await expect(ticks.nth(2)).toHaveAttribute("aria-label", "Prompt 3: Cover the guard with tests");

  // Ticks sit in the order of their prompts, top to bottom; the folded ones stay in the top quarter of the rail.
  const tops = await ticks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  const railBox = (await page.locator(".ct-outline-track").boundingBox())!;
  expect(tops[3]).toBeLessThan(railBox.y + railBox.height * 0.3);

  // Hovering shows the first line only.
  await ticks.nth(2).hover();
  await expect(page.locator(".ct-outline-tip")).toHaveText("Cover the guard with tests");

  // A folded tick opens the fold and scrolls its prompt in.
  await ticks.nth(2).click();
  await expect(page.locator(".ct-fold")).toContainText("Hide earlier");
  const row3 = page.locator('.ct-user-row', { hasText: "Prompt 3" });
  await expect(row3).toBeInViewport();
  await expect(page.locator(".ct-outline-flash .ct-user-bubble")).toContainText("Cover the guard with tests");
  await expect(ticks.nth(2)).toHaveAttribute("aria-current", "true");
  await expect.poll(() => topPrompt(page)).toContain("Cover the guard with tests");

  // Alt+Up goes to prompt 2 (focus is in the transcript after the click on its tick's neighbour).
  await page.locator(".ct-scroll").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator('.ct-user-row', { hasText: "Rename the session module" })).toHaveCount(1);
  await expect.poll(() => topPrompt(page)).toContain("Add a retry to the token refresh");
  await expect(ticks.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => topPrompt(page)).toContain("Cover the guard with tests");

  // With no prompt that way the key is left alone (not prevented).
  await ticks.nth(0).click();
  await expect.poll(() => topPrompt(page)).toContain("Fix the login flow");
  const prevented = await page.locator(".ct-scroll").evaluate((s) => {
    const ev = new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true });
    s.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test("a jump lands while the reply streams, and following the bottom resumes once the reader is back there", async ({ page }) => {
  await openLongChat(page, 1280, 800);
  let line = 12;
  const stream = (text: string) => {
    line += 1;
    hook.pushTranscript(undefined, { type: "append", totalLines: line, entries: [{ line, raw: { type: "assistant", uuid: `s${line}`, message: { role: "assistant", content: [{ type: "text", text }] } } }] });
  };
  // Entries keep arriving while the reader jumps to a folded prompt.
  let n = 0;
  const timer = setInterval(() => { n += 1; stream(`Streaming chunk ${n}: still working through the guard.`); }, 60);
  try {
    await page.locator(".ct-outline-tick").first().click();
    await expect.poll(() => topPrompt(page), { timeout: 10_000 }).toContain("Fix the login flow");
    await page.waitForTimeout(600); // more chunks land after the jump settled; the view stays on the prompt
    expect(await topPrompt(page)).toContain("Fix the login flow");
  } finally {
    clearInterval(timer);
  }
  // Back at the bottom: the next streamed entry is followed.
  await page.locator(".ct-jump").click();
  await expect(page.locator(".ct-jump")).toBeHidden();
  stream("Streaming last: the follow resumed here.");
  await expect(page.locator(".ct-column")).toContainText("the follow resumed here");
  await expect.poll(() => page.locator(".ct-scroll").evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThan(40);

  // And a reader who scrolls back down by hand resumes following too.
  await page.locator(".ct-outline-tick").first().click();
  await expect.poll(() => topPrompt(page)).toContain("Fix the login flow");
  await page.locator(".ct-scroll").hover();
  await page.mouse.wheel(0, 100_000);
  await expect(page.locator(".ct-jump")).toBeHidden();
  stream("Streaming after manual scroll: followed.");
  await expect(page.locator(".ct-column")).toContainText("followed.");
  await expect.poll(() => page.locator(".ct-scroll").evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight)).toBeLessThan(40);
});

test("with 80 prompts the rail merges crowded ticks into ranges that jump to the first", async ({ page }) => {
  await openLongChat(page, 1280, 800, "Step 2 of answer 80");
  const ticks = page.locator(".ct-outline-tick");
  await expect.poll(() => ticks.count()).toBeGreaterThan(5);
  expect(await ticks.count()).toBeLessThan(40);
  const gaps = await ticks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top).map((t, i, all) => (i ? t - all[i - 1] : 99)));
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
  const first = ticks.first();
  await expect(first).toHaveAttribute("aria-label", /^Prompts 1–\d+: Fix the login flow/);
  await first.hover();
  await expect(page.locator(".ct-outline-tip")).toHaveText(/^Prompts 1–\d+$/);
  await first.click();
  await expect(page.locator(".ct-fold")).toContainText("Hide earlier");
  await expect.poll(() => topPrompt(page)).toContain("Fix the login flow");
});

test("the rail stays clear of the scrollbar and the Jump to latest button", async ({ page }) => {
  await openLongChat(page, 1280, 800);
  await page.locator(".ct-scroll").evaluate((s) => { s.scrollTop = 0; });
  await expect(page.locator(".ct-jump")).toBeVisible();
  const rail = await page.locator(".ct-outline").boundingBox();
  const jump = await page.locator(".ct-jump").boundingBox();
  const scroll = await page.locator(".ct-scroll").evaluate((s) => { const r = s.getBoundingClientRect(); return { right: r.right, bar: s.offsetWidth - s.clientWidth }; });
  expect(rail!.x + rail!.width).toBeLessThanOrEqual(scroll.right - scroll.bar);
  expect(jump!.x + jump!.width).toBeLessThan(rail!.x);
});

test("the rail is hidden in a narrow pane and in Console mode, and Alt+Arrow does nothing then", async ({ page }) => {
  await openLongChat(page, 420, 800);
  await expect(page.locator(".ct-outline")).toBeHidden();
  const before = await page.locator(".ct-scroll").evaluate((s) => s.scrollTop);
  await page.locator(".ct-scroll").focus();
  await page.keyboard.press("Alt+ArrowUp");
  expect(await page.locator(".ct-scroll").evaluate((s) => s.scrollTop)).toBe(before);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".ct-outline")).toBeVisible();
  await page.locator(".session-bar .seg, .chat-header button", { hasText: "Console" }).first().click();
  await expect(page.locator(".ct-outline")).toBeHidden();
});

test("works with Find in chat: the rail's text is not searched and a jump keeps the matches", async ({ page }) => {
  await openLongChat(page, 1280, 800);
  await page.locator(".ct-outline-tick").first().click(); // opens the fold: all six prompts are drawn
  await expect(page.locator(".ct-fold")).toContainText("Hide earlier");
  await page.locator(".chat-pane .chat-composer textarea, .chat-pane .chat-composer [contenteditable]").first().focus();
  await page.keyboard.press("Control+f");
  await page.keyboard.type("tooltip leaves out");
  const count = page.locator(".chat-find-count");
  await expect(count).toHaveText("1/6"); // one per prompt's second line; the rail's labels add none
  await page.locator(".ct-outline-tick").nth(1).hover();
  await page.locator(".ct-outline-tick").nth(1).click();
  await expect(page.locator(".ct-column mark.ct-find-hit")).toHaveCount(6);
  await expect(count).toHaveText(/\/6$/);
});
