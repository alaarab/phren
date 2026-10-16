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

function child(id: string, title: string, fields: object) {
  return {
    id, title, label: "phren", agent: "claude", cwd: "/Users/you/phren", lastChangedAt: "2026-10-16T09:00:00.000Z",
    target: { server: "default", workspace: "1", tab: id, pane: id, source: "claude", session: id }, ...fields,
  };
}

/** Two chats waiting for a reply, one asking for approval, one blocked. */
function frame(fixLogin: object = {}) {
  return {
    type: "overview", kind: "overview",
    groups: [{ id: "1", label: "phren", children: [
      child("fix", "Fix login", { agentStatus: "waiting", lastReply: "Tests pass. Want me to open a PR?", ...fixLogin }),
      child("docs", "Review the docs", { agentStatus: "waiting", lastReply: "Which section first?" }),
      child("sudo", "Ship release 0.3.34", { agentStatus: "blocked", approvalPending: true }),
      child("stuck", "Migrate the index", { agentStatus: "blocked" }),
    ] }],
    phren: { computer: { id: "test-computer", name: LOCAL.name }, version: "0.3.49", capabilities: { transcript: true, prompt: true, overviewStream: true } },
  };
}

test.beforeEach(async () => {
  if (!existsSync(UI_LINK)) { symlinkSync(path.resolve(SPEC_DIR, "../ui"), UI_LINK, "dir"); linkedUi = true; }
  await mkdir(path.resolve(".scratch"), { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/desktop-snooze-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  hook = await startFakeHook({ dir, overviewFrames: [frame()] });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-snooze-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
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

async function openHome(page: Page) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await expect(page.locator('[data-block="needs"] .home-row')).toHaveCount(4);
}

const needs = (page: Page) => page.locator('[data-block="needs"]');
const rowOf = (page: Page, title: string) => needs(page).locator(".home-reply-row, .home-row", { hasText: title }).first();

async function snoozeFix(page: Page, choice = "1h") {
  const row = needs(page).locator(".home-reply-row", { hasText: "Fix login" });
  await row.getByRole("button", { name: "Snooze Fix login" }).click();
  await row.locator(`[data-snooze="${choice}"]`).click();
}

test("snoozing a waiting chat hides its row and lowers every needs-you count; Wake now brings it back", async ({ page }) => {
  await openHome(page);
  await expect(page.locator("#needs-pill")).toHaveText("4 need you");
  await expect(needs(page).locator(".count")).toHaveText("4");
  await expect(needs(page).locator(".home-snoozed")).toBeHidden();
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("snooze-before.png") });

  const row = needs(page).locator(".home-reply-row", { hasText: "Fix login" });
  await row.getByRole("button", { name: "Snooze Fix login" }).click();
  await expect(row.getByRole("menuitem")).toHaveText(["15 minutes", "1 hour", /^Until (tomorrow )?9:00$/]);
  await page.screenshot({ path: test.info().outputPath("snooze-menu.png") });
  await row.locator('[data-snooze="1h"]').click();

  await expect(needs(page).locator(".home-row", { hasText: "Fix login" })).toHaveCount(0);
  await expect(page.locator("#needs-pill")).toHaveText("3 need you");
  await expect(needs(page).locator(".count")).toHaveText("3");
  await expect(page).toHaveTitle("(3) Phren");
  // The sidebar still lists the chat under Needs you, marked as snoozed.
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row", { hasText: "Fix login" }).locator(".sb-snoozed")).toHaveAttribute("title", /^Snoozed until /);
  await page.locator(".section-pill", { hasText: "Home" }).click();

  const footer = needs(page).locator(".home-snoozed");
  await expect(footer.locator(".home-snoozed-label")).toHaveText("Snoozed (1)");
  expect(await footer.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false); // collapsed
  await footer.locator("summary").click();
  await expect(footer.locator(".home-snoozed-row")).toContainText("Fix login");
  await expect(footer.locator(".home-snoozed-row")).toContainText("until");
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("snooze-after.png") });

  // It survives a reload (per-viewer storage) and the sidebar's own needs-you group is untouched.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await expect(page.locator("#needs-pill")).toHaveText("3 need you");
  await expect(needs(page).locator(".home-snoozed-label")).toHaveText("Snoozed (1)");

  await needs(page).locator(".home-snoozed summary").click();
  await needs(page).locator(".home-snoozed-wake").click();
  await expect(needs(page).locator(".home-reply-row", { hasText: "Fix login" })).toBeVisible();
  await expect(page.locator("#needs-pill")).toHaveText("4 need you");
  await expect(needs(page).locator(".home-snoozed")).toBeHidden();
});

test("a new message on a snoozed chat brings it back at once", async ({ page }) => {
  await openHome(page);
  await snoozeFix(page);
  await expect(page.locator("#needs-pill")).toHaveText("3 need you");
  // The same frame again changes nothing.
  hook.pushOverview(frame());
  await page.waitForTimeout(300);
  await expect(page.locator("#needs-pill")).toHaveText("3 need you");
  // A new reply from the agent is a new need.
  hook.pushOverview(frame({ lastReply: "Actually, CI failed. Should I fix it?", lastChangedAt: "2026-10-16T09:30:00.000Z" }));
  await expect(page.locator("#needs-pill")).toHaveText("4 need you");
  await expect(needs(page).locator(".home-reply-row", { hasText: "Fix login" })).toContainText("CI failed");
  await expect(needs(page).locator(".home-snoozed")).toBeHidden();
});

test("approvals and blocked agents have no Snooze, and the menu works from the keyboard", async ({ page }) => {
  await openHome(page);
  await expect(page.getByRole("button", { name: /^Snooze/ })).toHaveCount(2); // the two waiting chats only
  await expect(rowOf(page, "Ship release 0.3.34").getByRole("button", { name: /Snooze/ })).toHaveCount(0);
  await expect(rowOf(page, "Migrate the index").getByRole("button", { name: /Snooze/ })).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "Snooze Review the docs" });
  const menu = rowOf(page, "Review the docs");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu.locator('[data-snooze="15m"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator('[data-snooze="1h"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter"); // 15 minutes
  await expect(needs(page).locator(".home-row", { hasText: "Review the docs" })).toHaveCount(0);
  await expect(page.locator("#needs-pill")).toHaveText("3 need you");
  await expect(needs(page).locator(".home-snoozed-label")).toHaveText("Snoozed (1)");
});

test("the Snooze menu fits a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.locator(".section-pill", { hasText: "Home" }).click();
  const row = needs(page).locator(".home-reply-row", { hasText: "Fix login" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Snooze Fix login" }).click();
  await expect(row.locator('[data-snooze="morning"]')).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
