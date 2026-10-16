import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
let url: string;

const overview = overviewFrame([
  chatRow("a", "Alpha chat", "working", { lastReply: "Running the migration now" }),
  chatRow("b", "Bravo chat", "blocked", { lastReply: "Should I delete the old table?" }),
  chatRow("c", "Charlie chat", "idle", { lastReply: "All done, tests pass." }),
]);

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });

test.beforeEach(async ({ page }) => {
  h = await startHarness("palette-recent", { overviewFrames: [overview] });
  url = h.url;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await h?.close();
  h = undefined;
});

const input = (page: Page) => page.locator(".palette-input");
const titles = (page: Page) => page.locator(".palette-row .palette-title");

async function pick(page: Page, query: string, title: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input(page)).toBeFocused();
  await input(page).fill(query);
  await expect(titles(page).first()).toHaveText(title);
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette-backdrop")).toHaveCount(0);
}

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input(page)).toBeFocused();
}

test("an empty palette shows what you picked first, in frecency order", async ({ page }) => {
  await openPalette(page);
  await expect(page.locator(".palette-group").first()).toHaveText(/sessions/i);
  await page.keyboard.press("Escape");

  await pick(page, "Toggle Sidebar", "Toggle Sidebar");
  await pick(page, "Toggle Sidebar", "Toggle Sidebar");
  await pick(page, "Charlie chat", "Charlie chat");

  await openPalette(page);
  // Bravo chat needs you (and Alpha chat is working), so they keep the top; Recent follows.
  await expect(titles(page).nth(0)).toHaveText("Bravo chat");
  await expect(titles(page).nth(1)).toHaveText("Alpha chat");
  await expect(page.locator(".palette-group").nth(1)).toHaveText(/recent/i);
  // Picked twice beats picked once, even though the chat was picked last.
  await expect(titles(page).nth(2)).toHaveText("Toggle Sidebar");
  await expect(titles(page).nth(3)).toHaveText("Charlie chat");
  // An item shown in Recent is not listed again below.
  await expect(page.locator(".palette-row .palette-title", { hasText: "Charlie chat" })).toHaveCount(1);
  await expect(page.locator(".palette-row .palette-title", { hasText: "Toggle Sidebar" })).toHaveCount(1);

  // Only ids are stored: no query text.
  const stored = await page.evaluate(() => localStorage.getItem("phren.palette.recent"));
  expect(stored).not.toMatch(/Toggle Sidebar|Charlie chat/);
  expect(JSON.parse(stored as string).map((e: { id: string }) => e.id).sort()).toEqual(["command:keys.toggle_sidebar", "session:This computer/c"].sort());
});

test("frecency lifts a used item but never above a clearly better text match", async ({ page }) => {
  await openPalette(page);
  await page.locator(".palette-input").fill("ch");
  const before = await titles(page).allInnerTexts();
  expect(before.indexOf("Alpha chat")).toBeLessThan(before.indexOf("Bravo chat"));
  await page.keyboard.press("Escape");

  await pick(page, "Bravo chat", "Bravo chat");
  await pick(page, "Bravo chat", "Bravo chat");
  await openPalette(page);
  await input(page).fill("ch");
  const after = await titles(page).allInnerTexts();
  expect(after.indexOf("Bravo chat")).toBeLessThan(after.indexOf("Alpha chat"));
  await page.keyboard.press("Escape");

  // Charlie matches "al" weakly; however often it is picked, Alpha chat stays first.
  for (let i = 0; i < 4; i++) await pick(page, "Charlie chat", "Charlie chat");
  await openPalette(page);
  await input(page).fill("al");
  const row = await titles(page).allInnerTexts();
  expect(row[0]).toBe("Alpha chat");
  expect(row).toContain("Charlie chat");
});

test("Clear recent empties the Recent group, and a vanished item is skipped", async ({ page }) => {
  await pick(page, "Charlie chat", "Charlie chat");
  await page.evaluate(() => {
    const entries = JSON.parse(localStorage.getItem("phren.palette.recent") as string);
    entries.push({ id: "session:This computer/gone", n: 5, t: Date.now() });
    localStorage.setItem("phren.palette.recent", JSON.stringify(entries));
  });
  await openPalette(page);
  await expect(page.locator(".palette-group", { hasText: /recent/i })).toHaveCount(1);
  await expect(page.locator(".palette-row")).toContainText(["Charlie chat"]);
  await expect(page.locator(".palette-row .palette-title", { hasText: "gone" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await pick(page, "Clear recent", "Clear recent");
  expect(await page.evaluate(() => localStorage.getItem("phren.palette.recent"))).toBeNull();
  await openPalette(page);
  await expect(page.locator(".palette-group").first()).toHaveText(/sessions/i);
  await expect(page.locator(".palette-group", { hasText: /recent/i })).toHaveCount(0);
  await input(page).fill("clear");
  await expect(page.locator(".palette-row .palette-title", { hasText: "Clear recent" })).toHaveCount(0);
});
