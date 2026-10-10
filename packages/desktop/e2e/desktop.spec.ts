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
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow");
  await expect(page.locator(".ct-column")).toContainText("On it. The session token is dropped before the guard runs.");

  await page.locator("#side .segments .segment", { hasText: "Changes" }).click();

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

test("palette, settings and the three-segment tool panel", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sb-row", { hasText: "Fix login" }).click();

  // The right panel has exactly Changes · Files · Search; Extensions moved to Settings.
  await expect(page.locator("#side .segments .segment")).toHaveText(["Changes", "Files", "Search"]);

  // ⌘K opens the palette; typing a session title and Enter opens it.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.keyboard.type("Ship release");
  await page.screenshot({ path: test.info().outputPath("desktop-palette.png") });
  await page.keyboard.press("Enter");
  await expect(page.locator(".doc-tab.selected")).toContainText("Ship release");

  // Settings: theme picker and Extensions page.
  await page.locator(".section-pill", { hasText: "Settings" }).click();
  await page.locator(".settings-tab", { hasText: "Appearance" }).click();
  await page.locator(".settings-theme", { hasText: "Slate" }).click();
  await expect(page.locator(".settings-theme.selected")).toHaveText("Slate");
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("desktop-settings.png") });
  await page.locator(".settings-theme", { hasText: "Charcoal" }).click();
  await page.locator(".settings-tab", { hasText: "Computers" }).click();
  await expect(page.locator(".settings-page-computers")).toContainText("This computer");
});

test("composer matches the phone's bar", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { createComposer } = await import("/chat/composer.js");
    const host = document.createElement("div");
    host.id = "composer-probe";
    host.style.cssText = "position:fixed;left:40px;bottom:40px;width:620px;z-index:999;background:var(--bg);padding:16px";
    document.body.append(host);
    const c = createComposer({ computer: "This computer", target: { server: "default", workspace: "1", tab: "1", pane: "1", source: "claude", session: "sess-fix-login" }, provider: "claude",
      onConsole() {}, onAgents() {}, onWorkers() {}, onDictate() {}, onTalk() {} });
    host.append(c.el);
    c.setStatus({ status: "working" });
    c.setCounts({ agents: 2, workers: 6 });
    c.setBackground([1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: String(i), label: `job ${i}`, state: "running" })));
  });
  await page.waitForTimeout(300);
  await page.locator("#composer-probe").screenshot({ path: test.info().outputPath("composer.png") });
});

test("the kit loads in the browser", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const names = await page.evaluate(async () => Object.keys(await import("/vendor/kit/index.js")).length);
  expect(names).toBeGreaterThan(10);
});

test("a changed file opens as a centre diff tab", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.locator(".chg-name", { hasText: "app.ts" }).click();
  await expect(page.locator(".doc-tab", { hasText: "app.ts" })).toBeVisible();
  await expect(page.locator(".doc-tab")).toHaveCount(2);
  await page.locator(".doc-diff .monaco-editor, .doc-diff .monaco-diff-editor").first().waitFor({ timeout: 15000 }).catch(() => {});
  await expect(page.locator(".doc-diff .ed-banner")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("diff-tab.png") });
});

test("tiles split, move and swap like Herdr panes; a session switches to its console", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.locator(".sb-row", { hasText: "Ship release" }).click();
  await expect(page.locator(".tile")).toHaveCount(1);

  // Split side by side, then move the active session into the new tile.
  await page.locator(".layout-btn", { hasText: "Split →" }).click();
  await expect(page.locator(".tile")).toHaveCount(2);
  await page.locator(".tile").first().locator(".doc-tab", { hasText: "Ship release" }).click();
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Shift+L");
  await expect(page.locator(".tile").nth(1).locator(".doc-tab")).toContainText(["Ship release"]);
  await expect(page.locator(".tile").first().locator(".doc-tab")).toContainText(["Fix login"]);

  // Chat <-> Console on the focused session.
  await page.locator(".tile").nth(1).locator(".session-switch .segment", { hasText: "Console" }).click();
  await expect(page.locator(".tile").nth(1).locator(".session-console")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("tiles.png") });
  await page.locator(".tile").nth(1).locator(".session-switch .segment", { hasText: "Chat" }).click();

  // Closing the last tab of a tile collapses it.
  await page.locator(".tile").nth(1).locator(".doc-tab-close").click({ force: true });
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("projects section renders", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".section-pill", { hasText: "Projects" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: test.info().outputPath("projects.png") });
  expect(errors).toEqual([]);
});

test("the graph renderer is served", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const ok = await page.evaluate(async () => (await fetch("/vendor/phren-graph.js")).ok);
  expect(ok).toBe(true);
});

test("using the desktop reports desk presence to the Hooks", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await page.keyboard.press("Shift");
  await expect.poll(() => hook.calls.filter((c) => c.path === "/v1/push/presence").length).toBeGreaterThan(0);
  const call = hook.calls.find((c) => c.path === "/v1/push/presence");
  expect(call?.method).toBe("POST");
});

test("Enter on a focused Deny denies (it never approves)", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const decisions: string[] = [];
  await page.route("**/v1/approvals/answer", async (route) => {
    decisions.push(JSON.parse(route.request().postData() ?? "{}").decision);
    await route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
  });
  await page.evaluate(async () => {
    const { renderInteractions } = await import("/chat/cards.js");
    const host = document.createElement("div");
    host.id = "card-probe";
    document.body.append(host);
    renderInteractions(host, { status: "blocked", pendingApproval: { actionId: "a1", toolName: "Bash", title: "Bash", summary: "rm -rf build" } },
      { computer: "This computer", target: { server: "default", workspace: "1", tab: "1", pane: "1", source: "claude", session: "s" }, onAnswered() {} });
  });
  const deny = page.locator("#card-probe button", { hasText: /^Deny$/ });
  await deny.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => decisions).toEqual(["deny"]);
});
