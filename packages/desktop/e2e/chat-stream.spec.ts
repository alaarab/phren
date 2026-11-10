import { expect, test } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const transcript = [
  { line: 1, raw: { type: "user", uuid: "u1", message: { role: "user", content: "Summarize what changed." } } },
  { line: 2, raw: { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "Reading the diff." }] } } },
];

const REPLY = [
  "Two files changed.",
  "",
  "1. The **guard** in `src/guard.ts` restores the token *before* it redirects.",
  "2. `src/cache.ts` caches each lookup for one minute.",
  "",
  "| File | Change |",
  "| --- | --- |",
  "| `src/guard.ts` | reorder |",
  "",
  "```ts",
  "const TTL_MS = 60_000;",
  "```",
  "",
  "See https://git.example.com/pull/12 for the rest.",
].join("\n");

test("a reply arriving is paced into one row and never shows its Markdown half-written", async ({ page }) => {
  h = await startHarness("chat-stream", { overviewFrames: [overviewFrame([chatRow("sum", "Summarize", "working")])], transcriptFrames: transcript });
  await openChat(page, h.url, "Summarize", "Reading the diff.");

  // Every frame: what the arriving reply shows, and how many times its row was put into the transcript.
  await page.evaluate(() => {
    const seen = { lengths: [] as number[], markup: [] as string[], rows: 0 };
    (window as unknown as { seen: typeof seen }).seen = seen;
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if ((node as Element).classList?.contains("ct-preview")) seen.rows += 1;
    }).observe(document.querySelector(".ct-column")!, { childList: true });
    const read = () => {
      const text = document.querySelector(".ct-preview .ct-md")?.textContent;
      if (text !== undefined) {
        seen.lengths.push(text.length);
        for (const raw of ["**", "`", "| ", "](", "*before"]) if (text.includes(raw) && !seen.markup.includes(raw)) seen.markup.push(raw);
      }
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  });

  const turnStartedAt = new Date().toISOString();
  const parts = 6;
  for (let part = 1; part <= parts; part++) {
    h.hook.pushTranscript(undefined, { type: "preview", source: "claude", preview: { turnStartedAt, text: REPLY.slice(0, Math.ceil((REPLY.length * part) / parts)), streamed: true } });
    await page.waitForTimeout(500);
  }

  const preview = page.locator(".ct-preview");
  await expect(preview.locator(".ct-md-link")).toHaveText("https://git.example.com/pull/12");
  await expect(preview.locator("ol.ct-md-list > li")).toHaveCount(2);
  await expect(preview.locator("em")).toHaveText("before");
  await expect(preview.locator(".ct-md-table tbody tr")).toHaveCount(1);
  await expect(preview.locator(".ct-md-pre code")).toHaveText("const TTL_MS = 60_000;");
  // The caret ends the last line of prose rather than sitting under it.
  await expect(preview.locator(".ct-md-p:last-of-type > .ct-caret")).toHaveCount(1);

  const seen = await page.evaluate(() => (window as unknown as { seen: { lengths: number[]; markup: string[]; rows: number } }).seen);
  expect(seen.rows).toBe(1);
  expect(seen.markup).toEqual([]);
  // Paced: the text grew on many frames, never by a whole Hook update at once.
  const steps = seen.lengths.slice(1).map((length, i) => length - seen.lengths[i]).filter((step) => step !== 0);
  expect(steps.length).toBeGreaterThan(40);
  expect(Math.max(...steps)).toBeLessThan(REPLY.length / parts);
  expect(steps.every((step) => step > 0)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("chat-stream.png") });
});
