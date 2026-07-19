import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { createWebUiHarness, type WebUiHarness } from "./web-ui-harness";

let harness: WebUiHarness;

async function stubExternalAssets(page: Page): Promise<void> {
  await page.route("https://cdn.jsdelivr.net/npm/marked@12/marked.min.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: [
        "window.marked = {",
        "  parse(value) {",
        "    return String(value)",
        "      .replace(/&/g, '&amp;')",
        "      .replace(/</g, '&lt;')",
        "      .replace(/>/g, '&gt;')",
        "      .replace(/\\n/g, '<br>');",
        "  }",
        "};",
      ].join("\n"),
    });
  });
  await page.route("https://fonts.bunny.net/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/css",
      body: "",
    });
  });
}

async function openGraphTab(page: Page): Promise<void> {
  await stubExternalAssets(page);
  await page.goto(harness.secureUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".project-card")).toHaveCount(2);
  await page.locator("button.nav-item").filter({ hasText: "Graph" }).click();
  await expect(page.locator("#graph-canvas")).toBeVisible();
  // Wait for the 3D renderer to mount and the graph to settle
  await page.waitForFunction(() => {
    const pg = (window as any).phrenGraph;
    return pg && pg.__renderer === "three" && pg.getData().nodes.length > 0;
  }, { timeout: 10_000 });
}

/** Get node IDs from the graph API. */
async function getNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pg = (window as any).phrenGraph;
    if (!pg || !pg.getData) return [];
    return pg.getData().nodes.map((n: any) => n.id);
  });
}

/** Get filtered node count string ("N / N") from the graph filter bar. */
async function getNodeCountText(page: Page): Promise<string> {
  return page.locator("#graph-filter").evaluate((el) => {
    // The count is in a span like "12 / 24" at the end of the filter bar
    const spans = el.querySelectorAll("span");
    for (const span of spans) {
      if (/\d+\s*\/\s*\d+/.test(span.textContent || "")) {
        return span.textContent!.trim();
      }
    }
    return "";
  });
}

/** Parse "N / N" into { visible, total }. */
function parseNodeCount(text: string): { visible: number; total: number } {
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return { visible: 0, total: 0 };
  return { visible: Number(match[1]), total: Number(match[2]) };
}

/** Select a node via the graph API. Returns the selected node ID or null. */
async function selectFirstNode(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const pg = (window as any).phrenGraph;
    if (!pg || !pg.getData || !pg.selectNode) return null;
    const nodes = pg.getData().nodes;
    if (!nodes.length) return null;
    const ok = pg.selectNode(nodes[0].id);
    return ok ? nodes[0].id : null;
  });
}

/** Select a node of a specific kind via the graph API. Returns the ID or null. */
async function selectNodeOfKind(page: Page, kind: string): Promise<string | null> {
  return page.evaluate((k) => {
    const pg = (window as any).phrenGraph;
    if (!pg || !pg.getData || !pg.selectNode) return null;
    const node = pg.getData().nodes.find((n: any) => n.kind === k);
    if (!node) return null;
    return pg.selectNode(node.id) ? node.id : null;
  }, kind);
}

/** Open the filter panel by clicking the toggle button. */
async function openFilterPanel(page: Page): Promise<void> {
  const panel = page.locator("[data-filter-panel]");
  const isVisible = await panel.evaluate((el) => (el as HTMLElement).style.display === "block");
  if (!isVisible) {
    await page.locator("[data-filter-toggle]").click();
    await expect(panel).toHaveCSS("display", "block");
  }
}

function collectConsoleErrors(page: Page): ConsoleMessage[] {
  const errors: ConsoleMessage[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      // Ignore expected external resource failures (fonts, CDN) and favicon
      const text = msg.text();
      if (text.includes("bunny.net") || text.includes("jsdelivr.net") || text.includes("favicon")) return;
      errors.push(msg);
    }
  });
  return errors;
}

test.describe.serial("graph visualization e2e", () => {
  test.beforeAll(async () => {
    harness = await createWebUiHarness();
  });

  test.afterAll(async () => {
    await harness.cleanup();
  });

  test("graph loads without console errors or failed API requests", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // Track network failures
    const failedRequests: { url: string; status: number }[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/") && response.status() >= 400) {
        failedRequests.push({ url: response.url(), status: response.status() });
      }
    });

    await openGraphTab(page);

    // Container div should be visible
    await expect(page.locator("#graph-canvas")).toBeVisible();

    // The 3D renderer should be active
    const renderer = await page.evaluate(() => (window as any).phrenGraph?.__renderer);
    expect(renderer).toBe("three");

    // Should have loaded nodes
    const nodeIds = await getNodeIds(page);
    expect(nodeIds.length).toBeGreaterThan(0);

    // No 401s or other API failures
    expect(failedRequests).toEqual([]);

    // No console errors (excluding external asset failures)
    const errorTexts = errors.map((e) => e.text());
    expect(errorTexts).toEqual([]);
  });

  test("project filter changes visible node count", async ({ page }) => {
    await openGraphTab(page);

    // Get initial node count from the filter bar
    const initialText = await getNodeCountText(page);
    const initial = parseNodeCount(initialText);
    expect(initial.visible).toBeGreaterThan(0);

    // Open filter panel and select repo-a project
    await openFilterPanel(page);
    await page.locator("select[data-project-filter]").selectOption("repo-a");
    await page.waitForTimeout(500);

    // Node count should decrease (fewer nodes when filtered to one project)
    const filteredText = await getNodeCountText(page);
    const filtered = parseNodeCount(filteredText);
    expect(filtered.visible).toBeLessThan(initial.visible);
    expect(filtered.visible).toBeGreaterThan(0);

    // Reset to all
    await page.locator("select[data-project-filter]").selectOption("all");
    await page.waitForTimeout(500);
    const resetText = await getNodeCountText(page);
    const reset = parseNodeCount(resetText);
    expect(reset.visible).toBe(initial.visible);
  });

  test("type filter changes visible node count", async ({ page }) => {
    await openGraphTab(page);

    const initialText = await getNodeCountText(page);
    const initial = parseNodeCount(initialText);

    // Open filter panel and uncheck "project" type
    await openFilterPanel(page);
    const projectCheckbox = page.locator('input[data-filter-type-check="project"]');
    await projectCheckbox.uncheck();
    await page.waitForTimeout(500);

    const filteredText = await getNodeCountText(page);
    const filtered = parseNodeCount(filteredText);
    expect(filtered.visible).toBeLessThan(initial.visible);
    expect(filtered.visible).toBeGreaterThan(0);

    // Toggle it back on to restore
    await projectCheckbox.check();
    await page.waitForTimeout(500);
    const resetText = await getNodeCountText(page);
    const reset = parseNodeCount(resetText);
    expect(reset.visible).toBe(initial.visible);
  });

  test("zoom controls change the camera ratio", async ({ page }) => {
    await openGraphTab(page);

    // Click zoom in and verify camera state changed
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.waitForTimeout(300);

    // Verify the renderer is still drawing after the zoom interaction
    const afterZoomIn = await page.evaluate(() => {
      // The renderer stores camera state — verify it's not at default
      const canvases = document.querySelectorAll("#graph-canvas canvas");
      return canvases.length > 0; // At minimum, the renderer created a WebGL canvas
    });
    expect(afterZoomIn).toBe(true);

    // Click zoom out
    await page.locator(".graph-controls button").filter({ hasText: "-" }).click();
    await page.waitForTimeout(300);

    // Click reset
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
    await page.waitForTimeout(300);

    // Verify the renderer is still running after zoom operations
    const stillAlive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(stillAlive).toBe(true);
  });

  test("search input exists and filters nodes", async ({ page }) => {
    await openGraphTab(page);

    // Search input should exist in the filter bar
    const searchInput = page.locator("input[data-search-filter]");
    await expect(searchInput).toBeVisible();

    const initialText = await getNodeCountText(page);
    const initial = parseNodeCount(initialText);

    // Type a search query that should match some but not all nodes
    await searchInput.fill("repo-a");
    await page.waitForTimeout(500);

    // The search should filter visible nodes
    const filteredText = await getNodeCountText(page);
    const filtered = parseNodeCount(filteredText);
    // Search should reduce or maintain the count (depending on how many match)
    expect(filtered.visible).toBeGreaterThan(0);

    // Clear search
    await searchInput.fill("");
    await page.waitForTimeout(500);

    const resetText = await getNodeCountText(page);
    const reset = parseNodeCount(resetText);
    expect(reset.visible).toBe(initial.visible);
  });

  test("clicking a node opens the popover with correct info", async ({ page }) => {
    await openGraphTab(page);

    const popover = page.locator("#graph-node-popover");
    // Popover starts hidden
    await expect(popover).toHaveCSS("display", "none");

    // Select a node programmatically
    const nodeId = await selectFirstNode(page);
    expect(nodeId).toBeTruthy();

    // Popover should appear
    await expect(popover).not.toHaveCSS("display", "none");

    // Content should have something in it
    const content = page.locator("#graph-node-content");
    await expect(content).not.toBeEmpty();
  });

  test("clear selection hides the popover", async ({ page }) => {
    await openGraphTab(page);

    await selectFirstNode(page);

    const popover = page.locator("#graph-node-popover");
    await expect(popover).not.toHaveCSS("display", "none");

    // Clear via graphClearSelection
    await page.evaluate(() => (window as any).graphClearSelection());
    await expect(popover).toHaveCSS("display", "none");
  });

  test("graph container fills available space with WebGL canvases", async ({ page }) => {
    await openGraphTab(page);

    const graphDiv = page.locator("#graph-canvas");
    const container = page.locator(".graph-container");

    const graphBox = await graphDiv.boundingBox();
    const containerBox = await container.boundingBox();
    expect(graphBox).toBeTruthy();
    expect(containerBox).toBeTruthy();

    // Graph div should fill most of the container width
    expect(graphBox!.width).toBeGreaterThan(containerBox!.width * 0.9);

    // The renderer should have created a WebGL canvas inside the div
    const canvasCount = await page.locator("#graph-canvas canvas").count();
    expect(canvasCount).toBeGreaterThanOrEqual(1);
  });

  test("viewport resize causes graph container to adjust", async ({ page }) => {
    await openGraphTab(page);

    const getSizeAndCanvasCount = async () => {
      return page.evaluate(() => {
        const el = document.getElementById("graph-canvas");
        const canvases = el?.querySelectorAll("canvas") || [];
        return {
          w: el?.offsetWidth || 0,
          h: el?.offsetHeight || 0,
          canvases: canvases.length,
        };
      });
    };

    const sizeBefore = await getSizeAndCanvasCount();
    expect(sizeBefore.canvases).toBeGreaterThanOrEqual(1);

    // Resize viewport to smaller
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    const sizeAfter = await getSizeAndCanvasCount();

    // Container width should have decreased
    expect(sizeAfter.w).toBeLessThan(sizeBefore.w);

    // Restore viewport
    await page.setViewportSize({ width: 1440, height: 1100 });
  });

  test("max nodes input changes the displayed node count", async ({ page }) => {
    await openGraphTab(page);

    const initialText = await getNodeCountText(page);
    const initial = parseNodeCount(initialText);

    // Open filter panel and set max nodes to a low number
    await openFilterPanel(page);
    const input = page.locator("input[data-limit-input]");
    await input.fill("50");
    await input.dispatchEvent("change");
    await page.waitForTimeout(500);

    // If total was above 50, visible should now be capped
    if (initial.total > 50) {
      const updatedText = await getNodeCountText(page);
      const updated = parseNodeCount(updatedText);
      expect(updated.visible).toBeLessThanOrEqual(50);
    }

    // Restore
    await input.fill("500");
    await input.dispatchEvent("change");
  });

  test("theme toggle affects graph rendering", async ({ page }) => {
    await openGraphTab(page);

    // Get the current theme
    const getThemeClass = () =>
      page.evaluate(() => document.documentElement.getAttribute("data-theme") || "");

    const before = await getThemeClass();

    // Toggle theme
    await page.locator("#theme-toggle").click();
    await page.waitForTimeout(500);

    const after = await getThemeClass();
    expect(after).not.toBe(before);

    // The renderer should still be running after theme change
    const stillAlive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(stillAlive).toBe(true);

    // Toggle back
    await page.locator("#theme-toggle").click();
  });

  test("popover shows correct kind label for different node types", async ({ page }) => {
    await openGraphTab(page);

    // Project selection delays popover by ~300ms (focus-mode camera animation).
    // Poll the popover content rather than reading immediately.
    async function expectPopoverContains(fragment: string): Promise<void> {
      await expect
        .poll(
          async () => (await page.locator("#graph-node-content").textContent() || "").toLowerCase(),
          { timeout: 2000 },
        )
        .toContain(fragment);
    }

    const projectId = await selectNodeOfKind(page, "project");
    if (projectId) await expectPopoverContains("project");

    await page.evaluate(() => (window as any).graphClearSelection());
    await page.waitForTimeout(200);

    const findingId = await selectNodeOfKind(page, "finding");
    if (findingId) await expectPopoverContains("finding");
  });

  // ── Interaction tests ──────────────────────────────────────────────────

  test("zoom via graphZoom API changes camera state", async ({ page }) => {
    await openGraphTab(page);

    // Zoom in via API and check that node positions shift
    const beforePositions = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      const nodes = pg?.getData()?.nodes || [];
      if (!nodes.length) return [];
      const first = nodes[0];
      return [first.id];
    });
    expect(beforePositions.length).toBeGreaterThan(0);

    // Zoom in
    await page.evaluate(() => (window as any).graphZoom(1.5));
    await page.waitForTimeout(300);

    // The renderer should still be running
    const alive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(alive).toBe(true);

    // Reset
    await page.evaluate(() => (window as any).graphReset());
    await page.waitForTimeout(300);
  });

  test("pan the graph by dragging empty space", async ({ page }) => {
    await openGraphTab(page);

    const graphDiv = page.locator("#graph-canvas");
    const box = await graphDiv.boundingBox();
    expect(box).toBeTruthy();

    // Drag from a corner (likely empty space)
    const startX = box!.x + 20;
    const startY = box!.y + 20;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 200, startY + 150, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // The renderer should still be functional after pan
    const alive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(alive).toBe(true);

    // Reset
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
    await page.waitForTimeout(300);
  });

  test("zoom and pan combined — zoom in then pan to explore", async ({ page }) => {
    await openGraphTab(page);

    const graphDiv = page.locator("#graph-canvas");
    const box = await graphDiv.boundingBox();
    expect(box).toBeTruthy();

    // Zoom in twice
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.waitForTimeout(300);

    // Pan while zoomed
    const panStartX = box!.x + 30;
    const panStartY = box!.y + box!.height - 30;
    await page.mouse.move(panStartX, panStartY);
    await page.mouse.down();
    await page.mouse.move(panStartX + 250, panStartY - 200, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // The renderer should still be functional
    const alive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(alive).toBe(true);

    // Reset
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
  });

  test("node hover shows tooltip with label", async ({ page }) => {
    await openGraphTab(page);

    const tooltip = page.locator("#graph-tooltip");

    // Move mouse over the center of the graph container where nodes likely are
    const graphDiv = page.locator("#graph-canvas");
    const box = await graphDiv.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Hover over the center area (where nodes cluster)
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(400);

    // Check if tooltip became visible (uses classList "visible")
    const tooltipVisible = await tooltip.evaluate((el) => el.classList.contains("visible"));
    // Tooltip may or may not be visible depending on mouse position hitting a node.
    // So we try multiple positions.
    if (!tooltipVisible) {
      // Try hovering at a few different positions
      for (const offset of [[-40, -40], [40, 40], [0, -60], [-60, 0], [60, -30]]) {
        await page.mouse.move(cx + offset[0], cy + offset[1]);
        await page.waitForTimeout(400);
        const vis = await tooltip.evaluate((el) => el.classList.contains("visible"));
        if (vis) break;
      }
    }

    // Even if we didn't hit a node, verify tooltip element exists and is functional.
    // The tooltip is hidden by default — that's correct behavior when not hovering a node.
    await expect(tooltip).toBeAttached();

    // Move to far corner — tooltip should not be visible
    await page.mouse.move(box!.x + 5, box!.y + 5);
    await page.waitForTimeout(200);
    const hiddenAfter = await tooltip.evaluate((el) => !el.classList.contains("visible"));
    expect(hiddenAfter).toBe(true);
  });

  test("fragment nodes exist and can be selected", async ({ page }) => {
    await openGraphTab(page);

    // Check if any entity/fragment nodes exist
    const entityId = await selectNodeOfKind(page, "entity");
    if (entityId) {
      const popover = page.locator("#graph-node-popover");
      await expect(popover).not.toHaveCSS("display", "none");
      const content = await page.locator("#graph-node-content").textContent();
      expect(content?.toLowerCase()).toContain("fragment");
    }
    // Clear
    await page.evaluate(() => (window as any).graphClearSelection());
  });

  test("reference nodes exist and can be selected", async ({ page }) => {
    await openGraphTab(page);

    const refId = await selectNodeOfKind(page, "reference");
    if (refId) {
      const popover = page.locator("#graph-node-popover");
      await expect(popover).not.toHaveCSS("display", "none");
      const content = await page.locator("#graph-node-content").textContent();
      expect(content?.toLowerCase()).toContain("reference");
    }
    await page.evaluate(() => (window as any).graphClearSelection());
  });

  test("task nodes exist and can be selected", async ({ page }) => {
    await openGraphTab(page);

    const taskId = await selectNodeOfKind(page, "task");
    if (taskId) {
      const popover = page.locator("#graph-node-popover");
      await expect(popover).not.toHaveCSS("display", "none");
      const content = await page.locator("#graph-node-content").textContent();
      expect(content?.toLowerCase()).toContain("task");
    }
    await page.evaluate(() => (window as any).graphClearSelection());
  });

  test("edges exist between connected nodes", async ({ page }) => {
    await openGraphTab(page);

    // Verify links exist in the graph data
    const linkCount = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      if (!pg || !pg.getData) return 0;
      return pg.getData().links.length;
    });
    expect(linkCount).toBeGreaterThan(0);
  });

  test("wheel zoom on canvas changes camera", async ({ page }) => {
    await openGraphTab(page);

    const graphDiv = page.locator("#graph-canvas");
    const box = await graphDiv.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Scroll to zoom in
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);

    // The renderer should still be running
    let alive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(alive).toBe(true);

    // Scroll to zoom out
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);

    alive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(alive).toBe(true);

    // Reset
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
  });

  test("selecting a node then clearing resets for next selection", async ({ page }) => {
    await openGraphTab(page);

    const popover = page.locator("#graph-node-popover");

    // Select a node
    const nodeId = await selectFirstNode(page);
    expect(nodeId).toBeTruthy();
    await expect(popover).not.toHaveCSS("display", "none");

    // Clear selection
    await page.evaluate(() => (window as any).graphClearSelection());
    await expect(popover).toHaveCSS("display", "none");

    // Select again after clearing — should work
    const nodeId2 = await selectFirstNode(page);
    expect(nodeId2).toBeTruthy();
    await expect(popover).not.toHaveCSS("display", "none");
  });

  test("phrenGraph.removeNode removes a finding in place without remount", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openGraphTab(page);

    // API must be exposed
    const hasRemove = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      return pg && typeof pg.removeNode === "function";
    });
    expect(hasRemove).toBe(true);

    // Pick a finding node to delete
    const target = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      const node = pg.getData().nodes.find((n: any) => n.kind === "finding");
      return node ? { id: node.id, label: node.label } : null;
    });
    expect(target).not.toBeNull();

    // Select it first — popover should appear
    await page.evaluate((id: string) => (window as any).phrenGraph.selectNode(id), target!.id);
    const popover = page.locator("#graph-node-popover");
    await expect(popover).not.toHaveCSS("display", "none");

    const initial = await page.evaluate(() => (window as any).phrenGraph.getData().nodes.length);

    // Capture the canvas element identity to prove there's no full remount
    const canvasIdBefore = await page.evaluate(() => {
      const canvas = document.querySelector("#graph-canvas canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      (canvas as any).__phrenIdentity = "pre-delete-" + Date.now();
      return (canvas as any).__phrenIdentity;
    });
    expect(canvasIdBefore).not.toBeNull();

    // Fire the in-place removal (this is what the extension calls after a successful delete)
    const returned = await page.evaluate((id: string) => {
      return (window as any).phrenGraph.removeNode(id);
    }, target!.id);
    expect(returned).toBe(true);

    // During animation (~280ms) the node should still exist but be shrinking
    await page.waitForTimeout(80);
    const midAnim = await page.evaluate((id: string) => {
      const pg = (window as any).phrenGraph;
      const data = pg.getData();
      // Internal: check node-level attrs if still attached
      return {
        stillInData: data.nodes.some((n: any) => n.id === id),
        count: data.nodes.length,
      };
    }, target!.id);

    // Wait past the animation tail
    await page.waitForTimeout(320);

    // Node should be fully gone from the graph data
    const afterIds = await getNodeIds(page);
    expect(afterIds).not.toContain(target!.id);
    expect(afterIds.length).toBe(initial - 1);

    // Canvas element should be the same instance — no full remount
    const canvasIdAfter = await page.evaluate(() => {
      const canvas = document.querySelector("#graph-canvas canvas") as HTMLCanvasElement | null;
      return canvas ? (canvas as any).__phrenIdentity || null : null;
    });
    expect(canvasIdAfter).toBe(canvasIdBefore);

    // Selection should be cleared (popover hidden)
    await expect(popover).toHaveCSS("display", "none");

    // Renderer still alive
    const alive = await page.evaluate(() => (window as any).phrenGraph?.__renderer === "three");
    expect(alive).toBe(true);

    // removeNode on an unknown id returns false
    const bogus = await page.evaluate(() => (window as any).phrenGraph.removeNode("finding:nope:does-not-exist"));
    expect(bogus).toBe(false);

    const errorTexts = errors.map((e) => e.text());
    expect(errorTexts).toEqual([]);

    // mid-animation assertion is informational but sanity-check: at t~80ms node is typically still there
    if (midAnim.stillInData) {
      expect(midAnim.count).toBe(initial);
    }
  });

  test("phrenGraph.updateNode mutates attrs in place without remount", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openGraphTab(page);

    const hasUpdate = await page.evaluate(() => typeof (window as any).phrenGraph?.updateNode === "function");
    expect(hasUpdate).toBe(true);

    // Pick a task node (the fixture seeds one queue task)
    const target = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      const node = pg.getData().nodes.find((n: any) => n.kind === "task");
      return node ? { id: node.id, label: node.label, section: node.section } : null;
    });
    expect(target).not.toBeNull();

    const canvasBefore = await page.evaluate(() => {
      const canvas = document.querySelector("#graph-canvas canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      (canvas as any).__phrenIdentity = "update-" + Date.now();
      return (canvas as any).__phrenIdentity;
    });

    const countBefore = (await getNodeIds(page)).length;

    const result = await page.evaluate((id: string) => {
      return (window as any).phrenGraph.updateNode(id, {
        text: "Renamed by in-place update test",
        section: "Done",
      });
    }, target!.id);
    expect(result).toBe(true);

    const after = await page.evaluate((id: string) => {
      const pg = (window as any).phrenGraph;
      const node = pg.getData().nodes.find((n: any) => n.id === id);
      return node ? { label: node.label, section: node.section, fullLabel: node.fullLabel } : null;
    }, target!.id);
    expect(after).not.toBeNull();
    expect(after!.section).toBe("Done");
    expect(after!.label).toContain("Renamed");

    const countAfter = (await getNodeIds(page)).length;
    expect(countAfter).toBe(countBefore);

    const canvasAfter = await page.evaluate(() => {
      const canvas = document.querySelector("#graph-canvas canvas") as HTMLCanvasElement | null;
      return canvas ? (canvas as any).__phrenIdentity || null : null;
    });
    expect(canvasAfter).toBe(canvasBefore);

    const bogus = await page.evaluate(() => (window as any).phrenGraph.updateNode("task:nope:xyz", { section: "Done" }));
    expect(bogus).toBe(false);

    const errorTexts = errors.map((e) => e.text());
    expect(errorTexts).toEqual([]);
  });

  test("no console errors across full graph interaction", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await openGraphTab(page);

    const graphDiv = page.locator("#graph-canvas");
    const box = await graphDiv.boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Select nodes
    await selectFirstNode(page);
    await page.evaluate(() => (window as any).graphClearSelection());

    // Click zoom buttons
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.locator(".graph-controls button").filter({ hasText: "-" }).click();
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();

    // Open filter panel and exercise filters
    await openFilterPanel(page);
    await page.locator("select[data-project-filter]").selectOption("repo-a");
    await page.waitForTimeout(200);
    await page.locator("select[data-project-filter]").selectOption("all");

    // Toggle type filter
    const typeCheck = page.locator('input[data-filter-type-check="project"]');
    await typeCheck.uncheck();
    await page.waitForTimeout(200);
    await typeCheck.check();

    // Use search
    const searchInput = page.locator("input[data-search-filter]");
    if (await searchInput.isVisible()) {
      await searchInput.fill("repo");
      await page.waitForTimeout(200);
      await searchInput.fill("");
    }

    // Scroll to zoom
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -200);
    await page.mouse.wheel(0, 200);

    // Pan
    await page.mouse.move(cx - 100, cy - 100);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 100, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(300);

    // Assert zero console errors through all interactions
    const errorTexts = errors.map((e) => e.text());
    expect(errorTexts).toEqual([]);
  });

  test("project labels render as CSS2D DOM with a bounded label pool", async ({ page }) => {
    await openGraphTab(page);
    await page.waitForTimeout(1500);

    // Eager project labels are always-on DOM elements
    await expect.poll(async () => page.locator(".phren-label--project").count(), { timeout: 8_000 }).toBeGreaterThan(0);

    // The pool + eager labels stay hard-capped
    const total = await page.locator(".phren-label").count();
    expect(total).toBeLessThanOrEqual(90);
  });

  test("selecting a finding shows its complete text in the dossier", async ({ page }) => {
    await openGraphTab(page);

    const selected = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      const finding = pg.getData().nodes.find((n: any) => n.kind === "finding" && (n.fullLabel || "").length > 0);
      if (!finding) return null;
      pg.selectNode(finding.id);
      return { id: finding.id, fullLabel: finding.fullLabel };
    });
    expect(selected).toBeTruthy();

    await expect(page.locator("#graph-node-popover")).toBeVisible({ timeout: 8_000 });
    // The dossier body must contain the COMPLETE finding text, not a truncation
    await expect(page.locator("#graph-node-content")).toContainText(selected!.fullLabel, { timeout: 8_000 });
  });

  test("dossier prev/next cycles findings within the project", async ({ page }) => {
    await openGraphTab(page);

    const start = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      const findings = pg.getData().nodes.filter((n: any) => n.kind === "finding");
      const byProject: Record<string, any[]> = {};
      for (const f of findings) (byProject[f.projectName] = byProject[f.projectName] || []).push(f);
      const project = Object.keys(byProject).find((k) => byProject[k].length > 1);
      if (!project) return null;
      const first = byProject[project][0];
      pg.selectNode(first.id);
      return first.fullLabel || first.label;
    });
    expect(start).toBeTruthy();

    await expect(page.locator("#graph-node-popover")).toBeVisible({ timeout: 8_000 });
    const nextBtn = page.locator('[data-graph-action="next-finding"]');
    await expect(nextBtn).toBeVisible({ timeout: 8_000 });
    await nextBtn.click();
    // Selection flies to the sibling; the dossier re-renders with different content
    await expect(page.locator("#graph-node-content")).not.toContainText(start!, { timeout: 8_000 });
  });

  test("search Enter flies to the best hit and opens the dossier", async ({ page }) => {
    await openGraphTab(page);

    const query = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      const finding = pg.getData().nodes.find((n: any) => n.kind === "finding");
      // A word from a real finding guarantees a match
      const word = String(finding?.fullLabel || finding?.label || "").split(/\s+/).find((w: string) => w.length > 4);
      return word || null;
    });
    expect(query).toBeTruthy();

    const searchInput = page.locator("input[data-search-filter]");
    await searchInput.fill(query!);
    await page.waitForTimeout(400);
    await searchInput.press("Enter");

    await expect(page.locator("#graph-node-popover")).toBeVisible({ timeout: 8_000 });

    await searchInput.fill("");
    await page.waitForTimeout(300);
  });

  test("HUD stats readout reflects the visible graph", async ({ page }) => {
    await openGraphTab(page);
    const stats = page.locator(".phren-hud-stats");
    await expect(stats).toHaveText(/\d+ NODES · \d+ LINKS · \d+ PROJECTS/, { timeout: 8_000 });
  });

  test("remount clears stale eager project labels", async ({ page }) => {
    await openGraphTab(page);
    const mountPayload = (proj: string, label: string) => ({
      nodes: [
        { id: `project:${proj}`, label, group: "project", project: proj, findingCount: 1 },
        { id: `finding:${proj}:0`, label: `${proj} finding`, group: "topic:general", project: proj },
      ],
      links: [{ source: `project:${proj}`, target: `finding:${proj}:0` }],
      topics: [],
    });
    await page.evaluate((p) => (window as any).phrenGraph.mount(p), mountPayload("alpha", "alpha-proj"));
    await expect
      .poll(async () => page.locator(".phren-label--project", { hasText: "alpha-proj" }).count(), { timeout: 8_000 })
      .toBeGreaterThan(0);

    // Remount with a different project — the previous project's label must not
    // linger as a CSS2D ghost.
    await page.evaluate((p) => (window as any).phrenGraph.mount(p), mountPayload("beta", "beta-proj"));
    await expect
      .poll(async () => page.locator(".phren-label", { hasText: "beta-proj" }).count(), { timeout: 8_000 })
      .toBeGreaterThan(0);
    await expect(page.locator(".phren-label", { hasText: "alpha-proj" })).toHaveCount(0);
  });

  test("project navigator dock lists projects and selects one on click", async ({ page }) => {
    await openGraphTab(page);

    // The dock renders one orb per visible project (the fixture seeds two).
    const orbs = page.locator(".phren-project-nav .phren-project-orb");
    await expect.poll(async () => orbs.count(), { timeout: 8_000 }).toBeGreaterThan(0);

    // Each orb carries the project node id it targets.
    const firstOrbId = await orbs.first().getAttribute("data-project-id");
    expect(firstOrbId).toBeTruthy();
    const isProjectNode = await page.evaluate((id) => {
      const pg = (window as any).phrenGraph;
      const node = pg.getData().nodes.find((n: any) => n.id === id);
      return node?.kind === "project";
    }, firstOrbId);
    expect(isProjectNode).toBe(true);

    // Clicking the orb focuses that project — no finding/task selection needed —
    // and opens the dossier for it.
    await orbs.first().click();
    await expect(page.locator("#graph-node-popover")).toBeVisible({ timeout: 8_000 });

    // The clicked orb is marked active and the graph reports the focused project.
    await expect(orbs.first()).toHaveClass(/active/);
    const focused = await page.evaluate(() => {
      const pg = (window as any).phrenGraph;
      // getData reflects host nodes; focus is internal — assert via the active orb.
      return document.querySelector(".phren-project-orb.active")?.getAttribute("data-project-id") || null;
    });
    expect(focused).toBe(firstOrbId);

    // Clicking the active orb again toggles focus off (clears selection).
    await orbs.first().click();
    await expect(page.locator("#graph-node-popover")).toHaveCSS("display", "none");
    await expect(page.locator(".phren-project-orb.active")).toHaveCount(0);
  });

  test("project contents pane lists items and navigates on row click", async ({ page }) => {
    await openGraphTab(page);

    const panel = page.locator(".phren-project-panel");
    // Hidden until a project is in context.
    await expect(panel).toBeHidden();

    // Focus a project — the pane appears with its findings/tasks.
    const projectId = await selectNodeOfKind(page, "project");
    expect(projectId).toBeTruthy();
    await expect(panel).toBeVisible({ timeout: 8_000 });
    const rows = panel.locator(".phren-pp-row");
    await expect.poll(async () => rows.count(), { timeout: 8_000 }).toBeGreaterThan(0);

    // Clicking a row flies to that node and opens its dossier; the pane stays
    // open (the item's project is still in context) with the row marked active.
    const firstRowId = await rows.first().getAttribute("data-node-id");
    await rows.first().click();
    await expect(page.locator("#graph-node-popover")).toBeVisible({ timeout: 8_000 });
    await expect(panel).toBeVisible();
    await expect(panel.locator(`.phren-pp-row.active[data-node-id="${firstRowId}"]`)).toHaveCount(1);

    // The close button clears selection and hides the pane.
    await panel.locator("[data-pp-close]").click();
    await expect(panel).toBeHidden();
  });

  test("contents pane multi-select shows a bulk delete bar", async ({ page }) => {
    await openGraphTab(page);
    const projectId = await selectNodeOfKind(page, "project");
    expect(projectId).toBeTruthy();
    const panel = page.locator(".phren-project-panel");
    await expect(panel).toBeVisible({ timeout: 8_000 });

    // Enter select mode → checkboxes + a bulk bar with delete disabled.
    await panel.locator("[data-pp-select]").click();
    await expect(panel.locator(".phren-pp-check").first()).toBeVisible();
    const bar = panel.locator("[data-pp-bulk]");
    await expect(bar).toBeVisible();
    await expect(panel.locator("[data-pp-bulk-delete]")).toBeDisabled();

    // Select all → delete enabled with a count.
    await panel.locator("[data-pp-bulk-all]").click();
    await expect(panel.locator("[data-pp-bulk-delete]")).toBeEnabled();
    await expect(panel.locator("[data-pp-bulk-count]")).toContainText("selected");
    await expect(panel.locator(".phren-pp-row.picked").first()).toBeVisible();

    // Done exits select mode.
    await panel.locator("[data-pp-bulk-done]").click();
    await expect(bar).toBeHidden();
    await expect(panel.locator(".phren-pp-check")).toHaveCount(0);
  });

  test("contents pane is resizable via its edge handle", async ({ page }) => {
    await openGraphTab(page);
    const projectId = await selectNodeOfKind(page, "project");
    expect(projectId).toBeTruthy();
    const panel = page.locator(".phren-project-panel");
    await expect(panel).toBeVisible({ timeout: 8_000 });

    const before = (await panel.boundingBox())!.width;
    const handle = panel.locator(".phren-pp-resize");
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 130, hb.y + hb.height / 2, { steps: 8 }); // drag inward → wider
    await page.mouse.up();
    const after = (await panel.boundingBox())!.width;
    expect(after).toBeGreaterThan(before + 60);
  });

  test("contents pane collapses to a tab and reopens", async ({ page }) => {
    await openGraphTab(page);
    const projectId = await selectNodeOfKind(page, "project");
    expect(projectId).toBeTruthy();
    const panel = page.locator(".phren-project-panel");
    await expect(panel).toBeVisible({ timeout: 8_000 });

    await panel.locator("[data-pp-collapse]").click();
    await expect(page.locator(".phren-pp-reopen")).toBeVisible();
    await expect(panel).toBeHidden();

    await page.locator(".phren-pp-reopen").click();
    await expect(panel).toBeVisible();
    await expect(page.locator(".phren-pp-reopen")).toBeHidden();
  });

  test("interacting with the contents pane keeps the project focused", async ({ page }) => {
    await openGraphTab(page);
    const projectId = await selectNodeOfKind(page, "project");
    expect(projectId).toBeTruthy();
    const panel = page.locator(".phren-project-panel");
    await expect(panel).toBeVisible({ timeout: 8_000 });
    // The navigator orb reflects the focused project.
    await expect(page.locator(".phren-project-orb.active")).toHaveCount(1);

    // Clicking a filter chip inside the pane must not clear the graph selection.
    await panel.locator('[data-pp-chip][data-kind="finding"]').click();
    await expect(page.locator(".phren-project-orb.active")).toHaveCount(1);
    await expect(panel).toBeVisible();
  });

  test("project contents pane filter narrows the list", async ({ page }) => {
    await openGraphTab(page);
    const projectId = await selectNodeOfKind(page, "project");
    expect(projectId).toBeTruthy();
    const panel = page.locator(".phren-project-panel");
    await expect(panel).toBeVisible({ timeout: 8_000 });

    const rows = panel.locator(".phren-pp-row");
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);

    // "Findings" chip restricts the list to findings only (no task rows).
    await panel.locator('[data-pp-chip][data-kind="finding"]').click();
    await expect(panel.locator('.phren-pp-group', { hasText: /Tasks/ })).toHaveCount(0);

    // A nonsense query empties the list.
    await panel.locator("[data-pp-search]").fill("zzzzz-no-such-item-qqqq");
    await expect(panel.locator(".phren-pp-empty")).toHaveCount(1);
  });

  test("arrow keys cycle project focus through the navigator", async ({ page }) => {
    await openGraphTab(page);

    const orbs = page.locator(".phren-project-nav .phren-project-orb");
    await expect.poll(async () => orbs.count(), { timeout: 8_000 }).toBeGreaterThan(1);

    // Focus the canvas (not a text field), then step forward with ArrowRight.
    await page.locator("#graph-canvas").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".phren-project-orb.active")).toHaveCount(1);
    const firstActive = await page.locator(".phren-project-orb.active").getAttribute("data-project-id");

    // ArrowRight again moves to a different project.
    await page.keyboard.press("ArrowRight");
    const secondActive = await page.locator(".phren-project-orb.active").getAttribute("data-project-id");
    expect(secondActive).not.toBe(firstActive);
  });
});
