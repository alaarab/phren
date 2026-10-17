import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const chat = (id: string, title: string, session?: string) => {
  const row = chatRow(id, title, "idle");
  return { ...row, target: { ...row.target, session } };
};
const frame = overviewFrame([chat("alpha", "Alpha chat", "sess-alpha"), chat("bravo", "Bravo chat"), chat("charlie", "Charlie chat", "sess-charlie"), chat("delta", "Delta chat")]);

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => { h = await startHarness("tab-menu", { overviewFrames: [frame] }); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const tab = (page: Page, title: string) => page.locator(".doc-tab", { hasText: title });
const titles = (page: Page) => page.locator(".doc-tab .doc-tab-title");
const menu = (page: Page) => page.locator(".tab-menu");
const active = (page: Page) => page.locator(".doc-tab.selected .doc-tab-title");

async function openAll(page: Page, names = ["Alpha", "Bravo", "Charlie", "Delta"]) {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(4);
  for (const name of names) await page.locator(".sb-row", { hasText: `${name} chat` }).click();
  await expect(titles(page)).toHaveCount(names.length);
}

test("right-click opens the menu; Close others keeps the tab and the closed chats reopen newest last", async ({ page }) => {
  await openAll(page);
  await tab(page, "Bravo").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Close", "Close others", "Close to the right", "Move to new split (right)"]);
  await page.screenshot({ path: test.info().outputPath("tab-menu.png") });
  await menu(page).getByRole("menuitem", { name: "Close others" }).click();
  await expect(titles(page)).toHaveText(["Bravo chat"]);
  await expect(active(page)).toHaveText("Bravo chat");
  // Closed right to left (Delta, Charlie, Alpha), so Alpha is the newest and comes back first, in its place.
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(titles(page)).toHaveText(["Alpha chat", "Bravo chat"]);
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(titles(page)).toHaveText(["Alpha chat", "Bravo chat", "Charlie chat"]);
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(titles(page)).toHaveText(["Alpha chat", "Bravo chat", "Charlie chat", "Delta chat"]);
});

test("the keyboard opens it on a focused tab, arrows move, Esc returns focus, Close to the right closes the rest", async ({ page }) => {
  await openAll(page);
  await tab(page, "Bravo").click();
  // Only the selected tab is a tab stop; focus it as Tab would.
  await tab(page, "Bravo").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(tab(page, "Bravo")).toBeFocused();

  await page.keyboard.press("ContextMenu");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitem", { name: "Close to the right" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["Alpha chat", "Bravo chat"]);
  // Closed Delta then Charlie: Charlie is newest.
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(titles(page)).toHaveText(["Alpha chat", "Bravo chat", "Charlie chat"]);
});

test("focus is trapped: Tab and Shift+Tab cycle inside the menu, ArrowUp wraps", async ({ page }) => {
  await openAll(page, ["Alpha", "Bravo"]);
  await tab(page, "Alpha").click({ button: "right" });
  const items = menu(page).getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(items.last()).toBeFocused();
  await expect(menu(page)).toBeVisible();
});

test("Move to new split sends the tab to a tile on its right", async ({ page }) => {
  await openAll(page, ["Alpha", "Bravo"]);
  await tab(page, "Alpha").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Move to new split (right)" }).click();
  await expect(page.locator(".tile")).toHaveCount(2);
  await expect(page.locator(".tile").nth(0).locator(".doc-tab-title")).toHaveText(["Bravo chat"]);
  await expect(page.locator(".tile").nth(1).locator(".doc-tab-title")).toHaveText(["Alpha chat"]);
});

test("Copy session id is offered for chats that have one; Reopen closed chat only after a close", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openAll(page, ["Alpha", "Bravo"]);
  await tab(page, "Bravo").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Close", "Close others", "Close to the right", "Move to new split (right)"]);
  await page.keyboard.press("Escape");
  await tab(page, "Alpha").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Close", "Close others", "Close to the right", "Move to new split (right)", "Copy session id"]);
  await menu(page).getByRole("menuitem", { name: "Copy session id" }).click();
  await expect(page.locator(".pt-toast")).toHaveText("Copied session id");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sess-alpha");

  await tab(page, "Bravo").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(titles(page)).toHaveText(["Alpha chat"]);
  await tab(page, "Alpha").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Reopen closed chat" }).click();
  await expect(titles(page)).toHaveText(["Alpha chat", "Bravo chat"]);
});

test("items that would do nothing are disabled, and an outside click closes the menu", async ({ page }) => {
  await openAll(page, ["Alpha", "Bravo"]);
  await tab(page, "Bravo").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Close to the right" })).toHaveAttribute("aria-disabled", "true");
  await menu(page).getByRole("menuitem", { name: "Close to the right" }).click({ force: true });
  await expect(titles(page)).toHaveCount(2); // nothing closed
  await page.locator(".sb-row").first().click();
  await expect(menu(page)).toHaveCount(0);
});
