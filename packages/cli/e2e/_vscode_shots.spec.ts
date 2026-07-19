/* eslint-disable */
// Local harness (CI-ignored via the `_` prefix): loads the REAL VS Code webview
// HTML (rendered by scratch/render-webview.mjs) and screenshots the node
// dossier so the docked-left placement can be verified outside the editor.
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.resolve(__dirname, "..", "..", "vscode", "scratch", "vscode-webview.html");
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/shots";

test("vscode webview node dossier docks left", async ({ page }) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.goto("file://" + HTML, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const pg = (window as any).phrenGraph;
    return pg && pg.getData && pg.getData().nodes.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Select a finding — the dossier should dock to the left edge, not appear at
  // the node/cursor.
  await page.evaluate(() => (window as any).phrenGraph.selectNode("finding:api-server:3"));
  await page.waitForTimeout(1200);

  const popover = page.locator("#node-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveClass(/docked/);

  // Assert geometry: left-anchored, tall reading pane (not a cursor bubble).
  const box = await popover.boundingBox();
  const vp = page.viewportSize()!;
  expect(box).toBeTruthy();
  expect(box!.x).toBeLessThan(40);          // hugs the left edge
  expect(box!.height).toBeGreaterThan(vp.height * 0.5); // full-height pane
  await page.screenshot({ path: `${SHOT_DIR}/vscode-01-finding-docked.png` });

  // A project selection should also dock left, with the contents pane at right.
  await page.evaluate(() => (window as any).phrenGraph.selectNode("project:api-server"));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOT_DIR}/vscode-02-project.png` });

  // Collapse the contents pane → slim re-open tab reclaims graph space.
  await page.locator(".phren-project-panel [data-pp-collapse]").click();
  await page.waitForTimeout(500);
  await expect(page.locator(".phren-pp-reopen")).toBeVisible();
  await expect(page.locator(".phren-project-panel")).toBeHidden();
  await page.screenshot({ path: `${SHOT_DIR}/vscode-03-collapsed.png` });

  // Re-open restores the pane.
  await page.locator(".phren-pp-reopen").click();
  await page.waitForTimeout(500);
  await expect(page.locator(".phren-project-panel")).toBeVisible();
});
