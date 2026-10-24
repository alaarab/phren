import { expect, test } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const reply = [{ line: 1, raw: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Patched the login form." }] } } }];
const withSession = (session: string | undefined) => {
  const row = chatRow("login", "Fix login", "idle");
  return { ...row, target: { ...row.target, session } };
};

test("the chat menu copies the agent session id and says Copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  h = await startHarness("copy-session", { overviewFrames: [overviewFrame([withSession("sess-fix-login")])], transcriptFrames: reply });
  await openChat(page, h.url, "Fix login", "Patched the login form");
  await page.locator(".chat-more").click();
  await page.getByRole("menuitem", { name: "Copy session id" }).click();
  await expect(page.locator(".pt-toast")).toHaveText("Copied session id");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sess-fix-login");
  await page.screenshot({ path: test.info().outputPath("copy-session-id.png") });
});

test("the item is hidden when the session id is unknown", async ({ page }) => {
  h = await startHarness("copy-session-none", { overviewFrames: [overviewFrame([withSession(undefined)])], transcriptFrames: reply });
  await openChat(page, h.url, "Fix login", "Patched the login form");
  await page.locator(".chat-more").click();
  await expect(page.getByRole("menuitem")).toHaveText(["Switch account…", "Rename", "Copy as Markdown", "Save as Markdown…", "Mute notifications"]);
});
