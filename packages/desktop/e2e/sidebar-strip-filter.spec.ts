import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const children = [
  chatRow("fix", "Fix login redirect", "waiting"),
  chatRow("docs", "Review the docs", "working"),
  chatRow("index", "Migrate the index", "idle"),
];

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => { h = await startHarness("strip-filter", { overviewFrames: [overviewFrame(children)] }); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const button = (page: Page) => page.locator("#sidebar .sb-strip-filter");
const input = (page: Page) => page.locator(".sb-filter-input");

async function openStrip(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator("#sidebar")).toHaveClass(/compact/);
  await expect(page.locator(".sb-row")).toHaveCount(3);
}

test("the strip's filter button expands it and focuses the box", async ({ page }) => {
  await openStrip(page);
  const mac = await page.evaluate(() => /mac/i.test(navigator.userAgent));
  const label = `Filter sessions (${mac ? "⌘⇧E" : "Ctrl+Shift+E"})`;
  await expect(button(page)).toBeVisible();
  await expect(button(page)).toHaveAttribute("aria-label", label);
  await expect(button(page)).toHaveAttribute("title", label);
  await expect(input(page)).toBeHidden();
  await button(page).click();
  await expect(page.locator("#sidebar")).not.toHaveClass(/compact/);
  await expect(input(page)).toBeFocused();
  await expect(button(page)).toBeHidden();
});

test("the label follows the binding and aria-pressed follows the filter", async ({ page }) => {
  await openStrip(page);
  await expect(button(page)).toHaveAttribute("aria-pressed", "false");
  await button(page).click();
  await input(page).fill("login");
  await page.locator(".doc-sidebar-toggle").click();
  await expect(button(page)).toHaveAttribute("aria-pressed", "true");
});

test("a dot shows while a filter is active, also in the strip", async ({ page }) => {
  await openStrip(page);
  await expect(page.locator(".sb-strip-dot")).toBeHidden();
  await button(page).click();
  await input(page).fill("login");
  await expect(page.locator(".sb-row")).toHaveCount(1);
  // Collapse the strip again: the filter still narrows the rows and the button says so.
  await page.locator(".doc-sidebar-toggle").click();
  await expect(page.locator("#sidebar")).toHaveClass(/compact/);
  await expect(button(page)).toBeVisible();
  await expect(page.locator(".sb-strip-dot")).toBeVisible();
  await button(page).click();
  await expect(input(page)).toBeFocused();
  await input(page).press("Escape");
  await page.locator(".doc-sidebar-toggle").click();
  await expect(page.locator(".sb-row")).toHaveCount(3);
  await expect(page.locator(".sb-strip-dot")).toBeHidden();
});
