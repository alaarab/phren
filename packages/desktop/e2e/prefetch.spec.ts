import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_SOURCE = path.resolve(SPEC_DIR, "../ui");
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");
// The live backlog arrives this late, so a chat that shows its transcript sooner was prefetched.
const STREAM_DELAY_MS = 1500;
let linkedUi = false;
let dir: string;
let hook: FakeHook;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;

const fixture = (name: string): Promise<unknown> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(JSON.parse);
const historyCalls = () => hook.calls.filter((call) => call.path.startsWith("/v1/transcripts/history")).length;
const streamCalls = () => hook.calls.filter((call) => call.path.startsWith("/v1/transcripts?")).length;

test.beforeAll(async () => {
  if (!existsSync(UI_LINK)) { symlinkSync(UI_SOURCE, UI_LINK, "dir"); linkedUi = true; }
  dir = await mkdtemp(path.join(tmpdir(), "desktop-prefetch-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  const [overview, transcript] = await Promise.all([fixture("overview.json"), fixture("transcript.json")]);
  hook = await startFakeHook({ dir, overviewFrames: [overview], transcriptFrames: transcript as unknown[], transcriptDelayMs: STREAM_DELAY_MS });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: "desktop-prefetch-token", computers: [LOCAL], hub, hookRequest, hookWebSocket,
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

async function openSidebar(page: Page) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  const row = page.locator(".sb-row", { hasText: "Fix login" }).first();
  await expect(row).toBeVisible();
  return row;
}
const clickToTranscript = (page: Page) =>
  page.evaluate(() => performance.getEntriesByName("phren:click-to-transcript").pop()?.duration ?? null);

test("a fly-by hover reads nothing and a resting hover reads the transcript once", async ({ page }) => {
  const row = await openSidebar(page);
  await row.hover();
  await page.waitForTimeout(60);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  expect(historyCalls()).toBe(0);
  expect(streamCalls()).toBe(0);

  await row.hover();
  await page.waitForTimeout(300);
  expect(historyCalls()).toBe(1);
  expect(streamCalls()).toBe(0); // the snapshot only: no live socket for a prefetch
});

test("a chat opened after resting on its row shows the transcript before the stream arrives", async ({ page }) => {
  const row = await openSidebar(page);
  await row.hover();
  await page.waitForTimeout(400);
  await row.click();
  // The fake Hook holds the live backlog for 1.5 s: seeing the text sooner is the snapshot.
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow", { timeout: 500 });
  const prefetched = await clickToTranscript(page);
  expect(prefetched).not.toBeNull();
  expect(prefetched!).toBeLessThan(STREAM_DELAY_MS / 2);
  test.info().annotations.push({ type: "click-to-transcript prefetched (ms)", description: String(Math.round(prefetched!)) });
  // The stream still attaches and reconciles: the transcript stays and shows once.
  await page.waitForTimeout(STREAM_DELAY_MS + 300);
  await expect(page.locator(".ct-user-bubble", { hasText: "Fix the login flow" })).toHaveCount(1);
});

test("without a hover the chat waits for the stream", async ({ page }) => {
  const row = await openSidebar(page);
  await row.click();
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow", { timeout: STREAM_DELAY_MS + 2000 });
  const fresh = await clickToTranscript(page);
  expect(fresh!).toBeGreaterThanOrEqual(STREAM_DELAY_MS * 0.8);
  test.info().annotations.push({ type: "click-to-transcript fresh (ms)", description: String(Math.round(fresh!)) });
});
