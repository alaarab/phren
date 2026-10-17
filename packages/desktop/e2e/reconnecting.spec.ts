import { expect, test, type Page } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness;
let unlinkUi: () => void;

test.beforeEach(async () => {
  unlinkUi = linkUi();
  h = await startHarness("reconnect", {
    overviewFrames: [overviewFrame([chatRow("login", "Fix login", "working")])],
    transcriptFrames: [{ line: 1, raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Patched the login form." }] } } }],
  });
});
test.afterEach(async () => { await h?.close(); unlinkUi(); });

const strip = (page: Page) => page.locator(".chat-link");

test("a dropped link shows a counting strip, then Back online, then nothing, and the backlog reloads", async ({ page }) => {
  await openChat(page, h.url, "Fix login", "Patched the login form");
  await expect(strip(page)).toBeHidden();
  const before = h.hook.backlogsSent();
  h.hook.holdStreams(true);
  await expect(strip(page)).toContainText(/Reconnecting to This computer… \d+s/, { timeout: 8000 });
  await expect(strip(page)).toHaveAttribute("role", "status");
  await page.waitForTimeout(2200);
  const seconds = Number((await strip(page).innerText()).match(/(\d+)s/)![1]);
  expect(seconds).toBeGreaterThanOrEqual(4);
  h.hook.holdStreams(false);
  await expect(strip(page)).toHaveText(/Back online/, { timeout: 8000 });
  await expect(strip(page)).toBeHidden({ timeout: 4000 });
  expect(h.hook.backlogsSent()).toBeGreaterThan(before);
  await expect(page.locator(".ct-column")).toContainText("Patched the login form");
});

test("a long outage says it cannot reach the computer and Retry reconnects", async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page, h.url, "Fix login", "Patched the login form");
  h.hook.holdStreams(true);
  await expect(strip(page)).toContainText("Can't reach This computer", { timeout: 45_000 });
  const retry = strip(page).getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  h.hook.holdStreams(false);
  await retry.click();
  await expect(strip(page)).toHaveText(/Back online/, { timeout: 8000 });
  await expect(strip(page)).toBeHidden({ timeout: 4000 });
});
