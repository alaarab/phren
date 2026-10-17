import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const chat = (id: string, title: string, agentStatus: string, lastReply = "") =>
  chatRow(id, title, agentStatus, { lastChangedAt: "2026-10-16T09:00:00.000Z", lastReply });
const frame = (alpha: string, bravo: string) => overviewFrame([
  chat("alpha", "Alpha chat", alpha, alpha === "waiting" ? "Open a PR?" : ""),
  chat("bravo", "Bravo chat", bravo, bravo === "waiting" ? "Which section first?" : ""),
]);

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async ({ page }) => {
  h = await startHarness("chat-mute", { overviewFrames: [frame("working", "working")] });
  // The Electron preload's shell, recording notifications and the dock badge.
  await page.addInitScript(() => {
    const notes: unknown[][] = [];
    const badges: number[] = [];
    Object.assign(window, { __notes: notes, __badges: badges, phrenDesktop: { platform: "darwin", notify: (...args: unknown[]) => notes.push(args), setBadge: (n: number) => badges.push(n), onOpenSession() {} } });
  });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.removeItem("phren.desktop.muted"); localStorage.removeItem("phren.desktop.quiet"); });
});
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const notes = (page: Page) => page.evaluate(() => (window as unknown as { __notes: string[][] }).__notes.map((n) => n[1]));
const lastBadge = (page: Page) => page.evaluate(() => (window as unknown as { __badges: number[] }).__badges.at(-1));
const row = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

async function muteFromMenu(page: Page, title: string) {
  await row(page, title).click();
  await expect(page.locator(".chat-title", { hasText: title })).toBeVisible();
  await page.locator(".chat-more").click();
  await page.getByRole("menuitem", { name: "Mute notifications" }).click();
}

test("a muted chat that turns waiting sends no notification and no badge count; an unmuted one does", async ({ page }) => {
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(2);
  await muteFromMenu(page, "Alpha chat");
  await expect(page.locator(".chat-muted")).toBeVisible();
  await expect(row(page, "Alpha chat").locator(".sb-muted")).toHaveAttribute("title", "Notifications muted");
  await expect(row(page, "Bravo chat").locator(".sb-muted")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("phren.desktop.muted") ?? "[]"))).toEqual(["This computer/alpha"]);

  h!.hook.pushOverview(frame("waiting", "waiting"));
  await expect.poll(() => notes(page)).toEqual([expect.stringContaining("Bravo chat")]);
  // Both show in the sidebar's and Home's needs-you, but only Bravo counts on the dock icon.
  await expect(page.locator("#needs-pill")).toHaveText("2 need you");
  await expect.poll(() => lastBadge(page)).toBe(1);
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await expect(page.locator('[data-block="needs"] .home-row')).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("mute-home.png") });
  expect(await notes(page)).toHaveLength(1);
});

test("Unmute notifications restores notices, and the choice survives a reload", async ({ page }) => {
  await page.locator('.section-pill[data-section="agents"]').click();
  await muteFromMenu(page, "Alpha chat");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(row(page, "Alpha chat").locator(".sb-muted")).toBeVisible();
  await row(page, "Alpha chat").click();
  await page.locator(".chat-more").click();
  await page.getByRole("menuitem", { name: "Unmute notifications" }).click();
  await expect(page.locator(".sb-muted")).toHaveCount(0);
  await expect(page.locator(".chat-muted")).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("phren.desktop.muted") ?? "[]"))).toEqual([]);

  h!.hook.pushOverview(frame("waiting", "working"));
  await expect.poll(() => notes(page)).toEqual([expect.stringContaining("Alpha chat")]);
});

test("a muted key for a chat that has gone is dropped from storage once it has been gone a while", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("phren.desktop.muted", JSON.stringify(["This computer/ghost", "This computer/alpha"])));
  await page.clock.install();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(2);
  await page.clock.fastForward(61_000);
  h!.hook.pushOverview(frame("working", "idle"));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("phren.desktop.muted") ?? "[]"))).toEqual(["This computer/alpha"]);
});
