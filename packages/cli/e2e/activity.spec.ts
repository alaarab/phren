import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createWebUiHarness, type WebUiHarness } from "./web-ui-harness";

let harness: WebUiHarness;

function lookupLogPath(): string {
  return path.join(harness.phrenDir, ".runtime", "lookup-events.jsonl");
}

/** Append a lookup event to the store's live log, exactly as the search tool would. */
function appendLookup(ev: Record<string, unknown>): void {
  const p = lookupLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), source: "search", ...ev }) + "\n");
}

async function stubExternalAssets(page: Page): Promise<void> {
  await page.route("https://cdn.jsdelivr.net/npm/marked@12/marked.min.js", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/javascript", body: "window.marked={parse(v){return String(v);}};" });
  });
  await page.route("https://fonts.bunny.net/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/css", body: "" });
  });
}

async function openActivityTab(page: Page): Promise<void> {
  await stubExternalAssets(page);
  await page.goto(harness.secureUrl, { waitUntil: "domcontentloaded" });
  await page.locator("button.nav-item").filter({ hasText: "Activity" }).click();
  await expect(page.locator("#tab-activity")).toHaveClass(/active/);
}

test.describe.serial("web-ui activity (live memory lookups)", () => {
  test.beforeAll(async () => {
    harness = await createWebUiHarness();
  });

  test.afterAll(async () => {
    await harness.cleanup();
  });

  test("renders existing lookups from the initial snapshot", async ({ page }) => {
    // Seed two events before the page loads — these come back via /api/lookups.
    appendLookup({ query: "redis cache", project: "repo-a", filename: "FINDINGS.md", type: "findings", snippet: "Redis caching uses a TTL of 300 seconds" });
    appendLookup({ query: "redis cache", project: "repo-a", filename: "reference/browser.md", type: "reference", snippet: "Browser reference doc." });

    await openActivityTab(page);

    const feed = page.locator("#activity-feed");
    await expect(feed.locator(".activity-item")).toHaveCount(2, { timeout: 8_000 });
    await expect(feed).toContainText("repo-a/FINDINGS.md");
    await expect(feed).toContainText("repo-a/reference/browser.md");
    await expect(feed).toContainText("redis cache");
    // Newest-first ordering: the reference doc (appended last) is on top.
    await expect(feed.locator(".activity-item").first().locator(".activity-loc")).toHaveText("repo-a/reference/browser.md");
  });

  test("streams a new lookup live over SSE", async ({ page }) => {
    await openActivityTab(page);

    // Wait for the SSE connection to open so we don't append before tailing starts.
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });
    await expect(page.locator("#activity-led")).toHaveClass(/activity-led-ok/);

    const feed = page.locator("#activity-feed");
    const before = await feed.locator(".activity-item").count();

    const uniqueQuery = `live-probe-${Date.now()}`;
    appendLookup({ query: uniqueQuery, project: "repo-b", filename: "FINDINGS.md", type: "findings", snippet: "Secondary project keeps graph filters populated" });

    // SSE server polls the log ~1s; the new item should appear at the top shortly.
    const top = feed.locator(".activity-item").first();
    await expect(top).toContainText(uniqueQuery, { timeout: 6_000 });
    await expect(top.locator(".activity-loc")).toHaveText("repo-b/FINDINGS.md");
    await expect(feed.locator(".activity-item")).toHaveCount(before + 1);
  });

  test("recovers the live stream after a page reload", async ({ page }) => {
    await openActivityTab(page);
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("button.nav-item").filter({ hasText: "Activity" }).click();
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });

    const feed = page.locator("#activity-feed");
    const uniqueQuery = `reconnect-probe-${Date.now()}`;
    appendLookup({ query: uniqueQuery, project: "repo-a", filename: "summary.md", type: "summary" });
    await expect(feed.locator(".activity-item").first()).toContainText(uniqueQuery, { timeout: 6_000 });
  });
});
