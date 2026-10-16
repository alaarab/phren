import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
let url: string;

const chat = (id: string, title: string, source: string) => chatRow(id, title, "working", {
  agent: source, target: { server: "default", workspace: "1", tab: id, pane: id, source, session: id },
});
const oldChat = chat("login-claude", "Fix login", "claude");
const newChat = chat("login-codex", "Fix login (Codex)", "codex");
const children = [
  { ...oldChat, handedOffTo: { target: newChat.target, harness: "codex", title: newChat.title } },
  { ...newChat, handedOffFrom: { target: oldChat.target, harness: "claude", title: oldChat.title } },
];
const overview = (rows = children) => overviewFrame(rows);

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });

test.beforeEach(async ({ page }) => {
  h = await startHarness("handoff", { overviewFrames: [overview()] });
  url = h.url;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-block="working"] .home-row')).toHaveCount(2);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await h?.close();
  h = undefined;
});

async function sidebar(page: Page) {
  await page.locator('.section-pill[data-section="agents"]').click();
  return page.locator(".sb-row").filter({ has: page.locator(".sb-title", { hasText: /^Fix login$/ }) });
}

async function openedChat(page: Page, title: string) {
  await expect(page.locator(".doc-tab")).toHaveCount(1);
  await expect(page.locator(".doc-tab.selected .doc-tab-title")).toHaveText(title);
  await expect(page.locator(".chat-title")).toHaveText(title);
}

test("sidebar dims the old chat and its hand-off tag opens Codex", async ({ page }) => {
  const row = await sidebar(page);
  await expect(row).toBeVisible();
  // Measure effective title opacity: the dimming may live on its parent.
  const opacity = await row.locator(".sb-title").evaluate((title) => {
    let value = 1;
    for (let node: Element | null = title; node && !node.classList.contains("sb-row"); node = node.parentElement) {
      value *= Number(getComputedStyle(node).opacity);
    }
    return value;
  });
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await row.getByRole("button", { name: "→ Codex", exact: true }).click();
  await openedChat(page, newChat.title);
});

test("Tab then Enter on the hand-off tag opens only the new chat", async ({ page }) => {
  const row = await sidebar(page);
  const tag = row.getByRole("button", { name: "→ Codex", exact: true });
  await row.focus();
  // Use native tab order rather than focusing the nested button directly.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    if (await tag.evaluate((button) => button === document.activeElement)) break;
  }
  await expect(tag).toBeFocused();
  await page.keyboard.press("Enter");
  await openedChat(page, newChat.title);
});

test("Enter on the sidebar row itself opens the old chat", async ({ page }) => {
  const row = await sidebar(page);
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await openedChat(page, oldChat.title);
});

test("Home Working hand-off rows fill the list with tags on their metadata line", async ({ page }) => {
  const list = page.locator('[data-block="working"] .home-list');
  const rows = list.locator(".home-working");
  const oldRow = rows.filter({ has: page.getByText(oldChat.title, { exact: true }) });
  const newRow = rows.filter({ has: page.getByText(newChat.title, { exact: true }) });
  await expect(oldRow.locator(".home-row-meta").getByRole("button", { name: "→ Codex", exact: true })).toBeVisible();
  await expect(newRow.locator(".home-row-meta").getByRole("button", { name: "← from Fix login", exact: true })).toBeVisible();
  const listBox = await list.boundingBox();
  const oldBox = await oldRow.boundingBox();
  const newBox = await newRow.boundingBox();
  expect(listBox).not.toBeNull();
  expect(oldBox).not.toBeNull();
  expect(newBox).not.toBeNull();
  expect(oldBox!.width).toBeCloseTo(newBox!.width, 0);
  for (const box of [oldBox!, newBox!]) {
    expect(box.x).toBeCloseTo(listBox!.x, 0);
    expect(box.width).toBeCloseTo(listBox!.width, 0);
  }
});

test("removing the destination leaves an informational tag without a link", async ({ page }) => {
  const row = await sidebar(page);
  await expect(row.getByRole("button", { name: "→ Codex", exact: true })).toBeVisible();
  h!.hook.pushOverview(overview([children[0]]));
  await expect(page.locator(".sb-row")).toHaveCount(1);
  await expect(row.locator(".handoff-tag")).toHaveText("→ Codex");
  await expect(row.getByRole("button", { name: "→ Codex", exact: true })).toHaveCount(0);
  await expect(row.getByRole("link", { name: "→ Codex", exact: true })).toHaveCount(0);
  await expect(row.locator(".handoff-tag")).toHaveJSProperty("tabIndex", -1);
  await page.locator('.section-pill[data-section="home"]').click();
  const home = page.locator('[data-block="working"] .home-row');
  await expect(home).toHaveCount(1);
  await expect(home.locator(".home-row-meta .handoff-tag")).toHaveText("→ Codex");
  await expect(home.locator(".handoff-tag")).toHaveJSProperty("tabIndex", -1);
});
