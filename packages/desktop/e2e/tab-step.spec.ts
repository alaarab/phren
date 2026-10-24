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

test("Cmd/Ctrl+[ and ] still walk the visited sections with the step keys installed", async ({ page }) => {
  await openThree(page);
  await page.locator('.section-pill[data-section="home"]').click();
  await expect(page).toHaveURL(/#\/home$/);
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(page).toHaveURL(/#\/agents$/);
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(page).toHaveURL(/#\/home$/);
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(active(page)).toHaveText("Charlie chat"); // no tab stepped
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

test("a terminal, editor or iframe keeps Ctrl+PageDown", async ({ page }) => {
  await openThree(page);
  for (const [name, html] of [
    ["xterm", '<div class="xterm"><textarea id="probe"></textarea></div>'],
    ["bench-terminal", '<div class="bench-terminal"><textarea id="probe"></textarea></div>'],
    ["monaco", '<div class="monaco-editor"><textarea id="probe"></textarea></div>'],
    ["iframe", '<iframe id="probe-frame" srcdoc="<textarea id=t></textarea>"></iframe>'],
  ]) {
    await page.evaluate((markup) => {
      const host = document.createElement("div");
      host.id = "probe-host";
      host.innerHTML = markup;
      document.body.append(host);
      (host.querySelector("#probe") as HTMLElement | null)?.focus();
      const frame = host.querySelector("iframe");
      if (frame) frame.focus();
    }, html);
    await page.keyboard.press("Control+PageDown");
    await page.waitForTimeout(250);
    await expect(active(page), name).toHaveText("Charlie chat");
    await page.evaluate(() => document.getElementById("probe-host")?.remove());
  }
  // Positive control: with focus back on the page the same key steps.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+PageDown");
  await expect(active(page)).toHaveText("Alpha chat");
});

test("a key that stepped nothing is not prevented", async ({ page }) => {
  await openThree(page);
  const prevented = () => page.evaluate(() => new Promise<boolean>((resolve) => {
    const ev = new KeyboardEvent("keydown", { key: "PageDown", code: "PageDown", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    resolve(ev.defaultPrevented);
  }));
  expect(await prevented()).toBe(true); // stepped: handled
  await page.locator('.section-pill[data-section="home"]').click();
  expect(await prevented()).toBe(false); // other section: left alone
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.keyboard.press("ControlOrMeta+W");
  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.locator(".doc-tab")).toHaveCount(1);
  expect(await prevented()).toBe(false); // a lone tab: nothing to step to
});

test("the command palette lists the new actions", async ({ page }) => {
  await openThree(page);
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type(">Tab in This Tile");
  await expect(page.getByText("Next Tab in This Tile")).toBeVisible();
  await expect(page.getByText("Previous Tab in This Tile")).toBeVisible();
});
