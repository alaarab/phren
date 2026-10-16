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

const chat = (id: string, title: string, source: string) => ({
  id, title, label: "phren", agent: source, agentStatus: "working", cwd: "/Users/you/phren",
  target: { server: "default", workspace: "1", tab: id, pane: id, source, session: id },
});
const oldChat = chat("login-claude", "Fix login", "claude");
const newChat = chat("login-codex", "Fix login (Codex)", "codex");
const children = [
  { ...oldChat, handedOffTo: { target: newChat.target, harness: "codex", title: newChat.title } },
  { ...newChat, handedOffFrom: { target: oldChat.target, harness: "claude", title: oldChat.title } },
];
const overview = (rows = children) => ({
  type: "overview", kind: "overview", groups: [{ id: "1", label: "phren", children: rows }],
  phren: { computer: { id: "test-computer", name: LOCAL.name }, version: "0.3.49",
    capabilities: { transcript: true, prompt: true, overviewStream: true } },
});

test.beforeEach(async ({ page }) => {
  if (!existsSync(UI_LINK)) { symlinkSync(path.resolve(SPEC_DIR, "../ui"), UI_LINK, "dir"); linkedUi = true; }
  await mkdir(path.resolve(".scratch"), { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/desktop-handoff-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  hook = await startFakeHook({ dir, overviewFrames: [overview()] });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-handoff-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-block="working"] .home-row')).toHaveCount(2);
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

async function sidebar(page: Page) {
  await page.locator('.section-pill[data-section="agents"]').click();
  return page.locator(".sb-row").filter({ has: page.locator(".sb-title", { hasText: /^Fix login$/ }) });
}

async function openedChat(page: Page, title: string) {
  await expect(page.locator(".doc-tab")).toHaveCount(1);
  await expect(page.locator(".doc-tab.selected .doc-tab-title")).toHaveText(title);
  await expect(page.locator(".chat-title")).toHaveText(title);
}

test("sidebar dims the old chat and its hand-off tag opens Codex", async ({ page }) => {
  const row = await sidebar(page);
  await expect(row).toBeVisible();
  // Measure effective title opacity: the dimming may live on its parent.
  const opacity = await row.locator(".sb-title").evaluate((title) => {
    let value = 1;
    for (let node: Element | null = title; node && !node.classList.contains("sb-row"); node = node.parentElement) {
      value *= Number(getComputedStyle(node).opacity);
    }
    return value;
  });
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await row.getByRole("button", { name: "→ Codex", exact: true }).click();
  await openedChat(page, newChat.title);
});

test("Tab then Enter on the hand-off tag opens only the new chat", async ({ page }) => {
  const row = await sidebar(page);
  const tag = row.getByRole("button", { name: "→ Codex", exact: true });
  await row.focus();
  // Use native tab order rather than focusing the nested button directly.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    if (await tag.evaluate((button) => button === document.activeElement)) break;
  }
  await expect(tag).toBeFocused();
  await page.keyboard.press("Enter");
  await openedChat(page, newChat.title);
});

test("Enter on the sidebar row itself opens the old chat", async ({ page }) => {
  const row = await sidebar(page);
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await openedChat(page, oldChat.title);
});

test("Home Working hand-off rows fill the list with tags on their metadata line", async ({ page }) => {
  const list = page.locator('[data-block="working"] .home-list');
  const rows = list.locator(".home-working");
  const oldRow = rows.filter({ has: page.getByText(oldChat.title, { exact: true }) });
  const newRow = rows.filter({ has: page.getByText(newChat.title, { exact: true }) });
  await expect(oldRow.locator(".home-row-meta").getByRole("button", { name: "→ Codex", exact: true })).toBeVisible();
  await expect(newRow.locator(".home-row-meta").getByRole("button", { name: "← from Fix login", exact: true })).toBeVisible();
  const listBox = await list.boundingBox();
  const oldBox = await oldRow.boundingBox();
  const newBox = await newRow.boundingBox();
  expect(listBox).not.toBeNull();
  expect(oldBox).not.toBeNull();
  expect(newBox).not.toBeNull();
  expect(oldBox!.width).toBeCloseTo(newBox!.width, 0);
  for (const box of [oldBox!, newBox!]) {
    expect(box.x).toBeCloseTo(listBox!.x, 0);
    expect(box.width).toBeCloseTo(listBox!.width, 0);
  }
});

test("removing the destination leaves an informational tag without a link", async ({ page }) => {
  const row = await sidebar(page);
  await expect(row.getByRole("button", { name: "→ Codex", exact: true })).toBeVisible();
  hook.pushOverview(overview([children[0]]));
  await expect(page.locator(".sb-row")).toHaveCount(1);
  await expect(row.locator(".handoff-tag")).toHaveText("→ Codex");
  await expect(row.getByRole("button", { name: "→ Codex", exact: true })).toHaveCount(0);
  await expect(row.getByRole("link", { name: "→ Codex", exact: true })).toHaveCount(0);
  await expect(row.locator(".handoff-tag")).toHaveJSProperty("tabIndex", -1);
  await page.locator('.section-pill[data-section="home"]').click();
  const home = page.locator('[data-block="working"] .home-row');
  await expect(home).toHaveCount(1);
  await expect(home.locator(".home-row-meta .handoff-tag")).toHaveText("→ Codex");
  await expect(home.locator(".handoff-tag")).toHaveJSProperty("tabIndex", -1);
});
