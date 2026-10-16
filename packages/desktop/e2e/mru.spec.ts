import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let unlinkUi: () => void;
let url: string;

const chat = (id: string, title: string, agentStatus: string, lastReply: string) => chatRow(id, title, agentStatus, { lastReply });
const children = [
  chat("a", "Alpha chat", "working", "Running the migration now"),
  chat("b", "Bravo chat", "blocked", "Should I delete the old table? I need your go-ahead before I continue with the rest of the cleanup."),
  chat("c", "Charlie chat", "idle", "All done, tests pass."),
];
const overview = overviewFrame(children);

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });

test.beforeEach(async ({ page }) => {
  h = await startHarness("mru", { overviewFrames: [overview] });
  url = h.url;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  // Open A, B, C in order.
  for (const title of ["Alpha chat", "Bravo chat", "Charlie chat"]) {
    await page.locator(".sb-row").filter({ has: page.locator(".sb-title", { hasText: title }) }).click();
    await expect(page.locator(".doc-tab.selected .doc-tab-title")).toHaveText(title);
  }
});

test.afterEach(async ({ page }) => {
  await page.close();
  await h.close();
});

const active = (page: Page) => page.locator(".doc-tab.selected .doc-tab-title");
const titles = (page: Page) => page.locator(".mru-card .mru-title");

test("a quick Ctrl+Tab tap toggles to the previous chat without showing the overlay", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  // Tapping again toggles back.
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Charlie chat");
});

test("holding Ctrl and pressing Tab twice lists chats newest first, selects the oldest and opens it on release", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(titles(page)).toHaveText(["Charlie chat", "Bravo chat", "Alpha chat"]);
  const list = page.getByRole("listbox", { name: "Recent chats" });
  await expect(list).toBeVisible();
  const selected = page.locator('.mru-card[aria-selected="true"]');
  await expect(selected).toHaveText(/Alpha chat/);
  await expect(list).toHaveAttribute("aria-activedescendant", (await selected.getAttribute("id"))!);
  await expect(page.locator(".mru-card").nth(1)).toContainText("Needs you");
  await expect(page.locator(".mru-card").nth(0)).toContainText("Idle");
  await expect(page.locator(".mru-card").nth(2)).toContainText("Working");
  // Shift+Tab steps back.
  await page.keyboard.press("Shift+Tab");
  await expect(selected).toHaveText(/Bravo chat/);
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await expect(active(page)).toHaveText("Alpha chat");
});

test("Esc cancels, keeps the current chat and restores focus", async ({ page }) => {
  const composer = page.locator(".doc:not([hidden]) textarea").first();
  await composer.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".mru-backdrop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Charlie chat");
  await expect(composer).toBeFocused();
});

test("clicking a card opens that chat", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.locator(".mru-card").filter({ hasText: "Bravo chat" }).click();
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
});

test("the Settings toggle turns Ctrl+Tab switching off", async ({ page }) => {
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.getByRole("button", { name: "Keys" }).first().click();
  await page.locator(".settings-toggle", { hasText: "Ctrl+Tab switches recent chats" }).locator(".track").click();
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Control");
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await expect(active(page)).toHaveText("Charlie chat");
});

test("a terminal or editor keeps Ctrl+Tab", async ({ page }) => {
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.className = "xterm";
    const input = document.createElement("textarea");
    host.append(input);
    document.body.append(host);
    input.focus();
  });
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  // Let the keydowns reach the page and a frame paint before looking for an overlay that must not appear.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await page.keyboard.up("Control");
  await expect(active(page)).toHaveText("Charlie chat");
});

test("a missed Ctrl release opens the selection on the next event with Ctrl up", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".mru-backdrop")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: false })));
  await expect(page.locator(".mru-backdrop")).toHaveCount(0);
  await expect(active(page)).toHaveText("Alpha chat");
  await page.keyboard.up("Control");
});

test("the overlay is modal and announces the selected chat", async ({ page }) => {
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("dialog", { name: "Recent chats" })).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".mru-live")).toHaveText("Alpha chat, phren on This computer, working");
  await page.keyboard.press("Escape");
  await page.keyboard.up("Control");
});
