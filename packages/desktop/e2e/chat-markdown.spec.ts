import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");
let linkedUi = false;
let dir: string;
let hook: FakeHook;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;

const fixture = (name: string): Promise<unknown> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(JSON.parse);

test.beforeAll(async () => {
  if (!existsSync(UI_LINK)) { symlinkSync(path.resolve(SPEC_DIR, "../ui"), UI_LINK, "dir"); linkedUi = true; }
  dir = await mkdtemp(path.join(tmpdir(), "desktop-cmd-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  const [overview, transcript] = await Promise.all([fixture("overview.json"), fixture("transcript.json")]);
  hook = await startFakeHook({ dir, overviewFrames: [overview], transcriptFrames: transcript as unknown[] });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (m: MergedOverview) => { if (m.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-chat-markdown-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
});

test.afterAll(async () => {
  hub?.stop();
  await closeServer?.();
  await hook?.close();
  await rm(dir, { recursive: true, force: true });
  if (linkedUi) { try { unlinkSync(UI_LINK); } catch { /* already gone */ } }
  delete process.env.PHREN_BRIDGE_HOME;
});

async function openChat(page: import("@playwright/test").Page) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await expect(page.locator(".ct-column")).toContainText("On it. The session token is dropped before the guard runs.");
}

test("Copy as Markdown puts the chat on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openChat(page);
  await page.locator(".chat-more").click();
  await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Copy as Markdown", "Save as Markdown…"]);
  await page.getByRole("menuitem", { name: "Copy as Markdown" }).click();
  await expect(page.locator(".pt-toast")).toHaveText(/Copied \d+ messages?/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.split("\n")[0]).toBe("# Fix login");
  expect(text).toContain("**You**\n\nFix the login flow");
  expect(text).toContain("On it. The session token is dropped before the guard runs.");
  expect(text).toContain("- Ran `pnpm test -- auth` — passed");
  expect(text).toContain("- Edited `/Users/you/phren/src/app.ts`");
});

test("Save as Markdown downloads <title>-<date>.md", async ({ page }) => {
  await openChat(page);
  await page.locator(".chat-more").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Save as Markdown…" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^fix-login-\d{4}-\d{2}-\d{2}\.md$/);
});
