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
  await page.screenshot({ path: test.info().outputPath("title-bravo.png") });

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
