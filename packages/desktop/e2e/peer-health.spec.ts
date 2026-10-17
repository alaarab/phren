import { expect, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const DETAILS = {
  product: "phren-hook", computer: { name: "This computer" }, checkedAt: "2026-01-01T00:00:00Z",
  versions: [], stores: [], schedules: { running: true, lastRun: null }, push: { configured: false }, canary: null,
  peers: { configured: true, computers: [
    { name: "Studio", reachable: true, ms: 42, version: "0.3.49", listsBack: true },
    { name: "Laptop", reachable: false, ms: 5000, error: "No answer within 5 seconds.", listsBack: null },
    { name: "Mini", reachable: true, ms: 9, version: "0.3.20", listsBack: true },
  ] },
};

async function start(details: object = DETAILS) {
  let reads = 0;
  h = await startHarness("peer-health", {
    overviewFrames: [overviewFrame([chatRow("fix", "Fix login", "idle")])],
    routes: { "GET /v1/health/details": () => { reads += 1; return { json: details }; } },
  });
  return () => reads;
}

async function openComputers(page: import("@playwright/test").Page) {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Computers" }).click();
}

test("each computer card shows a chip per peer, with unreachable styled and the error in its tooltip", async ({ page }) => {
  const reads = await start();
  await openComputers(page);
  const chips = page.locator(".comp-card .comp-peer");
  await expect(chips).toHaveText(["Studio · 42 ms", "Laptop · unreachable", "Mini · Hook 0.3.20 (update available)"]);
  await expect(chips.nth(1)).toHaveClass(/fail/);
  await expect(chips.nth(1)).toHaveAttribute("title", "No answer within 5 seconds.");
  await expect(chips.nth(2)).toHaveClass(/warn/);
  await expect(chips.nth(0)).not.toHaveClass(/fail|warn/);
  // No polling: one read when shown, one more on Refresh.
  const first = reads();
  await page.waitForTimeout(600);
  expect(reads()).toBe(first);
  await page.locator(".comp-card .comp-head button", { hasText: "Refresh" }).click();
  await expect.poll(reads).toBeGreaterThan(first);
});

test("a computer whose health cannot be read says so inline", async ({ page }) => {
  h = await startHarness("peer-health-error", {
    overviewFrames: [overviewFrame([chatRow("fix", "Fix login", "idle")])],
    routes: { "GET /v1/health/details": () => ({ status: 500, json: { error: "Health unavailable" } }) },
  });
  await openComputers(page);
  await expect(page.locator(".comp-peer-error")).toContainText("Health unavailable");
});

test("the peer chips fit a 420px window", async ({ page }) => {
  await start();
  await page.setViewportSize({ width: 420, height: 800 });
  await openComputers(page);
  await expect(page.locator(".comp-card .comp-peer")).toHaveCount(3);
  const report = await page.evaluate(() => {
    const out: string[] = [];
    for (const e of document.querySelectorAll(".comp-peer-row, .comp-peer")) {
      const r = e.getBoundingClientRect();
      if (r.left < -0.5 || r.right > innerWidth + 0.5) out.push(`${e.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { out, scroll: document.scrollingElement!.scrollWidth, inner: innerWidth };
  });
  expect(report.out).toEqual([]);
  expect(report.scroll).toBeLessThanOrEqual(report.inner);
});
