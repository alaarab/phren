import { expect, test } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const reply = [{ line: 1, raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Patched the login form." }] } } }];

test("ArrowUp in an empty composer recalls sent prompts and ArrowDown returns to empty", async ({ page }) => {
  h = await startHarness("prompt-history", { overviewFrames: [overviewFrame([chatRow("login", "Fix login", "idle")])], transcriptFrames: reply });
  await openChat(page, h.url, "Fix login", "Patched the login form");
  const input = page.locator(".pc-input");
  for (const text of ["first prompt", "second prompt"]) {
    await input.fill(text);
    await input.press("Enter");
    await expect(input).toHaveValue("");
  }
  await input.press("ArrowUp");
  await expect(input).toHaveValue("second prompt");
  await page.screenshot({ path: test.info().outputPath("prompt-history-recalled.png") });
  await input.press("ArrowUp");
  await expect(input).toHaveValue("first prompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("second prompt");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");

  // Typing is never overwritten, and the history survives a reload.
  await input.fill("half-typed");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("half-typed");
  await input.fill("");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sb-row", { hasText: "Fix login" }).first().click();
  await expect(page.locator(".pc-input")).toBeVisible();
  await page.locator(".pc-input").press("ArrowUp");
  await expect(page.locator(".pc-input")).toHaveValue("second prompt");
});
