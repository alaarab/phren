import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = path.resolve(here, "../../vscode/scratch/vscode-webview.html");
const shots = process.env.SHOT_DIR || "/tmp/phren-vscode-assessment";

test("graph UI layout and project workflow", async ({ page }) => {
  fs.mkdirSync(shots, { recursive: true });
  await page.goto(`file://${html}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as any).phrenGraph?.getData?.().nodes.length > 0);
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: path.join(shots, "01-overview.png") });

  const filter = page.locator("#graph-filter");
  const controls = page.locator(".graph-controls");
  const filterBox = (await filter.boundingBox())!;
  const controlsBox = (await controls.boundingBox())!;
  expect.soft(filterBox.x + filterBox.width).toBeLessThanOrEqual(controlsBox.x - 12);

  await page.evaluate(() => (window as any).phrenGraph.selectNode("project:api-server"));
  const panel = page.locator(".phren-project-panel");
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(panel.locator(".phren-pp-sub")).toContainText("71 findings · 4 tasks");
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: path.join(shots, "02-project.png") });

  const initial = (await panel.boundingBox())!;
  expect(initial.x).toBeLessThanOrEqual(20);
  expect(initial.height).toBeGreaterThanOrEqual(500);
  expect(initial.width).toBeLessThanOrEqual(320);

  const heightHandle = (await panel.locator(".phren-pp-resize-y").boundingBox())!;
  await page.mouse.move(heightHandle.x + heightHandle.width / 2, heightHandle.y + heightHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(heightHandle.x + heightHandle.width / 2, heightHandle.y + 70, { steps: 6 });
  await page.mouse.up();
  const taller = (await panel.boundingBox())!;
  expect(taller.height).toBeGreaterThan(initial.height + 40);

  const widthHandle = (await panel.locator(".phren-pp-resize").boundingBox())!;
  await page.mouse.move(widthHandle.x + widthHandle.width / 2, widthHandle.y + 30);
  await page.mouse.down();
  await page.mouse.move(widthHandle.x + 90, widthHandle.y + 30, { steps: 6 });
  await page.mouse.up();
  const wider = (await panel.boundingBox())!;
  expect(wider.width).toBeGreaterThan(taller.width + 50);
  expect(Math.abs(wider.height - taller.height)).toBeLessThanOrEqual(2);

  const corner = (await panel.locator(".phren-pp-resize-xy").boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + 45, corner.y + 45, { steps: 5 });
  await page.mouse.up();
  const diagonal = (await panel.boundingBox())!;
  expect(diagonal.width).toBeGreaterThan(wider.width + 25);
  expect(diagonal.height).toBeGreaterThan(wider.height + 25);

  const head = (await panel.locator(".phren-pp-head").boundingBox())!;
  await page.mouse.move(head.x + 90, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + 130, head.y + 50, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(220);
  const movedPane = (await panel.boundingBox())!;
  expect(movedPane.x).toBeGreaterThan(diagonal.x + 25);
  expect(movedPane.y).toBeGreaterThan(diagonal.y + 15);

  const findingsFilter = panel.locator('[data-pp-chip][data-kind="finding"]');
  await findingsFilter.click();
  await expect(findingsFilter).toHaveAttribute("aria-pressed", "true");
  await expect(findingsFilter).toHaveClass(/on/);

  const firstRow = panel.locator(".phren-pp-row").first();
  await firstRow.click();
  await page.waitForTimeout(900);
  await expect(page.locator("#node-popover")).toBeHidden();
  await expect(firstRow).toHaveAttribute("aria-expanded", "true");
  await expect(firstRow.locator(".phren-pp-rowdetail")).toBeVisible();
  await expect(firstRow.locator(".phren-pp-rowdetail")).toContainText("representative memory");
  const selectedBox = (await panel.boundingBox())!;
  expect(Math.abs(selectedBox.x - movedPane.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(selectedBox.y - movedPane.y)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(shots, "03-selected.png") });

  await firstRow.hover();
  await firstRow.locator("[data-pp-edit]").click();
  const inlineEditor = firstRow.locator("[data-pp-editor]");
  await expect(inlineEditor).toBeVisible();
  await expect(page.locator("#node-popover")).toBeHidden();
  await expect(inlineEditor.locator(".phren-pp-inline-meta")).toContainText("Topic");
  await inlineEditor.locator("[data-pp-text]").fill("Updated finding entirely inside the project pane");
  await inlineEditor.locator("[data-pp-save]").click();
  await expect(inlineEditor).toBeHidden();
  await expect.poll(async () => page.evaluate(() => (window as any).__phrenPostedMessages.at(-1)?.command)).toBe("saveFindingEdit");

  const selectButton = panel.locator("[data-pp-select]");
  await selectButton.click();
  const selectAll = panel.locator("[data-pp-bulk-all]");
  await selectAll.click();
  await expect(selectAll).toHaveText("Unselect all");
  await selectAll.click();
  await expect(selectAll).toHaveText("Select all");
  await panel.locator("[data-pp-bulk-done]").click();

  const taskFilter = panel.locator('[data-pp-chip][data-kind="task"]');
  await taskFilter.click();
  const firstTask = panel.locator('.phren-pp-row').first();
  await firstTask.hover();
  await firstTask.locator('[data-pp-edit]').click();
  await firstTask.locator('[data-pp-section]').selectOption('Active');
  await firstTask.locator('[data-pp-priority]').selectOption('high');
  await firstTask.locator('[data-pp-save]').click();
  await expect.poll(async () => page.evaluate(() => (window as any).__phrenPostedMessages.at(-1)?.command)).toBe("saveTaskEdit");
  await expect(page.locator("#node-popover")).toBeHidden();
  await page.screenshot({ path: path.join(shots, "04-edit.png") });
});
