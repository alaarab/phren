import { expect, test } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const transcript = [
  { line: 1, raw: { type: "user", uuid: "u1", message: { role: "user", content: "Why does the login form reset?" } } },
  { line: 2, raw: { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "The form remounted on every keystroke; I patched the key." }] } } },
];

test("hovering a message shows Copy, which copies its text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  h = await startHarness("copy-message", { overviewFrames: [overviewFrame([chatRow("login", "Fix login", "idle")])], transcriptFrames: transcript });
  await openChat(page, h.url, "Fix login", "I patched the key");
  const answer = page.locator(".ct-assistant-row").first();
  const copy = answer.locator(".ct-copy");
  await expect(copy).toHaveCSS("opacity", "0");
  await answer.hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await page.screenshot({ path: test.info().outputPath("copy-message-hover.png") });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("The form remounted on every keystroke; I patched the key.");

  const prompt = page.locator(".ct-user-row").first();
  await prompt.hover();
  await prompt.locator(".ct-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Why does the login form reset?");
});
