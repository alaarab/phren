import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { linkUi, startHarness, type Harness } from "./helpers.js";

// The live backlog arrives this late, so a chat that shows its transcript sooner was prefetched. Generous, so a
// loaded runner's slow click-to-text still lands well inside it.
const STREAM_DELAY_MS = 4000;
let h: Harness;
let unlinkUi: () => void;

const fixture = (name: string): Promise<unknown> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(JSON.parse);
const historyCalls = () => h.hook.calls.filter((call) => call.path.startsWith("/v1/transcripts/history")).length;
const streamCalls = () => h.hook.calls.filter((call) => call.path.startsWith("/v1/transcripts?")).length;

test.beforeAll(async () => {
  unlinkUi = linkUi();
  const [overview, transcript] = await Promise.all([fixture("overview.json"), fixture("transcript.json")]);
  h = await startHarness("prefetch", { overviewFrames: [overview], transcriptFrames: transcript as unknown[], transcriptDelayMs: STREAM_DELAY_MS });
});

test.afterAll(async () => {
  await h?.close();
  unlinkUi();
});

// The counts below are per test: the Hook is shared, its call log is not.
test.beforeEach(() => { h.hook.calls.length = 0; });

async function openSidebar(page: Page) {
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  const row = page.locator(".sb-row", { hasText: "Fix login" }).first();
  await expect(row).toBeVisible();
  return row;
}
// The snapshot has been delivered to the page once its fetch shows as a finished resource.
const snapshotLanded = (page: Page) =>
  page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/v1/transcripts/history")).length);
const clickToTranscript = (page: Page) =>
  page.evaluate(() => performance.getEntriesByName("phren:click-to-transcript").pop()?.duration ?? null);

test("a fly-by hover reads nothing and a resting hover reads the transcript once", async ({ page }) => {
  const row = await openSidebar(page);
  await row.hover();
  await page.mouse.move(0, 0); // gone well inside the 150 ms dwell
  await page.waitForTimeout(400); // longer than dwell + request: a stray read would have landed
  expect(historyCalls()).toBe(0);
  expect(streamCalls()).toBe(0);

  await row.hover();
  await expect.poll(historyCalls).toBe(1);
  await page.waitForTimeout(300); // and it stays one
  expect(historyCalls()).toBe(1);
  expect(streamCalls()).toBe(0); // the snapshot only: no live socket for a prefetch
});

test("a chat opened after resting on its row shows the transcript before the stream arrives", async ({ page }) => {
  const row = await openSidebar(page);
  await row.hover();
  await expect.poll(() => snapshotLanded(page)).toBe(1);
  const sentBefore = h.hook.backlogsSent();
  await row.click();
  // The fake Hook holds the live backlog for STREAM_DELAY_MS: seeing the text well before then is the snapshot.
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow", { timeout: STREAM_DELAY_MS * 0.75 });
  expect(h.hook.backlogsSent()).toBe(sentBefore); // and the stream had not answered yet
  const prefetched = await clickToTranscript(page);
  expect(prefetched).not.toBeNull();
  expect(prefetched!).toBeLessThan(STREAM_DELAY_MS * 0.75);
  test.info().annotations.push({ type: "click-to-transcript prefetched (ms)", description: String(Math.round(prefetched!)) });
  // The stream still attaches and reconciles: the transcript stays and shows once.
  await expect.poll(() => h.hook.backlogsSent(), { timeout: STREAM_DELAY_MS + 5000 }).toBe(sentBefore + 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator(".ct-user-bubble", { hasText: "Fix the login flow" })).toHaveCount(1);
});

test("without a hover the chat waits for the stream", async ({ page }) => {
  const row = await openSidebar(page);
  await row.click();
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow", { timeout: STREAM_DELAY_MS + 5000 });
  const fresh = await clickToTranscript(page);
  expect(fresh!).toBeGreaterThanOrEqual(STREAM_DELAY_MS * 0.8);
  test.info().annotations.push({ type: "click-to-transcript fresh (ms)", description: String(Math.round(fresh!)) });
});
