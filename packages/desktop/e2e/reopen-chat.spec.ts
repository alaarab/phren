import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const chat = (id: string, title: string) => chatRow(id, title, "idle");
const alpha = chat("alpha", "Alpha chat");
const bravo = chat("bravo", "Bravo chat");
const charlie = chat("charlie", "Charlie chat");

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => { h = await startHarness("reopen-chat", { overviewFrames: [overviewFrame([alpha, bravo, charlie])] }); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const active = (page: Page) => page.locator(".doc-tab.selected .doc-tab-title");
const row = (page: Page, title: string) => page.locator(".sb-row").filter({ has: page.locator(".sb-title", { hasText: title }) });

async function openAndClose(page: Page, titles: string[]) {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  for (const title of titles) {
    await row(page, title).click();
    await expect(active(page)).toHaveText(title);
  }
  // Closing the active tab each time: the last opened goes first (C, B, A).
  const closed = [...titles].reverse();
  for (const title of closed) {
    await expect(active(page)).toHaveText(title);
    await page.keyboard.press("ControlOrMeta+W");
  }
  await expect(page.locator(".doc-tab")).toHaveCount(0);
}

test("reopens closed chats newest first, again goes further back", async ({ page }) => {
  await openAndClose(page, ["Alpha chat", "Bravo chat"]);
  // Alpha was closed last, so it comes back first.
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Alpha chat");
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(page.locator(".doc-tab")).toHaveCount(2);
});

test("skips a session that no longer exists, then says the chat is gone", async ({ page }) => {
  await openAndClose(page, ["Alpha chat", "Bravo chat", "Charlie chat"]);
  h!.hook.pushOverview(overviewFrame([alpha, charlie]));
  await expect(page.locator(".sb-row")).toHaveCount(2);
  // Closed in the order Charlie, Bravo, Alpha: Alpha first, Bravo is gone and skipped, then Charlie.
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Alpha chat");
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Charlie chat");
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.locator(".pt-toast")).toHaveText("That chat is gone");
  await expect(page.locator(".doc-tab")).toHaveCount(2);
});

test("the palette offers Reopen closed chat only while something is closed", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await row(page, "Alpha chat").click();
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type(">Reopen closed");
  await expect(page.getByText("Reopen closed chat")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+W");
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type(">Reopen closed");
  await expect(page.getByText("Reopen closed chat")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(active(page)).toHaveText("Alpha chat");
});
