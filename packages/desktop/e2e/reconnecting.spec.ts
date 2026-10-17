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
  await retry.dblclick(); // two quick presses must still leave exactly one live socket
  await expect(strip(page)).toHaveText(/Back online/, { timeout: 8000 });
  await expect(strip(page)).toBeHidden({ timeout: 4000 });
  await page.waitForTimeout(1500);
  await expect(page.locator(".ct-column").getByText("Patched the login form")).toHaveCount(1);
  await expect(strip(page)).toBeHidden();
});

test("an unreachable Hook behind a live daemon keeps counting to Can't reach, never says Back online, and backs off", async ({ page }) => {
  test.setTimeout(120_000);
  await openChat(page, h.url, "Fix login", "Patched the login form");
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __strip: string[] }).__strip = seen;
    new MutationObserver(() => { const t = document.querySelector(".chat-link")?.textContent ?? ""; if (t) seen.push(t); })
      .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  h.hook.calls.length = 0;
  h.hook.flapStreams(2000);
  await expect(strip(page)).toContainText(/Reconnecting to This computer… \d+s/, { timeout: 10_000 });
  await expect(strip(page)).toContainText("Can't reach This computer", { timeout: 45_000 });
  await expect(strip(page).getByRole("button", { name: "Retry" })).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(strip(page)).toContainText("Can't reach This computer");
  const seen = await page.evaluate(() => (window as unknown as { __strip: string[] }).__strip);
  expect(seen.some((t) => t.includes("Back online"))).toBe(false);
  const opens = h.hook.calls.filter((c) => c.path.startsWith("/v1/transcripts?")).length;
  expect(opens).toBeGreaterThan(4);
  expect(opens).toBeLessThan(12); // without a growing backoff this is ~15 in 40 s
  h.hook.flapStreams(null);
  await strip(page).getByRole("button", { name: "Retry" }).click();
  await expect(strip(page)).toHaveText(/Back online/, { timeout: 8000 });
});
