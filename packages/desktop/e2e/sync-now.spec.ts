import { expect, test, type Page } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";
import type { FakeHookHandler } from "../src/testing/fake-hook.js";

let h: Harness | undefined;
let unlinkUi: () => void;

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const blob = (path: string, sha: string) => ({ path, sha, type: "blob", size: 10 });
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const TREES: Record<string, unknown[]> = {
  [OLD]: [blob("phren/FINDINGS.md", "1".repeat(40))],
  [NEW]: [blob("phren/FINDINGS.md", "2".repeat(40)), blob("phren/notes/n.md", "3".repeat(40))],
};

/** A Hook whose store moves to a new head once its pull has been requested. */
function storeRoutes(pull: FakeHookHandler, state: { pulled: boolean }): Record<string, FakeHookHandler> {
  return {
    "GET /v1/tasks/stores": () => ({ json: { stores: [{ id: "ab12cd34", name: "Personal", primary: true, role: "primary", available: true, projects: ["phren"],
      repositoryIdentity: { repository: "me/memory", branch: "main" } }] } }),
    "GET /v1/store/head": () => ({ json: { sha: state.pulled ? NEW : OLD } }),
    "GET /v1/store/tree": (_req, _body, url) => ({ json: { sha: url.searchParams.get("sha"), tree: TREES[url.searchParams.get("sha") ?? ""] ?? [] } }),
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

test("Sync now shows Syncing, then what was pulled, and reads Memory again", async ({ page }) => {
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

  await expect(page.locator(".mem-sync-status")).toHaveText("Pulled 2 changes");
  await expect(button).toHaveText("Sync now");
  // Throttled: no second click for ten seconds.
  await expect(button).toBeDisabled();
  await expect.poll(() => reads.length).toBeGreaterThan(before);
  const pulls = h.hook.calls.filter((c) => c.method === "POST" && c.path === "/v1/store/pull-now");
  expect(pulls).toHaveLength(1);
  expect(pulls[0].body).toEqual({ storeId: "ab12cd34", repository: "me/memory", branch: "main" });
});

test("Sync now shows the Hook's error and stays out of the way", async ({ page }) => {
  h = await startHarness("sync-now-error", { overviewFrames: [overview()], routes: storeRoutes(
    () => ({ status: 403, json: { error: "Only the owner or a peer Hook can request a pull." } }), { pulled: false }) });
  await openMemory(page, h.url);
  await page.locator(".mem-sync-btn").click();
  const status = page.locator(".mem-sync-status");
  await expect(status).toHaveText("Only the owner or a peer Hook can request a pull.");
  await expect(status).toHaveClass(/error/);
});
