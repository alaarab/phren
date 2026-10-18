import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { longTranscript } from "../src/testing/fake-hook.js";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });

const fixture = (name: string): Promise<unknown> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(JSON.parse);
const OPENED = "On it. The session token is dropped before the guard runs.";
const nextFrames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test.describe("a chat that fits one page", () => {
  let h: Harness;
  test.beforeAll(async () => {
    const [overview, transcript] = await Promise.all([fixture("overview.json"), fixture("transcript.json")]);
    h = await startHarness("cmd", { overviewFrames: [overview], transcriptFrames: transcript as unknown[] });
  });
  test.afterAll(async () => { await h?.close(); });

  test("Copy as Markdown puts the chat on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openChat(page, h.url, "Fix login", OPENED);
    await page.locator(".chat-more").click();
    await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Copy as Markdown", "Save as Markdown…", "Copy session id", "Mute notifications"]);
    await page.getByRole("menuitem", { name: "Copy as Markdown" }).click();
    await expect(page.locator(".pt-toast")).toHaveText(/Copied \d+ messages?/);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split("\n")[0]).toBe("# Fix login");
    expect(text).toContain("**You**\n\nFix the login flow");
    expect(text).toContain(OPENED);
    expect(text).toContain("- Ran `pnpm test -- auth` — passed");
    expect(text).toContain("- Edited `/Users/you/phren/src/app.ts`");
    expect(text).not.toContain("Earlier messages not included");
  });

  test("Save as Markdown downloads <title>-<date>.md holding the chat", async ({ page }) => {
    await openChat(page, h.url, "Fix login", OPENED);
    await page.locator(".chat-more").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: "Save as Markdown…" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^fix-login-\d{4}-\d{2}-\d{2}\.md$/);
    const text = await readFile((await download.path())!, "utf8");
    expect(text.split("\n")[0]).toBe("# Fix login");
    expect(text).toContain(OPENED);
  });
});

test.describe("a chat with earlier pages", () => {
  const PAGE = 4;
  const ENTRIES = longTranscript(8, 1); // 16 entries; the live backlog holds the newest 4
  let h: Harness;
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let answered = 0; // older pages the Hook has let go of
  const olderCalls = () => h.hook.calls.filter((call) => call.path.startsWith("/v1/transcripts/history") && call.path.includes("beforeLine")).length;
  const toastOf = (page: Page) => page.locator(".pt-toast");
  const hold = () => { gate = new Promise<void>((resolve) => { release = resolve; }); };
  const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
  const copyAsMarkdown = async (page: Page) => {
    await page.locator(".chat-more").click();
    await page.getByRole("menuitem", { name: "Copy as Markdown" }).click();
  };

  test.beforeEach(async ({ context }) => {
    gate = Promise.resolve();
    answered = 0;
    h = await startHarness("cmd-pages", {
      overviewFrames: [overviewFrame([chatRow("fix", "Fix login", "idle")])],
      transcriptFrames: ENTRIES, transcriptPageSize: PAGE, holdOlderPages: async () => { await gate; answered += 1; },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });
  test.afterEach(async () => { release(); await h.close(); });

  test("an export loads every earlier page first and leaves nothing out", async ({ page }) => {
    await openChat(page, h.url, "Fix login", "Step 1 of answer 8");
    await copyAsMarkdown(page);
    await expect(toastOf(page).filter({ hasText: /Copied 16 messages/ })).toHaveCount(1);
    expect(olderCalls()).toBe(ENTRIES.length / PAGE - 1);
    const text = await clipboard(page);
    expect(text).toContain("Fix the login flow"); // prompt 1, only on the oldest page
    expect(text).toContain("Wrap up with a summary");
    expect(text).not.toContain("Earlier messages not included");
  });

  test("Cancel stops a slow export: nothing is copied and the next export still completes", async ({ page }) => {
    await openChat(page, h.url, "Fix login", "Step 1 of answer 8");
    await page.evaluate(() => navigator.clipboard.writeText("untouched"));
    hold();
    await copyAsMarkdown(page);
    await expect(toastOf(page)).toContainText("Loading earlier messages");
    await expect.poll(olderCalls).toBe(1);
    await toastOf(page).getByRole("button", { name: "Cancel" }).click();
    await expect(toastOf(page)).toHaveCount(0);
    release();
    // The held request is answered now (the client has already given up on it): no copy, no toast.
    await expect.poll(() => answered).toBe(1);
    await nextFrames(page);
    await expect(toastOf(page)).toHaveCount(0);
    expect(await clipboard(page)).toBe("untouched");

    await copyAsMarkdown(page);
    await expect(toastOf(page).filter({ hasText: /Copied 16 messages/ })).toHaveCount(1);
    expect(await clipboard(page)).toContain("Fix the login flow");
  });

  test("closing the chat mid-export writes nothing", async ({ page }) => {
    await openChat(page, h.url, "Fix login", "Step 1 of answer 8");
    await page.evaluate(() => navigator.clipboard.writeText("untouched"));
    hold();
    await copyAsMarkdown(page);
    await expect.poll(olderCalls).toBe(1);
    await page.locator(".doc-tab.selected .doc-tab-close").click();
    await expect(page.locator(".chat-title")).toHaveCount(0);
    release();
    await expect.poll(() => answered).toBe(1);
    await nextFrames(page);
    await expect(toastOf(page).filter({ hasText: /Copied|Saved/ })).toHaveCount(0);
    expect(await clipboard(page)).toBe("untouched");
  });
});
