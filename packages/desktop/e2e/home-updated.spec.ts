import { expect, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
let dispatchStatus = 200;
let gate: Promise<void> = Promise.resolve();
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => {
  dispatchStatus = 200;
  gate = Promise.resolve();
  h = await startHarness("home-updated", {
    overviewFrames: [overviewFrame([chatRow("login", "Fix login", "working")])],
    routes: { "GET /v1/dispatch": async () => { await gate; return dispatchStatus === 200 ? { json: { dispatches: [] } } : { status: dispatchStatus, json: { error: "boom" } }; } },
  });
});
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const label = (page: import("@playwright/test").Page) => page.locator(".home-updated");
const refresh = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Refresh Home" });

test("Home says how long ago it loaded, ticks, and Refresh reloads and resets the label", async ({ page }) => {
  await page.clock.install();
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await expect(label(page)).toHaveText("Updated just now");
  await page.screenshot({ path: test.info().outputPath("home-fresh.png") });
  await page.clock.fastForward(35_000);
  await expect(label(page)).toHaveText(/Updated 3\ds ago/);
  await page.screenshot({ path: test.info().outputPath("home-aged.png") });
  const before = h!.hook.calls.filter((c) => c.path === "/v1/dispatch").length;
  let release!: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  await refresh(page).click();
  await expect(refresh(page)).toBeDisabled();
  await expect(label(page)).toHaveText(/Updated 3\ds ago/);
  release();
  await expect(refresh(page)).toBeEnabled();
  await expect(label(page)).toHaveText("Updated just now");
  expect(h!.hook.calls.filter((c) => c.path === "/v1/dispatch").length).toBeGreaterThan(before);
});

test("a failed Refresh keeps the old label and says Refresh failed", async ({ page }) => {
  await page.clock.install();
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await expect(label(page)).toHaveText("Updated just now");
  await page.clock.fastForward(35_000);
  await expect(label(page)).toHaveText(/Updated 3\ds ago/);
  dispatchStatus = 500;
  await refresh(page).click();
  await expect(page.locator(".pt-toast")).toHaveText("Refresh failed");
  await expect(label(page)).toHaveText(/Updated 3\ds ago/);
  await expect(refresh(page)).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("home-failed.png") });
  await page.clock.fastForward(5_000);
  await expect(page.locator(".pt-toast")).toHaveCount(0);
});
