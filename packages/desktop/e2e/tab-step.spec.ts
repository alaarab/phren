import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
const frame = overviewFrame([chatRow("alpha", "Alpha chat", "idle"), chatRow("bravo", "Bravo chat", "idle"), chatRow("charlie", "Charlie chat", "idle")]);

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => { h = await startHarness("tab-step", { overviewFrames: [frame] }); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const active = (page: Page) => page.locator(".doc-tab.selected .doc-tab-title");

async function openThree(page: Page) {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  for (const name of ["Alpha", "Bravo", "Charlie"]) await page.locator(".sb-row", { hasText: `${name} chat` }).click();
  await expect(active(page)).toHaveText("Charlie chat");
}

test("Ctrl+PageDown and Ctrl+PageUp step through the tabs and wrap", async ({ page }) => {
  await openThree(page);
  await page.keyboard.press("Control+PageDown");
  await expect(active(page)).toHaveText("Alpha chat");
  await page.keyboard.press("Control+PageDown");
  await expect(active(page)).toHaveText("Bravo chat");
  await page.keyboard.press("Control+PageUp");
  await page.keyboard.press("Control+PageUp");
  await expect(active(page)).toHaveText("Charlie chat");
  await page.screenshot({ path: test.info().outputPath("tab-step.png") });
});

test("Cmd/Ctrl+Shift+] and [ step too", async ({ page }) => {
  await openThree(page);
  await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  await expect(active(page)).toHaveText("Alpha chat");
  await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await expect(active(page)).toHaveText("Charlie chat");
});

test("it steps within the focused tile only", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  await page.locator(".sb-row", { hasText: "Alpha chat" }).click();
  await page.keyboard.press("ControlOrMeta+\\"); // split: the new, empty tile is focused
  await expect(page.locator(".tile")).toHaveCount(2);
  await page.locator(".sb-row", { hasText: "Bravo chat" }).click();
  await page.locator(".sb-row", { hasText: "Charlie chat" }).click();
  const focused = page.locator(".tile-focused");
  await expect(focused.locator(".doc-tab.selected .doc-tab-title")).toHaveText("Charlie chat");
  await page.keyboard.press("Control+PageDown");
  await expect(focused.locator(".doc-tab.selected .doc-tab-title")).toHaveText("Bravo chat");
  // The other tile keeps its own tab.
  await expect(page.locator(".tile:not(.tile-focused) .doc-tab.selected .doc-tab-title")).toHaveText("Alpha chat");
});

test("a terminal or editor keeps Ctrl+PageDown, but not Cmd/Ctrl+Shift+]", async ({ page }) => {
  await openThree(page);
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.className = "xterm";
    const input = document.createElement("textarea");
    box.append(input);
    document.body.append(box);
    input.focus();
  });
  await page.keyboard.press("Control+PageDown");
  await page.waitForTimeout(300);
  await expect(active(page)).toHaveText("Charlie chat");
  await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  await expect(active(page)).toHaveText("Alpha chat");
});

test("it does nothing outside the Agents section", async ({ page }) => {
  await openThree(page);
  await page.locator('.section-pill[data-section="home"]').click();
  await page.keyboard.press("Control+PageDown");
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(active(page)).toHaveText("Charlie chat");
});

test("the command palette lists the new actions", async ({ page }) => {
  await openThree(page);
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type(">Tab in This Tile");
  await expect(page.getByText("Next Tab in This Tile")).toBeVisible();
  await expect(page.getByText("Previous Tab in This Tile")).toBeVisible();
});
