/* eslint-disable */
// Local visual-iteration harness (CI-ignored via the `_` prefix). Mounts a rich
// synthetic graph payload, drives the UI into several states, and writes
// screenshots to SHOT_DIR so they can be eyeballed and iterated on.
//
// Run: SHOT_DIR=/tmp/shots npx playwright test --config playwright.local.config.ts _shots.spec.ts
import { test, type Page } from "@playwright/test";
import { createWebUiHarness, type WebUiHarness } from "./web-ui-harness";
import * as fs from "node:fs";

const SHOT_DIR = process.env.SHOT_DIR || "/tmp/shots";
let harness: WebUiHarness;

test.beforeAll(async () => {
  harness = await createWebUiHarness();
  fs.mkdirSync(SHOT_DIR, { recursive: true });
});
test.afterAll(async () => { await harness.cleanup(); });

async function openGraphTab(page: Page) {
  await page.route("https://fonts.bunny.net/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "window.marked={parse:(v)=>String(v)};" }));
  await page.goto(harness.secureUrl, { waitUntil: "domcontentloaded" });
  await page.locator("button.nav-item").filter({ hasText: "Graph" }).click();
  await page.waitForFunction(() => { const pg = (window as any).phrenGraph; return pg && pg.getData().nodes.length > 0; }, { timeout: 10000 });
}

// Build a rich payload in the page: several projects, many findings across
// topics, tasks, and a health spread driven by score lastUsedAt.
async function mountRichGraph(page: Page) {
  await page.evaluate(() => {
    const topics = [
      ["architecture", "Architecture"], ["debugging", "Debugging"], ["security", "Security"],
      ["performance", "Performance"], ["testing", "Testing"], ["api", "API"],
      ["database", "Database"], ["frontend", "Frontend"],
    ];
    const projects = ["web-app", "api-server", "data-pipeline", "mobile-client"];
    const nodes: any[] = [];
    const links: any[] = [];
    const scores: Record<string, any> = {};
    const now = Date.now();
    const ageDays = [4, 20, 80, 100, 200, 320]; // healthy, healthy, decaying, decaying, stale, stale
    let n = 0;
    projects.forEach((proj, pi) => {
      const findingCount = 10 + pi * 6;
      const taskCount = 4 + pi;
      nodes.push({ id: "project:" + proj, label: proj, group: "project", project: proj, findingCount, taskCount, refCount: findingCount });
      for (let i = 0; i < findingCount; i++) {
        const [slug, tlabel] = topics[(i + pi) % topics.length];
        const id = "finding:" + proj + ":" + i;
        const key = "k" + (n++);
        const age = ageDays[(i + pi) % ageDays.length];
        scores[key] = { lastUsedAt: new Date(now - age * 86400000).toISOString(), helpful: (i % 4), impressions: i };
        nodes.push({
          id, group: "topic:" + slug, project: proj, topicSlug: slug, topicLabel: tlabel, scoreKey: key,
          label: tlabel + " finding " + (i + 1) + " for " + proj,
          fullLabel: tlabel + " finding " + (i + 1) + " for " + proj + " — a representative memory describing the pattern, decision, or pitfall discovered while working on this area of the codebase.",
          date: "2026-0" + (1 + (i % 6)) + "-1" + (i % 9),
        });
        links.push({ source: "project:" + proj, target: id });
      }
      for (let t = 0; t < taskCount; t++) {
        const section = t % 3 === 0 ? "Active" : t % 3 === 1 ? "Queue" : "Done";
        const id = "task:" + proj + ":" + t;
        nodes.push({ id, group: "task-" + section.toLowerCase(), project: proj, section, priority: t % 2 ? "high" : "", label: "Task " + (t + 1) + " for " + proj, fullLabel: "Task " + (t + 1) + " for " + proj + " — something to do." });
        links.push({ source: "project:" + proj, target: id });
      }
    });
    (window as any).phrenGraph.mount({ nodes, links, scores, topics: topics.map(([slug, label]) => ({ slug, label })) });
  });
  await page.waitForTimeout(1200);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

test("capture UI states", async ({ page }) => {
  await openGraphTab(page);
  await mountRichGraph(page);
  await page.waitForTimeout(600);
  await shot(page, "01-overview");

  // Focus a project → navigator active + contents pane + dossier.
  await page.evaluate(() => (window as any).phrenGraph.selectNode("project:api-server"));
  await page.waitForTimeout(1200);
  await shot(page, "02-project-focused");

  // Keyboard cursor: focus the pane filter, arrow down into the list.
  await page.locator(".phren-project-panel [data-pp-search]").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  await shot(page, "02c-keyboard-cursor");

  // Sort by Recent.
  await page.locator(".phren-project-panel [data-pp-sort]").selectOption("recent").catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, "02b-sort-recent");
  await page.locator(".phren-project-panel [data-pp-sort]").selectOption("aging").catch(() => {});
  await page.waitForTimeout(200);

  // Hover a finding row to reveal the inline delete affordance.
  await page.locator(".phren-project-panel .phren-pp-row").nth(2).hover().catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, "03-row-hover-actions");

  // Aging filter in the pane.
  await page.locator('.phren-project-panel [data-pp-chip][data-health="aging"]').click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, "03b-pane-aging");

  // Select a finding within the project → dossier shows delete, pane stays.
  await page.evaluate(() => (window as any).phrenGraph.selectNode("finding:api-server:3"));
  await page.waitForTimeout(1000);
  await shot(page, "04-finding-selected");

  // Narrower viewport to check responsiveness.
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.waitForTimeout(600);
  await shot(page, "05-narrow");
});
