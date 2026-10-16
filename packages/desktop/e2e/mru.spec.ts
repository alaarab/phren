import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

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

const chat = (id: string, title: string, agentStatus: string, lastReply: string) => ({
  id, title, label: "phren", agent: "claude", agentStatus, lastReply, cwd: "/Users/you/phren",
  target: { server: "default", workspace: "1", tab: id, pane: id, source: "claude", session: id },
});
const children = [
  chat("a", "Alpha chat", "working", "Running the migration now"),
  chat("b", "Bravo chat", "blocked", "Should I delete the old table? I need your go-ahead before I continue with the rest of the cleanup."),
  chat("c", "Charlie chat", "idle", "All done, tests pass."),
];
const overview = {
  type: "overview", kind: "overview", groups: [{ id: "1", label: "phren", children }],
  phren: { computer: { id: "test-computer", name: LOCAL.name }, version: "0.3.49",
    capabilities: { transcript: true, prompt: true, overviewStream: true } },
};

test.beforeEach(async ({ page }) => {
  if (!existsSync(UI_LINK)) { symlinkSync(path.resolve(SPEC_DIR, "../ui"), UI_LINK, "dir"); linkedUi = true; }
  await mkdir(path.resolve(".scratch"), { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/desktop-mru-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  hook = await startFakeHook({ dir, overviewFrames: [overview] });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-mru-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  // Open A, B, C in order.
  for (const title of ["Alpha chat", "Bravo chat", "Charlie chat"]) {
    await page.locator(".sb-row").filter({ has: page.locator(".sb-title", { hasText: title }) }).click();
    await expect(page.locator(".doc-tab.selected .doc-tab-title")).toHaveText(title);
  }
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

const active = (page: Page) => page.locator(".doc-tab.selected .doc-tab-title");
const titles = (page: Page) => page.locator(".mru-card .mru-title");

test("a quick Ctrl+Tab tap toggles to the previous chat without showing the overlay", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  // Tapping again toggles back.
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Charlie chat");
});

test("holding Ctrl and pressing Tab twice lists chats newest first, selects the oldest and opens it on release", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(titles(page)).toHaveText(["Charlie chat", "Bravo chat", "Alpha chat"]);
  const list = page.getByRole("listbox", { name: "Recent chats" });
  await expect(list).toBeVisible();
  const selected = page.locator('.mru-card[aria-selected="true"]');
  await expect(selected).toHaveText(/Alpha chat/);
  await expect(list).toHaveAttribute("aria-activedescendant", (await selected.getAttribute("id"))!);
  await expect(page.locator(".mru-card").nth(1)).toContainText("Needs you");
  await expect(page.locator(".mru-card").nth(0)).toContainText("Idle");
  await expect(page.locator(".mru-card").nth(2)).toContainText("Working");
  // Shift+Tab steps back.
  await page.keyboard.press("Shift+Tab");
  await expect(selected).toHaveText(/Bravo chat/);
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await expect(active(page)).toHaveText("Alpha chat");
});

test("Esc cancels, keeps the current chat and restores focus", async ({ page }) => {
  const composer = page.locator(".doc:not([hidden]) textarea").first();
  await composer.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".mru-backdrop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Charlie chat");
  await expect(composer).toBeFocused();
});

test("clicking a card opens that chat", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.locator(".mru-card").filter({ hasText: "Bravo chat" }).click();
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
});

test("the Settings toggle turns Ctrl+Tab switching off", async ({ page }) => {
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.getByRole("button", { name: "Keys" }).first().click();
  await page.locator(".settings-toggle", { hasText: "Ctrl+Tab switches recent chats" }).locator(".track").click();
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await expect(active(page)).toHaveText("Charlie chat");
});

test("a terminal or editor keeps Ctrl+Tab", async ({ page }) => {
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.className = "xterm";
    const input = document.createElement("textarea");
    host.append(input);
    document.body.append(host);
    input.focus();
  });
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Charlie chat");
});

test("a missed Ctrl release opens the selection on the next event with Ctrl up", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".mru-backdrop")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: false })));
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await expect(active(page)).toHaveText("Alpha chat");
  await page.keyboard.up("Control");
});

test("the overlay is modal and announces the selected chat", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("dialog", { name: "Recent chats" })).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".mru-live")).toHaveText("Alpha chat, phren on This computer, working");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Control");
});
