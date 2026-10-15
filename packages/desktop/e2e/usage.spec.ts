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
let linkedUi = false;
let dir: string;
let hook: FakeHook;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;
let used: number;
let reset: string;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

const chat = (id: string, title: string) => ({
  id, title, label: "phren", agent: "claude", agentStatus: "working", cwd: "/Users/you/phren",
  account: { id, label: id },
  target: { server: "default", workspace: "1", tab: "1", pane: id, source: "claude", session: id },
});
const near = chat("work", "Nearly full chat");
const children = [near, chat("empty", "Exhausted chat"), chat("spare", "Plenty of room chat")];
function usage() {
  return {
    accounts: [["work", used], ["empty", 100], ["spare", 20], ["codex", 30]].map(([id, percent]) => ({
      id, harness: id === "codex" ? "codex" : "claude", name: id === "codex" ? "Codex" : "Claude", account: id,
      computers: [{ name: LOCAL.name, account: id }],
      windows: [{ id: id === "codex" ? "codex:primary" : "five_hour", name: "5-hour", usedPercent: percent, resetsAt: reset, exhausted: percent === 100 }],
    })),
    computers: [LOCAL.name], noData: [], unreachable: [], at: new Date().toISOString(),
  };
}

test.beforeEach(async ({ page }) => {
  if (!existsSync(UI_LINK)) { symlinkSync(path.resolve(SPEC_DIR, "../ui"), UI_LINK, "dir"); linkedUi = true; }
  await mkdir(path.resolve(".scratch"), { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/desktop-usage-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  used = 92;
  reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const capabilities = { transcript: true, prompt: true, overviewStream: true, moveNewChat: true };
  hook = await startFakeHook({
    dir,
    overviewFrames: [{ type: "overview", kind: "overview", groups: [{ id: "1", label: "phren", children }],
      phren: { computer: { id: "test-computer", name: LOCAL.name }, version: "0.3.49", capabilities } }],
    routes: {
      "GET /v1/health": () => ({ json: { ok: true, capabilities } }),
      "GET /v1/harnesses": () => ({ json: { harnesses: [
        { source: "claude", installed: true, usable: true, accounts: children.map((c) => ({ id: c.id, label: c.id, usable: true })) },
        { source: "codex", installed: true, usable: true },
      ] } }),
      "POST /v1/sessions/move": (_req, body) => ({ json: { move: { id: (body as { id: string }).id, state: "handing-off" } } }),
      "GET /v1/sessions/move": () => ({ json: { move: { state: "handing-off" } } }),
    },
  });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-usage-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
  // Exercise the shared browser poll with a merged usage fixture, avoiding the
  // daemon's independent 60-second cache. All settings and move traffic is real.
  await page.route("**/api/usage", (route) => route.fulfill({ json: usage() }));
  await page.clock.install();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('.usage-ring[title*="work"]')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.close();
  hub?.stop();
  await closeServer?.();
  await hook?.close();
  await rm(dir, { recursive: true, force: true });
  delete process.env.PHREN_BRIDGE_HOME;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
});

test.afterAll(() => {
  if (linkedUi) { try { unlinkSync(UI_LINK); } catch { /* already gone */ } }
});

async function openChat(page: Page) {
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: near.title }).click();
  await expect(page.locator(".chat-title")).toHaveText(near.title);
}

async function refreshUsage(page: Page) {
  const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/usage");
  await page.clock.fastForward(60_000);
  await response;
  await expect(page.locator('.usage-ring[title*="work"]')).toHaveAttribute("title", new RegExp(`${used}% used`));
}

test("warning crosses the threshold above the composer, dismisses and respects a chat opt-out on refresh", async ({ page }) => {
  used = 20;
  await refreshUsage(page);
  await openChat(page);
  const warning = page.getByRole("region", { name: /Claude is at/ });
  await expect(warning).toBeHidden();
  used = 92;
  await refreshUsage(page);
  await expect(warning).toContainText("92% of its 5-hour limit");
  await page.locator(".pc-input").fill("Ready to send");
  const send = page.getByTitle("Send", { exact: true });
  await expect(send).toBeEnabled();
  const cardBox = await warning.boundingBox();
  const sendBox = await send.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(sendBox!.y);
  await warning.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(warning).toBeHidden();
  // A new reset period is a fresh warning; an opt-out must suppress even that,
  // rather than passing merely because this period's warning was already seen.
  reset = new Date(Date.parse(reset) + 3_600_000).toISOString();
  await refreshUsage(page);
  await expect(warning).toBeVisible();
  const saved = page.waitForResponse((res) => res.url().endsWith("/api/settings/quota-warning") && res.request().postDataJSON()?.suppress);
  await warning.getByRole("button", { name: "Don't ask again for this chat", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  reset = new Date(Date.parse(reset) + 3_600_000).toISOString();
  await refreshUsage(page);
  await expect(warning).toBeHidden();
  await page.reload();
  await openChat(page);
  await expect(warning).toBeHidden();
});

for (const family of ["same", "different"] as const) {
  test(`Switch to a ${family}-family account sends the right move body`, async ({ page }) => {
    await openChat(page);
    await page.locator(".quota-warning").getByRole("button", { name: "Switch", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Continue in another agent" });
    await sheet.getByRole("button", { name: family === "same" ? "Claude" : "Codex", exact: true }).click();
    if (family === "same") await sheet.getByRole("combobox", { name: "Claude account" }).selectOption("spare");
    await sheet.getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(() => hook.calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions/move").length).toBe(1);
    const body = hook.calls.find((c) => c.method === "POST" && c.path === "/v1/sessions/move")!.body;
    expect(body).toEqual({ target: near.target, to: family === "same" ? { harness: "claude", account: "spare" } : { harness: "codex" },
      id: expect.any(String), ...(family === "different" ? { mode: "new-chat" } : {}) });
  });
}

test("Home Running low orders exhausted before 92 percent and omits a 20 percent chat", async ({ page }) => {
  const low = page.locator('[data-block="low"]');
  await expect(low).toContainText("Running low");
  await expect(low.locator(".home-row-title")).toHaveText(["Exhausted chat", near.title]);
  await expect(low).toContainText("Exhausted");
  await expect(low).toContainText("92%");
  await expect(low).not.toContainText("Plenty of room chat");
  // The omitted chat exists in the same live overview, with a usable account.
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row", { hasText: "Plenty of room chat" })).toBeVisible();
});

test("account usage shortcut opens the popover and Escape restores focus", async ({ page }) => {
  const invoker = page.locator('.section-pill[data-section="home"]');
  await invoker.focus();
  await page.keyboard.press("ControlOrMeta+Alt+u");
  const popover = page.getByRole("dialog", { name: "Account usage", exact: true });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Claude · work");
  await expect(popover).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(invoker).toBeFocused();
});

test("Settings Notifications saves the warning threshold across reload", async ({ page }) => {
  const openNotifications = async () => {
    await page.locator('.section-pill[data-section="settings"]').click();
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
  };
  await openNotifications();
  const threshold = page.getByRole("spinbutton", { name: "Account usage warning percentage" });
  await expect(threshold).toBeEnabled();
  await expect(threshold).toHaveValue("90");
  await threshold.fill("95");
  const saved = page.waitForResponse((res) => res.url().endsWith("/api/settings/quota-warning") && res.request().method() === "POST");
  await threshold.press("Tab");
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await openNotifications();
  await expect(threshold).toHaveValue("95");
  await page.locator('.section-pill[data-section="home"]').click();
  await expect(page.locator('[data-block="low"] .home-row-title')).toHaveText(["Exhausted chat"]);
});
