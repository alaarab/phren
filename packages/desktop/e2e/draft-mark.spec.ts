import { expect, test } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const reply = [{ line: 1, raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Patched the login form." }] } } }];
const row = (page: import("@playwright/test").Page, title: string) => page.locator(".sb-row", { hasText: title });

test("an unsent draft marks its sidebar row once you leave the chat, and sending clears it", async ({ page }) => {
  h = await startHarness("draft-mark", { overviewFrames: [overviewFrame([chatRow("login", "Fix login", "idle"), chatRow("docs", "Write docs", "idle")])], transcriptFrames: reply });
  await openChat(page, h.url, "Fix login", "Patched the login form");
  await expect(page.locator(".sb-draft")).toHaveCount(0);

  const input = page.locator(".pc-input:visible");
  await input.fill("remember to add a test");
  const key = await page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("phren.composer.draft.") && localStorage.getItem(k) === "remember to add a test") ?? "");
  expect(key).not.toBe("");
  // Shown on its own row too: the set only changes when a draft becomes empty or non-empty.
  await expect(row(page, "Fix login").locator(".sb-draft")).toBeVisible();

  await row(page, "Write docs").click();
  await expect(page.locator(".chat-title", { hasText: "Write docs" })).toBeVisible();
  await expect(row(page, "Fix login").locator(".sb-draft")).toBeVisible();
  await expect(row(page, "Write docs").locator(".sb-draft")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("draft-mark.png") });

  // Marks survive a reload for chats that are not open.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(row(page, "Fix login").locator(".sb-draft")).toBeVisible();

  await row(page, "Fix login").click();
  await expect(page.locator(".pc-input:visible")).toHaveValue("remember to add a test");
  await page.locator(".pc-input:visible").press("Enter");
  await expect(page.locator(".pc-input:visible")).toHaveValue("");
  await row(page, "Write docs").click();
  await expect(page.locator(".sb-draft")).toHaveCount(0);

  // Another window changing a draft updates the mark through the storage event.
  const fire = (newValue: string) => page.evaluate(([k, v]) => window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: v })), [key, newValue]);
  await fire("typed in another window");
  await expect(row(page, "Fix login").locator(".sb-draft")).toBeVisible();
  await fire("");
  await expect(page.locator(".sb-draft")).toHaveCount(0);

  // The 64 px icon strip has no room for the chip.
  await fire("typed again");
  await expect(row(page, "Fix login").locator(".sb-draft")).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(page.locator(".sidebar.compact")).toBeVisible();
  await expect(page.locator(".sidebar.compact .sb-draft")).toBeHidden();
});
