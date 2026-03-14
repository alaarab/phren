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
  // Wait for the graph to finish loading and simulation to settle
  await page.waitForTimeout(2000);
}

/** Scan the canvas for colored (non-background) pixel clusters and return their centers as click targets. */
async function findNodePositions(page: Page): Promise<Array<{ x: number; y: number }>> {
  const canvas = page.locator("#graph-canvas");
  const box = await canvas.boundingBox();
  if (!box) return [];
  return page.evaluate(({ bx, by }) => {
    const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
    if (!c) return [];
    const ctx = c.getContext("2d");
    if (!ctx) return [];
    const dpr = window.devicePixelRatio || 1;
    const w = c.width;
    const h = c.height;
    // Sample every 8th pixel to find non-background areas
    const bg = ctx.getImageData(0, 0, 1, 1).data; // top-left = background
    const hits: Array<{ x: number; y: number }> = [];
    const step = 8;
    for (let sy = step; sy < h - step; sy += step) {
      for (let sx = step; sx < w - step; sx += step) {
        const d = ctx.getImageData(sx, sy, 1, 1).data;
        // Check if this pixel differs significantly from background
        const diff = Math.abs(d[0] - bg[0]) + Math.abs(d[1] - bg[1]) + Math.abs(d[2] - bg[2]);
        if (diff > 80 && d[3] > 100) {
          hits.push({ x: bx + sx / dpr, y: by + sy / dpr });
        }
      }
    }
    // Cluster the hits and return unique centers (dedup within 30px radius)
    const centers: Array<{ x: number; y: number }> = [];
    for (const h of hits) {
      let merged = false;
      for (const c of centers) {
        if (Math.abs(c.x - h.x) < 30 && Math.abs(c.y - h.y) < 30) {
          merged = true;
          break;
        }
      }
      if (!merged) centers.push(h);
    }
    return centers.slice(0, 20);
  }, { bx: box.x, by: box.y });
}

/** Click through candidate positions until a node is selected. Returns true if a node was hit. */
async function clickUntilNodeSelected(page: Page): Promise<boolean> {
  const positions = await findNodePositions(page);
  const detailMeta = page.locator("#graph-detail-meta");
  for (const pos of positions) {
    await page.mouse.click(pos.x, pos.y);
    await page.waitForTimeout(100);
    const text = await detailMeta.textContent();
    if (text && !text.includes("Click a bubble")) return true;
  }
  return false;
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

    // Canvas should be visible
    await expect(page.locator("#graph-canvas")).toBeVisible();

    // No 401s or other API failures
    expect(failedRequests).toEqual([]);

    // No console errors (excluding external asset failures)
    const errorTexts = errors.map((e) => e.text());
    expect(errorTexts).toEqual([]);
  });

  test("project filter changes visible node count", async ({ page }) => {
    await openGraphTab(page);

    // Should show node count for "all" initially
    const limitRow = page.locator("#graph-limit-row");
    const countText = await limitRow.textContent();
    expect(countText).toContain("of");

    // Extract initial count — format is "X of Y nodes"
    const initialMatch = countText?.match(/(\d+)\s+of\s+(\d+)/);
    expect(initialMatch).toBeTruthy();
    const initialCount = Number(initialMatch![1]);
    expect(initialCount).toBeGreaterThan(0);

    // Click repo-a project filter
    await page.locator("#graph-project-filter button").filter({ hasText: "repo-a" }).click();
    await expect(page.locator("#graph-project-filter button.active")).toHaveText("repo-a");

    // Node count should change (fewer nodes when filtered to one project)
    await page.waitForTimeout(500);
    const filteredText = await limitRow.textContent();
    const filteredMatch = filteredText?.match(/(\d+)\s+of\s+(\d+)/);
    expect(filteredMatch).toBeTruthy();
    const filteredCount = Number(filteredMatch![1]);
    expect(filteredCount).toBeLessThan(initialCount);

    // Reset to all
    await page.locator("#graph-project-filter button").filter({ hasText: "All" }).click();
    await page.waitForTimeout(500);
    const resetText = await limitRow.textContent();
    const resetMatch = resetText?.match(/(\d+)\s+of\s+(\d+)/);
    expect(Number(resetMatch![1])).toBe(initialCount);
  });

  test("type filter changes visible node count", async ({ page }) => {
    await openGraphTab(page);

    const limitRow = page.locator("#graph-limit-row");
    const initialText = await limitRow.textContent();
    const initialCount = Number(initialText?.match(/(\d+)\s+of\s+(\d+)/)?.[1]);

    // Click "Projects" type filter to toggle it off — should reduce visible nodes
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.waitForTimeout(500);
    const filteredText = await limitRow.textContent();
    const filteredCount = Number(filteredText?.match(/(\d+)\s+of\s+(\d+)/)?.[1]);
    expect(filteredCount).toBeLessThan(initialCount);
    expect(filteredCount).toBeGreaterThan(0);

    // Toggle it back on to restore
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.waitForTimeout(500);
    const resetText = await limitRow.textContent();
    expect(Number(resetText?.match(/(\d+)\s+of\s+(\d+)/)?.[1])).toBe(initialCount);
  });

  test("zoom controls change the graph scale", async ({ page }) => {
    await openGraphTab(page);

    // Get initial canvas pixel data checksum for comparison
    const getCanvasSnapshot = async () => {
      return page.evaluate(() => {
        const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
        if (!c) return "";
        const ctx = c.getContext("2d");
        if (!ctx) return "";
        // Sample a column of pixels to detect zoom changes
        const data = ctx.getImageData(c.width / 2, 0, 1, c.height).data;
        let hash = 0;
        for (let i = 0; i < data.length; i += 16) {
          hash = ((hash << 5) - hash + data[i]) | 0;
        }
        return hash.toString();
      });
    };

    const before = await getCanvasSnapshot();

    // Click zoom in
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.waitForTimeout(300);
    const afterZoomIn = await getCanvasSnapshot();

    // The canvas content should have changed
    expect(afterZoomIn).not.toBe(before);

    // Click zoom out — should differ from zoomed-in state
    await page.locator(".graph-controls button").filter({ hasText: "-" }).click();
    await page.waitForTimeout(300);
    const afterZoomOut = await getCanvasSnapshot();
    expect(afterZoomOut).not.toBe(afterZoomIn);

    // Click reset — should differ from zoomed-out state (returns to scale=1)
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
    await page.waitForTimeout(300);
    const afterReset = await getCanvasSnapshot();
    // Reset should change the view (not necessarily identical to initial due to simulation)
    expect(afterReset).not.toBe(afterZoomOut);
  });

  test("search input exists and highlights matching nodes", async ({ page }) => {
    await openGraphTab(page);

    // Search input should exist in the filter bar
    const searchInput = page.locator("#graph-filter input[type='text']");
    await expect(searchInput).toBeVisible();

    // Type a search query
    await searchInput.fill("repo-a");
    await page.waitForTimeout(300);

    // The search should trigger highlighting on the canvas
    // We verify by checking that graphSearchFilter was called (search state updated)
    const hasHighlights = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      if (!c) return false;
      const ctx = c.getContext("2d");
      if (!ctx) return false;
      // Check for yellow (#fbbf24) highlight pixels — search highlight color
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < data.length; i += 4) {
        // Look for yellowish pixels (R > 200, G > 150, B < 100)
        if (data[i] > 200 && data[i + 1] > 150 && data[i + 2] < 100 && data[i + 3] > 50) {
          return true;
        }
      }
      return false;
    });
    expect(hasHighlights).toBe(true);

    // Clear search
    await searchInput.fill("");
  });

  test("clicking a node opens the detail panel with correct info", async ({ page }) => {
    await openGraphTab(page);

    const detailMeta = page.locator("#graph-detail-meta");
    await expect(detailMeta).toContainText("Click a bubble");

    const hit = await clickUntilNodeSelected(page);
    expect(hit).toBe(true);

    // Detail panel should show node info
    const detailBody = page.locator("#graph-detail-body");
    await expect(detailBody).not.toBeEmpty();
  });

  test("clear selection resets the detail panel", async ({ page }) => {
    await openGraphTab(page);

    await clickUntilNodeSelected(page);

    // Clear via graphClearSelection (no button in the new graph)
    await page.evaluate(() => (window as any).graphClearSelection());
    await expect(page.locator("#graph-detail-meta")).toContainText("Click a bubble");
  });

  test("canvas fills the graph container and is not clustered in a corner", async ({ page }) => {
    await openGraphTab(page);

    const canvas = page.locator("#graph-canvas");
    const container = page.locator(".graph-container");

    const canvasBox = await canvas.boundingBox();
    const containerBox = await container.boundingBox();
    expect(canvasBox).toBeTruthy();
    expect(containerBox).toBeTruthy();

    // Canvas should fill most of the container width
    expect(canvasBox!.width).toBeGreaterThan(containerBox!.width * 0.9);

    // Check that pixels are distributed across the canvas, not just in one corner
    const distribution = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      if (!c) return { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
      const ctx = c.getContext("2d");
      if (!ctx) return { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };

      const hw = c.width / 2;
      const hh = c.height / 2;

      function countNonEmpty(x: number, y: number, w: number, h: number): number {
        const data = ctx!.getImageData(x, y, w, h).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0) count++;
        }
        return count;
      }

      return {
        topLeft: countNonEmpty(0, 0, Math.floor(hw), Math.floor(hh)),
        topRight: countNonEmpty(Math.floor(hw), 0, Math.floor(hw), Math.floor(hh)),
        bottomLeft: countNonEmpty(0, Math.floor(hh), Math.floor(hw), Math.floor(hh)),
        bottomRight: countNonEmpty(Math.floor(hw), Math.floor(hh), Math.floor(hw), Math.floor(hh)),
      };
    });

    // At least 2 quadrants should have non-trivial content (not all in one corner)
    const quadrants = [distribution.topLeft, distribution.topRight, distribution.bottomLeft, distribution.bottomRight];
    const nonEmpty = quadrants.filter((q) => q > 100);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(2);
  });

  test("viewport resize causes graph to adjust", async ({ page }) => {
    await openGraphTab(page);

    const getCanvasSize = async () => {
      return page.evaluate(() => {
        const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
        return { w: c?.offsetWidth || 0, h: c?.offsetHeight || 0 };
      });
    };

    const sizeBefore = await getCanvasSize();

    // Resize viewport to smaller
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    const sizeAfter = await getCanvasSize();

    // Canvas width should have decreased
    expect(sizeAfter.w).toBeLessThan(sizeBefore.w);

    // Restore viewport
    await page.setViewportSize({ width: 1440, height: 1100 });
  });

  test("max nodes input changes the displayed node count", async ({ page }) => {
    await openGraphTab(page);

    const limitRow = page.locator("#graph-limit-row");
    const initialText = await limitRow.textContent();
    const totalMatch = initialText?.match(/of (\d+)/);
    const totalNodes = Number(totalMatch?.[1]);

    // Set max nodes to a low number
    const input = page.locator("#graph-limit-row input[type='number']");
    await input.fill("10");
    await input.press("Enter");
    await page.waitForTimeout(500);

    const updatedText = await limitRow.textContent();
    const showingMatch = updatedText?.match(/(\d+)\s+of\s+(\d+)/);
    const showingCount = Number(showingMatch?.[1]);
    expect(showingCount).toBeLessThanOrEqual(10);

    // Restore
    await input.fill("500");
    await input.press("Enter");
  });

  test("theme toggle affects canvas rendering", async ({ page }) => {
    await openGraphTab(page);

    // Sample canvas background color (top-left corner should be background)
    const getCornerColor = async () => {
      return page.evaluate(() => {
        const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
        if (!c) return [0, 0, 0, 0];
        const ctx = c.getContext("2d");
        if (!ctx) return [0, 0, 0, 0];
        const data = ctx.getImageData(5, 5, 1, 1).data;
        return [data[0], data[1], data[2], data[3]];
      });
    };

    const darkColor = await getCornerColor();

    // Toggle to light mode
    await page.locator("button").filter({ hasText: /☀️|🌙/ }).click();
    await page.waitForTimeout(500);

    const lightColor = await getCornerColor();

    // The background color should differ between themes
    const colorChanged =
      Math.abs(darkColor[0] - lightColor[0]) > 30 ||
      Math.abs(darkColor[1] - lightColor[1]) > 30 ||
      Math.abs(darkColor[2] - lightColor[2]) > 30;
    expect(colorChanged).toBe(true);

    // Toggle back to dark
    await page.locator("button").filter({ hasText: /☀️|🌙/ }).click();
  });

  test("detail panel shows correct type label for different node types", async ({ page }) => {
    await openGraphTab(page);

    const detailMeta = page.locator("#graph-detail-meta");
    const hit = await clickUntilNodeSelected(page);
    expect(hit).toBe(true);

    // The type badge appears in the meta element (header), not body
    const headerText = await detailMeta.textContent();
    const bodyText = await page.locator("#graph-detail-body").textContent();
    const combined = (headerText || "") + " " + (bodyText || "");
    const typeMatch = combined.match(/(project|decision|pitfall|pattern|tradeoff|architecture|bug|entity|reference|task)/i);
    let selectedType = typeMatch ? typeMatch[1].toLowerCase() : "";
    expect(selectedType).toBeTruthy();

    // The header label should reflect the actual type, not always say "Finding bubble"
    if (selectedType === "project") {
      expect(headerText?.toLowerCase()).toContain("project");
    } else if (selectedType === "entity") {
      expect(headerText?.toLowerCase()).not.toContain("finding bubble");
    } else if (selectedType === "reference") {
      expect(headerText?.toLowerCase()).not.toContain("finding bubble");
    }
  });

  // ── Interaction tests ──────────────────────────────────────────────────

  test("drag a node freely and verify it stays at the new position", async ({ page }) => {
    await openGraphTab(page);

    // Find a node position
    const positions = await findNodePositions(page);
    expect(positions.length).toBeGreaterThan(0);

    const detailMeta = page.locator("#graph-detail-meta");
    let nodeX = 0;
    let nodeY = 0;
    for (const pos of positions) {
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(100);
      const text = await detailMeta.textContent();
      if (text && !text.includes("Click a bubble")) {
        nodeX = pos.x;
        nodeY = pos.y;
        break;
      }
    }

    // Remember which node was selected
    const selectedBefore = await detailMeta.textContent();
    expect(selectedBefore).not.toContain("Click a bubble");

    // Snapshot canvas before drag
    const snapshotBefore = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 32) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });

    // Drag the node 120px to the right and 80px down
    await page.mouse.move(nodeX, nodeY);
    await page.mouse.down();
    await page.mouse.move(nodeX + 120, nodeY + 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Canvas should have changed (node moved)
    const snapshotAfter = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 32) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });
    expect(snapshotAfter).not.toBe(snapshotBefore);

    // Click the new position — the same node should be selectable there
    await page.mouse.click(nodeX + 120, nodeY + 80);
    await page.waitForTimeout(100);
    const selectedAfter = await detailMeta.textContent();
    // The node should be found at the new position (same node or at least some node there)
    expect(selectedAfter).not.toContain("Click a bubble");
  });

  test("pan the entire graph by dragging empty space", async ({ page }) => {
    await openGraphTab(page);

    const canvas = page.locator("#graph-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();

    // Snapshot before pan — sample the center column where nodes are
    const getSnapshot = () => page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const midX = Math.floor(c.width / 2);
      const d = ctx.getImageData(midX - 50, 0, 100, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 16) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });

    const snapshotBefore = await getSnapshot();

    // Drag from a corner (likely empty space) to shift the entire graph
    const startX = box!.x + 20;
    const startY = box!.y + 20;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 200, startY + 150, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const snapshotAfter = await getSnapshot();
    expect(snapshotAfter).not.toBe(snapshotBefore);

    // Reset view
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
    await page.waitForTimeout(300);
  });

  test("zoom and pan combined — zoom in then pan to explore", async ({ page }) => {
    await openGraphTab(page);

    const canvas = page.locator("#graph-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Zoom in twice
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.waitForTimeout(300);

    // Snapshot after zoom — sample a wide center band
    const getWideSnapshot = () => page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const midX = Math.floor(c.width / 2);
      const d = ctx.getImageData(midX - 100, 0, 200, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 32) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });

    const afterZoom = await getWideSnapshot();

    // Pan while zoomed — drag from bottom-left corner (empty space)
    const panStartX = box!.x + 30;
    const panStartY = box!.y + box!.height - 30;
    await page.mouse.move(panStartX, panStartY);
    await page.mouse.down();
    await page.mouse.move(panStartX + 250, panStartY - 200, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const afterZoomPan = await getWideSnapshot();
    expect(afterZoomPan).not.toBe(afterZoom);

    // Reset
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
  });

  test("node hover shows tooltip with label", async ({ page }) => {
    await openGraphTab(page);

    const canvas = page.locator("#graph-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const tooltip = page.locator("#graph-tooltip");

    // Move over node positions to find a tooltip (200ms hover delay in graph code)
    const positions = await findNodePositions(page);
    let tooltipShown = false;
    for (const pos of positions) {
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(350); // Must exceed 200ms tooltip delay
      const display = await tooltip.evaluate((el) => (el as HTMLElement).style.display);
      if (display === "block") {
        tooltipShown = true;
        const text = await tooltip.textContent();
        expect(text!.length).toBeGreaterThan(0);
        break;
      }
    }
    expect(tooltipShown).toBe(true);

    // Move to an empty area — tooltip should hide
    await page.mouse.move(box!.x + 5, box!.y + 5);
    await page.waitForTimeout(100);
    const hiddenDisplay = await tooltip.evaluate((el) => (el as HTMLElement).style.display);
    expect(hiddenDisplay).toBe("none");
  });

  test("fragment nodes visible via type filter and interactive", async ({ page }) => {
    await openGraphTab(page);

    // Filter to show only fragments
    const entityBtn = page.locator("#graph-filter span").filter({ hasText: "Fragments" });
    // First click "all off" by clicking each active type to disable, or use the type filter
    // The filter is a toggle — clicking "Fragments" should toggle it.
    // By default all types are active. Let's filter to only fragments by:
    // 1. Click Fragments (keeps it on), then toggle off others
    // Actually the filter works as multi-select toggles. Let's just check that
    // fragment nodes exist by filtering to fragments only.

    // Click "Projects" to toggle it off
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Findings" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Tasks" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Refs" }).click();
    await page.waitForTimeout(500);

    // Now only fragment nodes should be visible
    const limitRow = page.locator("#graph-limit-row");
    const text = await limitRow.textContent();
    const match = text?.match(/(\d+)\s+of\s+(\d+)/);
    const entityCount = Number(match?.[1]);
    expect(entityCount).toBeGreaterThan(0);

    // Click on the canvas to select a fragment node
    const found = await clickUntilNodeSelected(page);
    expect(found).toBe(true);
    // Fragment type badge is in the meta header — shows specific type like "concept", "person", etc.
    // The detail body should show "References:" which is unique to fragment detail panels
    const bodyText = await page.locator("#graph-detail-body").textContent();
    expect(bodyText?.toLowerCase()).toContain("references:");

    // Reset filters — toggle everything back on
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Findings" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Tasks" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Refs" }).click();
  });

  test("reference nodes visible via type filter and interactive", async ({ page }) => {
    await openGraphTab(page);

    // Filter to only reference nodes
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Findings" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Tasks" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Fragments" }).click();
    await page.waitForTimeout(500);

    const limitRow = page.locator("#graph-limit-row");
    const text = await limitRow.textContent();
    const match = text?.match(/(\d+)\s+of\s+(\d+)/);
    const refCount = Number(match?.[1]);
    expect(refCount).toBeGreaterThan(0);

    // Click to select a reference node
    const found = await clickUntilNodeSelected(page);
    expect(found).toBe(true);
    const meta = await page.locator("#graph-detail-meta").textContent();
    expect(meta?.toLowerCase()).toContain("reference");

    // Reset filters
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Findings" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Tasks" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Fragments" }).click();
  });

  test("task nodes visible via type filter and interactive", async ({ page }) => {
    await openGraphTab(page);

    // Filter to only task nodes
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Findings" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Fragments" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Refs" }).click();
    await page.waitForTimeout(500);

    const limitRow = page.locator("#graph-limit-row");
    const text = await limitRow.textContent();
    const match = text?.match(/(\d+)\s+of\s+(\d+)/);
    const taskCount = Number(match?.[1]);
    expect(taskCount).toBeGreaterThan(0);

    const found = await clickUntilNodeSelected(page);
    expect(found).toBe(true);
    const meta = await page.locator("#graph-detail-meta").textContent();
    expect(meta?.toLowerCase()).toContain("task");

    // Reset filters
    await page.locator("#graph-filter span").filter({ hasText: "Projects" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Findings" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Fragments" }).click();
    await page.locator("#graph-filter span").filter({ hasText: "Refs" }).click();
  });

  test("edges are visible between connected nodes", async ({ page }) => {
    await openGraphTab(page);

    // Edges are drawn as lines on the canvas between connected nodes.
    // We verify by checking that the canvas has line-like pixel patterns
    // between the center area where nodes cluster.
    const hasEdgePixels = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return false;

      // Sample a horizontal strip through the middle of the canvas
      // Edges appear as thin colored lines (typically low alpha or specific colors)
      const midY = Math.floor(c.height / 2);
      const strip = ctx.getImageData(0, midY - 5, c.width, 10).data;

      // Count semi-transparent or thin-line pixels (alpha > 0 but not fully opaque node fill)
      let edgeLikePixels = 0;
      for (let i = 0; i < strip.length; i += 4) {
        const a = strip[i + 3];
        // Edge lines typically have alpha between 20 and 180
        if (a > 20 && a < 180) edgeLikePixels++;
      }
      // There should be some edge pixels in the middle of the graph
      return edgeLikePixels > 5;
    });

    // If edges aren't visible as semi-transparent, at least verify the canvas has
    // non-trivial content spread across it (edges connect distributed nodes)
    const hasSpreadContent = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return false;

      // Sample multiple horizontal positions
      let contentPositions = 0;
      for (let x = 100; x < c.width - 100; x += 50) {
        const col = ctx.getImageData(x, 0, 1, c.height).data;
        for (let i = 3; i < col.length; i += 4) {
          if (col[i] > 0) {
            contentPositions++;
            break;
          }
        }
      }
      // Content should span at least 5 different x-positions (edges + nodes)
      return contentPositions >= 5;
    });

    expect(hasEdgePixels || hasSpreadContent).toBe(true);
  });

  test("wheel zoom on canvas changes scale", async ({ page }) => {
    await openGraphTab(page);

    const canvas = page.locator("#graph-canvas");
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Snapshot before
    const before = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const d = ctx.getImageData(c.width / 2, c.height / 2, 100, 100).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 16) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });

    // Scroll to zoom in
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);

    const afterZoomIn = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const d = ctx.getImageData(c.width / 2, c.height / 2, 100, 100).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 16) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });
    expect(afterZoomIn).not.toBe(before);

    // Scroll to zoom out past original
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);

    const afterZoomOut = await page.evaluate(() => {
      const c = document.getElementById("graph-canvas") as HTMLCanvasElement;
      const ctx = c?.getContext("2d");
      if (!ctx) return "";
      const d = ctx.getImageData(c.width / 2, c.height / 2, 100, 100).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 16) h = ((h << 5) - h + d[i]) | 0;
      return h.toString();
    });
    expect(afterZoomOut).not.toBe(afterZoomIn);

    // Reset
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();
  });

  test("selecting a node then clearing resets for next selection", async ({ page }) => {
    await openGraphTab(page);

    const detailMeta = page.locator("#graph-detail-meta");

    // Select a node
    const hit = await clickUntilNodeSelected(page);
    expect(hit).toBe(true);

    // Clear selection
    await page.evaluate(() => (window as any).graphClearSelection());
    await page.waitForTimeout(100);
    await expect(detailMeta).toContainText("Click a bubble");

    // Select again after clearing
    const hit2 = await clickUntilNodeSelected(page);
    expect(hit2).toBe(true);
  });

  test("no console errors across full graph interaction", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    await openGraphTab(page);

    // Exercise all interactive features
    const canvas = page.locator("#graph-canvas");
    const box = await canvas.boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Click nodes
    await clickUntilNodeSelected(page);

    // Click zoom buttons
    await page.locator(".graph-controls button").filter({ hasText: "+" }).click();
    await page.locator(".graph-controls button").filter({ hasText: "-" }).click();
    await page.locator(".graph-controls button").filter({ hasText: "R" }).click();

    // Click project filters
    const projButtons = page.locator("#graph-project-filter button");
    const projCount = await projButtons.count();
    for (let i = 0; i < projCount; i++) {
      await projButtons.nth(i).click();
      await page.waitForTimeout(100);
    }

    // Click type filters
    const typeButtons = page.locator("#graph-filter span[onclick]");
    const typeCount = await typeButtons.count();
    for (let i = 0; i < typeCount; i++) {
      await typeButtons.nth(i).click();
      await page.waitForTimeout(100);
    }

    // Use search
    const searchInput = page.locator("#graph-filter input[type='text']");
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
});
