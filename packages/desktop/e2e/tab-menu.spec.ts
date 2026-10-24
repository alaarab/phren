import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const chat = (id: string, title: string, session?: string) => {
  const row = chatRow(id, title, "idle");
  return { ...row, target: { ...row.target, session } };
};
const frame = overviewFrame([chat("alpha", "Alpha chat", "sess-alpha"), chat("bravo", "Bravo chat"), chat("charlie", "Charlie chat", "sess-charlie"), chat("delta", "Delta chat")]);
// The editor is read-only unless the computer reports file writes.
frame.phren.capabilities = { ...frame.phren.capabilities, fileWrite: true, fileSearch: true, files: true, repositoryFiles: true, fileResolution: true };

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

/** Type into the open file's editor until its tab shows the unsaved dot. */
async function dirtyFile(page: Page) {
  const doc = page.locator(".doc-file");
  await expect(doc.locator(".monaco-editor .view-line").first()).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await doc.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.type("// edit");
    await expect(page.locator(".doc-tab-file .doc-tab-title")).toHaveText(/^\u25cf /, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
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
  // The moved tab's arrows walk its new bar, not the one it left.
  const moved = page.locator(".tile").nth(1).locator(".doc-tab");
  await moved.focus();
  await page.keyboard.press("ArrowRight");
  await expect(moved).toBeFocused();
});

test("opening the command palette closes the menu and leaves the keys to the palette", async ({ page }) => {
  await openAll(page, ["Alpha", "Bravo"]);
  await tab(page, "Alpha").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.locator(".palette-input")).toBeFocused();
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(menu(page)).toHaveCount(0);
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

test("the keyboard reaches the tab bar: Tab lands on the selected tab, arrows move, Shift+F10 opens its menu", async ({ page }) => {
  await openAll(page, ["Alpha", "Bravo", "Charlie"]);
  await page.locator(".sb-row", { hasText: "Alpha chat" }).focus();
  let role = "";
  for (let i = 0; i < 60 && role !== "tab"; i++) {
    await page.keyboard.press("Tab");
    role = await page.evaluate(() => document.activeElement?.getAttribute("role") ?? "");
  }
  expect(role).toBe("tab");
  await expect(tab(page, "Charlie")).toBeFocused(); // the selected one is the only tab stop
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Bravo")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tab(page, "Alpha")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight"); // wraps
  await expect(tab(page, "Alpha")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page)).toHaveAttribute("aria-label", "Bravo chat menu");
  await page.keyboard.press("Escape");
  await expect(tab(page, "Bravo")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(tab(page, "Bravo")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Charlie")).toHaveAttribute("aria-selected", "false");
});

test("with no tab selected one tab is still a tab stop", async ({ page }) => {
  await openAll(page, ["Alpha", "Bravo"]);
  await tab(page, "Alpha").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(page.locator('.doc-tab[tabindex="0"]')).toHaveCount(1);
});

test("Close others with an unsaved file asks about the file, closes the chats and reopens them in place", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Alpha chat" }).click();
  await page.keyboard.press("ControlOrMeta+P");
  await page.keyboard.type("app");
  await page.locator(".ed-quick-item", { hasText: "src/app.ts" }).click();
  const file = page.locator(".doc-tab-file");
  await expect(file).toHaveCount(1);
  await dirtyFile(page);
  // [Alpha, app.ts, Bravo, Charlie]: the file sits between chats.
  await page.locator(".sb-row", { hasText: "Bravo chat" }).click();
  await page.locator(".sb-row", { hasText: "Charlie chat" }).click();
  await expect(titles(page)).toHaveCount(4);
  const order = await titles(page).allTextContents();
  await tab(page, "Alpha").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Close others" }).click();
  // The chats are gone, the file is front and asks.
  await expect(titles(page)).toHaveCount(2);
  await expect(page.locator(".doc-file .ed-close-ask.open")).toBeVisible();
  await expect(page.locator(".pt-toast")).toHaveCount(0); // only one unsaved file: nothing else to say
  // Cancel: the tab the menu was opened on comes back to the front.
  await page.locator(".ed-close-actions button", { hasText: "Cancel" }).click();
  await expect(active(page)).toHaveText("Alpha chat");
  await expect(titles(page)).toHaveCount(2);
  // Closed Charlie, then Bravo: Bravo reopens first, then Charlie, after the file in each case.
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await page.keyboard.press("ControlOrMeta+Shift+O");
  expect((await titles(page).allTextContents()).map((t) => t.replace("\u25cf ", ""))).toEqual(order.map((t) => t.replace("\u25cf ", "")));
});

test("Close on an inactive unsaved file brings it forward to ask", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Alpha chat" }).click();
  await page.keyboard.press("ControlOrMeta+P");
  await page.keyboard.type("app");
  await page.locator(".ed-quick-item", { hasText: "src/app.ts" }).click();
  await dirtyFile(page);
  await page.locator(".sb-row", { hasText: "Bravo chat" }).click();
  await expect(active(page)).toHaveText("Bravo chat");
  await page.locator(".doc-tab-file").click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(page.locator(".doc-file .ed-close-ask.open")).toBeVisible();
  await expect(page.locator(".doc-tab-file")).toHaveClass(/selected/);
});
