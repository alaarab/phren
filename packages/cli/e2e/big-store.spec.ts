import { test, expect, type Page } from "@playwright/test";
import { createBigStoreHarness, type BigStoreHarness } from "./big-store-harness";

let h: BigStoreHarness;

async function stub(page: Page): Promise<void> {
  await page.route("https://fonts.bunny.net/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://cdn.jsdelivr.net/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "window.marked={parse:function(v){return String(v);}};" }));
}

async function apiJson(page: Page, route: string): Promise<unknown> {
  return page.evaluate(async (args) => {
    const r = await fetch(args.base + args.route + (args.route.includes("?") ? "&" : "?") + "_auth=" + encodeURIComponent(args.tok));
    return r.json();
  }, { base: h.publicUrl, route, tok: h.authToken });
}

async function openGraph(page: Page): Promise<void> {
  await stub(page);
  await page.goto(h.secureUrl, { waitUntil: "domcontentloaded" });
  await page.locator("button.nav-item").filter({ hasText: "Graph" }).click();
  await page.waitForFunction(() => {
    const g = (window as unknown as { phrenGraph?: { __renderer?: string; getData?: () => { nodes: unknown[] } } }).phrenGraph;
    return !!g && g.__renderer === "three" && !!g.getData && g.getData().nodes.length > 0;
  }, undefined, { timeout: 25_000 });
}

test.describe.serial("web-ui against a large store", () => {
  test.beforeAll(async () => {
    h = await createBigStoreHarness();
    h.runSearches("all"); // authentic search_knowledge calls → real lookup events
  });
  test.afterAll(async () => { await h.cleanup(); });

  test("lists all seeded projects", async ({ page }) => {
    await stub(page);
    await page.goto(h.secureUrl, { waitUntil: "domcontentloaded" });
    const projects = (await apiJson(page, "/api/projects")) as unknown[];
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBe(10);
    await expect(page.locator(".project-card")).toHaveCount(10);
  });

  test("renders a large, well-formed knowledge graph", async ({ page }) => {
    await openGraph(page);
    const g = await page.evaluate(() => {
      const data = (window as unknown as { phrenGraph: { getData: () => { nodes: Array<{ group: string }>; links: unknown[] } } }).phrenGraph.getData();
      const groups: Record<string, number> = {};
      for (const n of data.nodes) {
        const k = String(n.group).split(":")[0];
        groups[k] = (groups[k] || 0) + 1;
      }
      return { nodes: data.nodes.length, links: data.links.length, groups };
    });
    expect(g.nodes).toBeGreaterThan(250);
    expect(g.links).toBeGreaterThan(200);
    expect(g.groups.project).toBe(10);
    expect(g.groups.reference).toBeGreaterThanOrEqual(30);
    expect(g.groups.topic).toBeGreaterThanOrEqual(150); // findings render as topic:* nodes
    expect((g.groups["task-active"] ?? 0) + (g.groups["task-queue"] ?? 0)).toBeGreaterThanOrEqual(40);
  });

  test("activity feed is populated with authentic lookups carrying finding nodeIds", async ({ page }) => {
    await stub(page);
    await page.goto(h.secureUrl, { waitUntil: "domcontentloaded" });
    const data = (await apiJson(page, "/api/lookups")) as { lookups: Array<{ source: string; nodeId?: string; project: string }> };
    expect(data.lookups.length).toBeGreaterThanOrEqual(30);
    expect(data.lookups.every((l) => l.source === "search")).toBe(true);
    expect(data.lookups.some((l) => typeof l.nodeId === "string" && l.nodeId.startsWith("finding:"))).toBe(true);

    await page.locator("button.nav-item").filter({ hasText: "Activity" }).click();
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });
    await expect(page.locator("#activity-feed .activity-item").first()).toBeVisible();
  });

  test("a live search sends phren walking to a real node on the dense graph", async ({ page }) => {
    await openGraph(page);
    await page.evaluate(() => {
      const g = (window as unknown as { phrenGraph: { walkTo: (id: string) => boolean; __walk?: string[] } }).phrenGraph;
      const orig = g.walkTo.bind(g);
      (g as { __walk?: string[] }).__walk = [];
      g.walkTo = (id: string) => { (g as { __walk?: string[] }).__walk!.push(id); return orig(id); };
    });
    await expect(page.locator("#activity-status")).toHaveText("Live", { timeout: 8_000 });

    h.runSearches("one", 0);

    await page.waitForFunction(() => {
      const g = (window as unknown as { phrenGraph?: { __walk?: string[]; getNodeDetail?: (id: string) => unknown } }).phrenGraph;
      const w = g?.__walk;
      return !!w && w.length > 0 && !!g?.getNodeDetail && !!g.getNodeDetail(w[w.length - 1]);
    }, undefined, { timeout: 10_000 });
  });
});
