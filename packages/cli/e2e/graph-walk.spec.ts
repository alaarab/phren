import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createWebUiHarness, type WebUiHarness } from "./web-ui-harness";

let harness: WebUiHarness;

function appendLookup(ev: Record<string, unknown>): void {
  const p = path.join(harness.phrenDir, ".runtime", "lookup-events.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), source: "search", ...ev }) + "\n");
}

async function stub(page: Page): Promise<void> {
  await page.route("https://cdn.jsdelivr.net/npm/marked@12/marked.min.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "window.marked={parse(v){return String(v);}};" }));
  await page.route("https://fonts.bunny.net/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
}

async function openGraph(page: Page): Promise<void> {
  await stub(page);
  await page.goto(harness.secureUrl, { waitUntil: "domcontentloaded" });
  await page.locator("button.nav-item").filter({ hasText: "Graph" }).click();
  await expect(page.locator("#graph-canvas")).toBeVisible();
  // Wait for the Sigma runtime to mount with real nodes.
  await page.waitForFunction(() => {
    const g = (window as unknown as { phrenGraph?: { __renderer?: string; getData?: () => { nodes: unknown[] } } }).phrenGraph;
    return !!g && g.__renderer === "sigma" && !!g.getData && g.getData().nodes.length > 0;
  }, undefined, { timeout: 15_000 });
}

test.describe.serial("web-ui graph walk (phren follows the live feed)", () => {
  test.beforeAll(async () => { harness = await createWebUiHarness(); });
  test.afterAll(async () => { await harness.cleanup(); });

  test("exposes a walkTo API and renders the mascot overlay", async ({ page }) => {
    await openGraph(page);

    const hasWalkTo = await page.evaluate(() => typeof (window as unknown as { phrenGraph?: { walkTo?: unknown } }).phrenGraph?.walkTo === "function");
    expect(hasWalkTo).toBe(true);

    // The mascot runs on an overlay <canvas> appended inside #graph-canvas.
    await expect.poll(async () => page.locator("#graph-canvas canvas").count(), { timeout: 5_000 }).toBeGreaterThan(1);
  });

  test("a live lookup sends phren walking to the matching node", async ({ page }) => {
    await openGraph(page);

    // Spy on walkTo so we can assert the feed drives it to the right node.
    await page.evaluate(() => {
      const g = (window as unknown as { phrenGraph: { walkTo: (id: string) => boolean; __walk?: string[] } }).phrenGraph;
      const orig = g.walkTo.bind(g);
      (g as { __walk?: string[] }).__walk = [];
      g.walkTo = (id: string) => { (g as { __walk?: string[] }).__walk!.push(id); return orig(id); };
    });

    // Confirm the activity SSE is connected (it drives the phren:lookup event).
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });

    appendLookup({ query: "redis caching", project: "repo-a", filename: "FINDINGS.md", type: "findings", snippet: "Redis caching uses a TTL of 300 seconds." });

    await page.waitForFunction(() => {
      const w = (window as unknown as { phrenGraph?: { __walk?: string[] } }).phrenGraph?.__walk;
      return !!w && w.length > 0;
    }, undefined, { timeout: 8_000 });

    const walked = await page.evaluate(() => (window as unknown as { phrenGraph: { __walk: string[] } }).phrenGraph.__walk);
    // The project node id equals the project name — the reliable hop target.
    expect(walked).toContain("repo-a");
  });

  test("walks to a specific finding node when the event carries a nodeId", async ({ page }) => {
    await openGraph(page);

    await page.evaluate(() => {
      const g = (window as unknown as { phrenGraph: { walkTo: (id: string) => boolean; __walk?: string[] } }).phrenGraph;
      const orig = g.walkTo.bind(g);
      (g as { __walk?: string[] }).__walk = [];
      g.walkTo = (id: string) => { (g as { __walk?: string[] }).__walk!.push(id); return orig(id); };
    });
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });

    // Grab a real finding node id from the live graph and feed it through.
    const findingId = await page.evaluate(() => {
      const nodes = (window as unknown as { phrenGraph: { getData: () => { nodes: Array<{ id: string }> } } }).phrenGraph.getData().nodes;
      const f = nodes.find((n) => String(n.id).indexOf("finding:") === 0);
      return f ? f.id : null;
    });
    expect(findingId).toBeTruthy();

    appendLookup({ query: "anything", project: "repo-a", filename: "FINDINGS.md", type: "findings", nodeId: findingId as string });

    await page.waitForFunction(
      (id) => {
        const w = (window as unknown as { phrenGraph?: { __walk?: string[] } }).phrenGraph?.__walk;
        return !!w && w.indexOf(id as string) !== -1;
      },
      findingId,
      { timeout: 8_000 },
    );
  });
});
