import { expect, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const LONG = "Refactor the checkout flow so that totals, taxes and shipping are computed once on the server";
const frame = (alpha: string, alphaStatus = "idle") => overviewFrame([chatRow("alpha", alpha, alphaStatus), chatRow("bravo", "Bravo chat", "idle"), chatRow("long", LONG, "idle")]);
const row = (page: import("@playwright/test").Page, title: string) => page.locator(".sb-row", { hasText: title }).first();

test("the window title follows the active chat, its rename, the section and the needs-you count", async ({ page }) => {
  h = await startHarness("window-title", { overviewFrames: [frame("Alpha chat")] });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  await expect(page).toHaveTitle("Agents — Phren");

  await row(page, "Alpha chat").click();
  await expect(page).toHaveTitle("Alpha chat — Phren");
  await row(page, "Bravo chat").click();
  await expect(page).toHaveTitle("Bravo chat — Phren");

  // Another tab in the same section: switching back by its tab.
  await page.locator(".doc-tab", { hasText: "Alpha chat" }).click();
  await expect(page).toHaveTitle("Alpha chat — Phren");

  // A rename from the Hook shows at once.
  h.hook.pushOverview(frame("Alpha renamed"));
  await expect(page).toHaveTitle("Alpha renamed — Phren");

  // The needs-you count prefixes it, and clears with it.
  h.hook.pushOverview(frame("Alpha renamed", "waiting"));
  await expect(page).toHaveTitle("(1) Alpha renamed — Phren");

  await page.locator(".section-pill", { hasText: "Home" }).click();
  await expect(page).toHaveTitle("(1) Home — Phren");
  await page.locator(".section-pill", { hasText: "Projects" }).click();
  await expect(page).toHaveTitle("(1) Projects — Phren");
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page).toHaveTitle("(1) Alpha renamed — Phren");

  h.hook.pushOverview(frame("Alpha renamed"));
  await expect(page).toHaveTitle("Alpha renamed — Phren");

  // Long titles clip.
  await row(page, "Refactor the checkout").click();
  const title = await page.title();
  expect(title.endsWith("… — Phren")).toBe(true);
  expect([...title.replace(" — Phren", "")]).toHaveLength(60);
});

test("a focused Shell tab names the section, and focusing each tile switches the title", async ({ page }) => {
  h = await startHarness("window-title-tiles", { overviewFrames: [frame("Alpha chat")] });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await row(page, "Alpha chat").click();
  await expect(page).toHaveTitle("Alpha chat — Phren");

  await page.locator('.layout-btn[data-act="terminal"]').click(); // a shell in a new tile
  await expect(page.locator(".doc-tab", { hasText: /Shell|Terminal/ })).toBeVisible();
  await expect(page).toHaveTitle("Agents — Phren");

  await page.locator(".doc-tab", { hasText: "Alpha chat" }).click(); // back to the chat's tile
  await expect(page).toHaveTitle("Alpha chat — Phren");
  await page.locator(".doc-tab", { hasText: /Shell|Terminal/ }).click();
  await expect(page).toHaveTitle("Agents — Phren");

  // An empty tile: splitting focuses it, and clicking back into it after the chat names the section again.
  await page.locator(".doc-tab", { hasText: "Alpha chat" }).click();
  await expect(page).toHaveTitle("Alpha chat — Phren");
  await page.locator(".layout-btn", { hasText: "Split →" }).click();
  await expect(page.locator(".tile-empty:visible")).toHaveCount(1);
  await expect(page).toHaveTitle("Agents — Phren");
  await page.locator(".doc-tab", { hasText: "Alpha chat" }).click();
  await expect(page).toHaveTitle("Alpha chat — Phren");
  await page.locator(".tile-empty:visible").click({ position: { x: 5, y: 5 } });
  await expect(page).toHaveTitle("Agents — Phren");

  // Closing the chat's last tab collapses its tile into the empty one: nothing is open, so no chat title.
  await page.locator(".doc-tab", { hasText: /Shell|Terminal/ }).locator(".doc-tab-close").click({ force: true });
  await page.locator(".doc-tab", { hasText: "Alpha chat" }).click();
  await expect(page).toHaveTitle("Alpha chat — Phren");
  await page.locator(".doc-tab", { hasText: "Alpha chat" }).locator(".doc-tab-close").click({ force: true });
  await expect(page.locator(".doc-tab")).toHaveCount(0);
  await expect(page).toHaveTitle("Agents — Phren");
});

test("Settings can keep the chat title out of the window title", async ({ page }) => {
  h = await startHarness("window-title-privacy", { overviewFrames: [frame("Alpha chat")] });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await row(page, "Alpha chat").click();
  await expect(page).toHaveTitle("Alpha chat — Phren");
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Appearance" }).click();
  const toggle = page.locator(".settings-toggle", { hasText: "Show the chat's title in the window title" });
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("settings-toggle.png") });
  await toggle.locator(".track").click();
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page).toHaveTitle("Agents — Phren");
  await page.evaluate(() => localStorage.removeItem("phren.desktop.title-chat"));
});
