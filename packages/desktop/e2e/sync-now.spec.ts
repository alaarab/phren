import { expect, test, type Page } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";
import type { FakeHookHandler } from "../src/testing/fake-hook.js";

let h: Harness | undefined;
let unlinkUi: () => void;

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const STORE = { id: "ab12cd34", name: "Personal", primary: true, role: "primary", available: true, projects: ["phren"],
  repositoryIdentity: { repository: "me/memory", branch: "main" } };

/** A Hook whose store head moves once its pull has been requested (when `moves`). */
function storeRoutes(pull: FakeHookHandler, state: { pulled: boolean; headFailures?: number }, stores: unknown[] = [STORE]): Record<string, FakeHookHandler> {
  return {
    "GET /v1/tasks/stores": () => ({ json: { stores } }),
    "GET /v1/store/head": () => {
      if (state.pulled && state.headFailures) { state.headFailures -= 1; return { status: 500, json: { error: "boom" } }; }
      return { json: { sha: state.pulled ? NEW : OLD } };
    },
    "POST /v1/store/pull-now": pull,
  };
}

async function openMemory(page: Page, url: string) {
  const reads: string[] = [];
  await page.route("**/api/memory/*/projects", (route) => { reads.push(route.request().url()); return route.fulfill({ json: { projects: [{ name: "phren", findings: 1 }] } }); });
  await page.route("**/api/memory/*/findings?*", (route) => route.fulfill({ json: { items: [] } }));
  await page.goto(`${url}#/memory`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".mem-project")).toHaveCount(1);
  return reads;
}

const overview = () => overviewFrame([chatRow("login", "Fix login", "idle", { label: "phren" })]);
const pullCalls = (hook: Harness["hook"]) => hook.calls.filter((c) => c.method === "POST" && c.path === "/v1/store/pull-now");

test("Sync now requests the pull, then says Memory updated when the head moves and reads Memory again", async ({ page }) => {
  const state = { pulled: false };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h = await startHarness("sync-now", { overviewFrames: [overview()], routes: storeRoutes(async () => {
    await gate;
    state.pulled = true;
    return { json: { ok: true } };
  }, state) });
  const reads = await openMemory(page, h.url);
  const button = page.locator(".mem-sync-btn");
  await expect(button).toHaveText("Sync now");
  await expect(button).toBeEnabled();
  const before = reads.length;

  await button.click();
  await expect(button).toHaveText("Syncing…");
  await expect(button).toBeDisabled();
  await expect(page.locator(".mem-sync-status")).toHaveText("Syncing…");
  release();

  await expect(page.locator(".mem-sync-status")).toHaveText("Sync requested");
  await expect(button).toHaveText("Sync now");
  // Throttled: no second click for ten seconds.
  await expect(button).toBeDisabled();
  await expect(page.locator(".mem-sync-status")).toHaveText("Memory updated", { timeout: 15_000 });
  await expect.poll(() => reads.length).toBeGreaterThan(before);
  expect(pullCalls(h.hook)).toHaveLength(1);
  expect(pullCalls(h.hook)[0].body).toEqual({ storeId: "ab12cd34", repository: "me/memory", branch: "main" });
  // No tree reads: the head alone says whether anything moved.
  expect(h.hook.calls.some((c) => c.path.startsWith("/v1/store/tree"))).toBe(false);
});

test("a failed head read while watching is ignored", async ({ page }) => {
  const state = { pulled: false, headFailures: 1 };
  h = await startHarness("sync-now-blip", { overviewFrames: [overview()], routes: storeRoutes(() => { state.pulled = true; return { json: { ok: true } }; }, state) });
  await openMemory(page, h.url);
  await page.locator(".mem-sync-btn").click();
  const status = page.locator(".mem-sync-status");
  await expect(status).toHaveText("Sync requested");
  await expect(status).toHaveText("Memory updated", { timeout: 20_000 });
  await expect(status).not.toHaveClass(/error/);
});

test("nothing moving in the window says so, and never says up to date", async ({ page }) => {
  h = await startHarness("sync-now-quiet", { overviewFrames: [overview()], routes: storeRoutes(() => ({ json: { ok: true } }), { pulled: false }) });
  await page.clock.install();
  await openMemory(page, h.url);
  await page.locator(".mem-sync-btn").click();
  const status = page.locator(".mem-sync-status");
  await expect(status).toHaveText("Sync requested");
  // Each read is a real request between fake-clock timers, so step the clock until the 45 s watch ends.
  for (let i = 0; i < 40 && !/no new changes/.test(await status.innerText()); i++) {
    await page.clock.runFor(4000);
    await page.waitForTimeout(100);
  }
  await expect(status).toHaveText("Sync requested — no new changes so far");
  expect(await page.locator(".mem").innerText()).not.toMatch(/up to date/i);
});

test("a computer with several stores syncs the primary one and says so", async ({ page }) => {
  h = await startHarness("sync-now-stores", { overviewFrames: [overview()], routes: storeRoutes(() => ({ json: { ok: true } }), { pulled: false },
    [STORE, { id: "11223344", name: "Team", primary: false, role: "readonly", available: true, projects: ["team"] }]) });
  await openMemory(page, h.url);
  const button = page.locator(".mem-sync-btn");
  await expect(button).toHaveText("Sync primary store");
  await expect(button).toHaveAttribute("title", /team stores are not included/i);
});

test("the button is disabled with its reason once the computer is offline", async ({ page }) => {
  h = await startHarness("sync-now-offline", { overviewFrames: [overview()], routes: storeRoutes(() => ({ json: { ok: true } }), { pulled: false }) });
  await openMemory(page, h.url);
  await expect(page.locator(".mem-sync-btn")).toBeEnabled();
  await h.hook.close();
  const button = page.locator(".mem-sync-btn");
  await expect(button).toBeDisabled({ timeout: 30_000 });
  await expect(button).toHaveAttribute("title", "Computer offline");
});

test("Sync now shows the Hook's error when the request fails", async ({ page }) => {
  h = await startHarness("sync-now-error", { overviewFrames: [overview()], routes: storeRoutes(
    () => ({ status: 403, json: { error: "Only the owner or a peer Hook can request a pull." } }), { pulled: false }) });
  await openMemory(page, h.url);
  await page.locator(".mem-sync-btn").click();
  const status = page.locator(".mem-sync-status");
  await expect(status).toHaveText("Only the owner or a peer Hook can request a pull.");
  await expect(status).toHaveClass(/error/);
});
