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
  await page.keyboard.type(">Close");
  // A positive control: the same query lists another command, so hidden means hidden.
  await expect(page.getByText("Close Tab", { exact: true })).toBeVisible();
  await expect(page.getByText("Reopen closed chat")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+W");
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type(">Close");
  await expect(page.getByText("Close Tab", { exact: true })).toBeVisible();
  await expect(page.getByText("Reopen closed chat")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.getByText("Reopen closed chat").click();
  await expect(active(page)).toHaveText("Alpha chat");
});

test("a chat opened from the sidebar is no longer waiting to be reopened", async ({ page }) => {
  await openAndClose(page, ["Alpha chat", "Bravo chat"]); // closes Bravo, then Alpha
  await row(page, "Alpha chat").click();
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Bravo chat");
  await expect(page.locator(".doc-tab")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.locator(".doc-tab")).toHaveCount(2); // Alpha is open once, not twice
});

test("a chat comes back at its tab position when its tile is still there", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  for (const title of ["Alpha chat", "Bravo chat", "Charlie chat"]) await row(page, title).click();
  await page.locator(".doc-tab", { hasText: "Bravo chat" }).click();
  await page.keyboard.press("ControlOrMeta+W");
  await expect(page.locator(".doc-tab .doc-tab-title")).toHaveText(["Alpha chat", "Charlie chat"]);
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.locator(".doc-tab .doc-tab-title")).toHaveText(["Alpha chat", "Bravo chat", "Charlie chat"]);
});

test("when its tile is gone the chat opens last in the focused tile", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await row(page, "Alpha chat").click();
  await row(page, "Charlie chat").click();
  await page.keyboard.press("ControlOrMeta+\\"); // split: the new tile is focused
  await expect(page.locator(".tile")).toHaveCount(2);
  await row(page, "Bravo chat").click();
  await page.keyboard.press("ControlOrMeta+W"); // its tile was Bravo's alone, so it collapses
  await expect(page.locator(".tile")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.locator(".doc-tab .doc-tab-title")).toHaveText(["Alpha chat", "Charlie chat", "Bravo chat"]);
});

test("the key belongs to a terminal or an editor when focus is inside one", async ({ page }) => {
  await openAndClose(page, ["Alpha chat"]);
  for (const cls of ["xterm", "monaco-editor"]) {
    await page.evaluate((c) => {
      const box = document.createElement("div");
      box.className = c;
      const input = document.createElement("textarea");
      input.id = `probe-${c}`;
      box.append(input);
      document.body.append(box);
      input.focus();
    }, cls);
    await page.keyboard.press("ControlOrMeta+Shift+O");
    await page.waitForTimeout(300);
    await expect(page.locator(".doc-tab")).toHaveCount(0);
    await page.evaluate((c) => document.querySelector(`.${c}`)?.remove(), cls);
  }
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Alpha chat");
});

test("a chat whose computer has dropped off still reopens from its last-seen row, never as gone", async ({ page }) => {
  await h!.close();
  h = await startHarness("reopen-chat-peer", {
    overviewFrames: [overviewFrame([alpha])],
    peer: { name: "Devbox", options: { overviewFrames: [overviewFrame([chat("far", "Far chat")])] } },
  });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await row(page, "Far chat").click();
  await expect(active(page)).toHaveText("Far chat");
  await page.keyboard.press("ControlOrMeta+W");
  await h.peerHook!.close();
  await expect(page.locator("#sidebar .sb-cstate", { hasText: /not found|offline|unreachable/i })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(active(page)).toHaveText("Far chat");
  await expect(page.locator(".pt-toast")).toHaveCount(0);
});
