import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const TOKEN = "desktop-smoke-token";

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
// server.ts finds its UI folder as `../../ui` from its own file: right for the
// compiled dist/src/server.js, but from the TS source it lands on packages/ui.
// Bridge the two for the in-process daemon; remove it once the run is over.
const UI_SOURCE = path.resolve(SPEC_DIR, "../ui");
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");
let linkedUi = false;

function fixture(name: string): Promise<unknown> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(JSON.parse);
}

let dir: string;
let hook: FakeHook;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;

test.beforeAll(async () => {
  if (!existsSync(UI_LINK)) {
    symlinkSync(UI_SOURCE, UI_LINK, "dir");
    linkedUi = true;
  }

  dir = await mkdtemp(path.join(tmpdir(), "desktop-smoke-"));
  process.env.PHREN_BRIDGE_HOME = dir;

  const [overview, transcript, gitStatus, diff] = await Promise.all([
    fixture("overview.json"),
    fixture("transcript.json"),
    fixture("git-status.json"),
    fixture("diff.json"),
  ]);

  hook = await startFakeHook({
    dir,
    overviewFrames: [overview],
    transcriptFrames: transcript as unknown[],
    routes: {
      "POST /v1/git/status": () => ({ status: 200, json: gitStatus }),
      "POST /v1/diff": () => ({ status: 200, json: diff }),
    },
  });

  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => {
    hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); });
  });
  hub.start();
  await ready;

  const server = await startServer({
    port: 0,
    token: TOKEN,
    computers: [LOCAL],
    hub,
    hookRequest,
    hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
});

test.afterAll(async () => {
  hub?.stop();
  await closeServer?.();
  await hook?.close();
  await rm(dir, { recursive: true, force: true });
  if (linkedUi) {
    try { unlinkSync(UI_LINK); } catch { /* already gone */ }
  }
  delete process.env.PHREN_BRIDGE_HOME;
});

test("sidebar, chat and changes render against the fake Hook", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const session = page.locator(".sb-row", { hasText: "Fix login" });
  await expect(session).toBeVisible();
  await session.click();

  await expect(page.locator(".chat-title")).toHaveText("Fix login");

  await page.locator(".segments .segment", { hasText: "Changes" }).click();

  await expect(page.locator(".chg-name", { hasText: "app.ts" })).toBeVisible();
  await expect(page.locator(".chg-name", { hasText: "README.md" })).toBeVisible();

  await page.screenshot({ path: test.info().outputPath("desktop-smoke.png") });
});

test("home lists who needs you, and sessions open as centre tabs", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());

  await page.locator(".section-pill", { hasText: "Home" }).click();
  const needs = page.locator('[data-block="needs"] .home-row', { hasText: "Ship release 0.3.34" });
  await expect(needs).toBeVisible();
  await expect(page.locator('[data-block="working"] .home-row', { hasText: "Fix login" })).toBeVisible();
  await expect(page.locator("#needs-pill")).toHaveText("1 needs you");
  await expect(page.locator(".section-pill.selected")).toHaveText(/Home/);
  await page.waitForTimeout(300); // let the pill's colour transition finish
  await page.screenshot({ path: test.info().outputPath("desktop-home.png") });

  // A Home row opens its session in Agents as a tab; a second session adds a second tab.
  await needs.click();
  await expect(page.locator(".section-pill.selected")).toHaveText("Agents");
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await expect(page.locator(".doc-tab")).toHaveCount(2);
  await expect(page.locator(".doc-tab.selected")).toContainText("Fix login");

  // Switching back keeps the first chat mounted; closing it activates the other.
  await page.locator(".doc-tab", { hasText: "Ship release" }).click();
  await expect(page.locator(".doc-tab.selected")).toContainText("Ship release");
  await expect(page.locator(".chg-name", { hasText: "app.ts" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("desktop-tabs.png") });
  await page.locator(".doc-tab.selected .doc-tab-close").click();
  await expect(page.locator(".doc-tab")).toHaveCount(1);
  await expect(page.locator(".doc-tab.selected")).toContainText("Fix login");
});

test("themes switch the phone's token sets at runtime", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toUpperCase());
  await expect.poll(bg).toBe("#1E1E1E");
  await page.evaluate(async () => { const m = await import("/shell/theme.js"); await m.applyTheme("amethyst"); });
  await expect.poll(bg).toBe("#17121F");
  await page.evaluate(async () => { const m = await import("/shell/theme.js"); await m.applyTheme("midnight"); });
});
