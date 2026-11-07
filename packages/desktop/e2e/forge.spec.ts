import { expect, test } from "@playwright/test";
import { linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";
let h: Harness | undefined;
let unlink: () => void;
test.beforeAll(() => { unlink = linkUi(); });
test.afterAll(() => unlink());
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

test("CI labels the missing route and offers an explicit preview with searchable coloured logs", async ({ page }) => {
  h = await startHarness("forge", { overviewFrames: [overviewFrame([])] });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-group="work"]').click();
  await page.locator('.section-sub[data-section="forge"]').click();
  const ci = page.locator(".forge");
  await expect(ci.getByRole("button", { name: "Live CI unavailable" })).toBeDisabled();
  await expect(ci.locator(".forge-notice")).toContainText("new Phren Hook routes");
  await ci.getByRole("button", { name: "Preview gitboy", exact: true }).click();
  await expect(ci.locator(".forge-notice")).toContainText("sample data");
  await ci.getByRole("button", { name: /#41 Keep project navigation/ }).click();
  await ci.getByRole("button", { name: /^Failed Test/ }).click();
  await expect(ci.locator(".forge-log")).toContainText("Error: assertion failed");
  await expect(ci.locator(".forge-log")).toContainText("<img src=x onerror=alert(1)>");
  await expect(ci.locator(".forge-log img")).toHaveCount(0);
  await expect(ci.locator(".forge-ansi-danger")).toContainText("Error: assertion failed");
  await ci.getByRole("searchbox", { name: "Find in log" }).fill("assertion");
  await expect(ci.locator("mark")).toHaveText("assertion");
  await expect(ci.getByRole("status").first()).toHaveText("1 of 1 matches");
  await ci.getByRole("button", { name: "‹ Jobs" }).click();
  await expect(ci.locator(".forge-step")).toContainText(["Checkout", "Compile", "Install dependencies", "Run tests"]);
  // Preview never attempts invented Hook routes.
  expect(h.hook.calls.some((call) => call.path.includes("/forge/"))).toBe(false);
});
