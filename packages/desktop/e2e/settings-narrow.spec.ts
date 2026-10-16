import { expect, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const PAGES = ["Computers", "Keys", "Extensions", "Appearance", "Notifications", "Diagnostics", "About"];

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => {
  h = await startHarness("settings-narrow", {
    overviewFrames: [overviewFrame([chatRow("fix", "Fix login", "idle")])],
    peer: { name: "build-box-with-a-rather-long-hostname.example.internal" },
  });
});
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

for (const width of [360, 390, 420]) {
  test(`every Settings page fits ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(h!.url, { waitUntil: "domcontentloaded" });
    await page.locator('.section-pill[data-section="settings"]').click();
    for (const name of PAGES) {
      await page.locator(".settings-tab", { hasText: name }).click();
      await page.waitForTimeout(250);
      const report = await page.evaluate(() => {
        const doc = document.scrollingElement!;
        const shown = document.querySelector(".settings-page:not([hidden])")!;
        const out: string[] = [];
        for (const e of [...document.querySelectorAll(".settings-tab"), ...shown.querySelectorAll("button, input, select, textarea, a[href]")]) {
          const r = (e as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // A control inside its own horizontal scroller is reachable by scrolling it.
          let p = e.parentElement;
          let scroller: HTMLElement | null = null;
          while (p && p !== document.body) {
            const ox = getComputedStyle(p).overflowX;
            if (ox === "auto" || ox === "scroll") { scroller = p; break; }
            p = p.parentElement;
          }
          if (scroller) {
            const pr = scroller.getBoundingClientRect();
            if (pr.right <= innerWidth + 0.5 && pr.left >= -0.5) continue;
          }
          if (r.left < -0.5 || r.right > innerWidth + 0.5) out.push(`${e.tagName}.${(e as HTMLElement).className} ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
        // The section clips its own overflow, so the document never scrolls: the page body must not either.
        const body = document.querySelector(".settings-body")!;
        if (body.scrollWidth > body.clientWidth) out.push(`.settings-body scrolls ${body.scrollWidth}/${body.clientWidth}`);
        if (body.getBoundingClientRect().width < innerWidth - 1) out.push(`.settings-body only ${body.getBoundingClientRect().width} wide`);
        return { scroll: doc.scrollWidth, inner: innerWidth, out };
      });
      expect(report.scroll, `${name} document width`).toBeLessThanOrEqual(report.inner);
      expect(report.out, `${name} controls outside the viewport`).toEqual([]);
    }
  });
}

test("Settings keeps its sidebar list at desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="settings"]').click();
  const nav = await page.locator(".settings-nav").boundingBox();
  expect(nav!.width).toBeGreaterThan(150);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".settings-nav")!).flexDirection)).toBe("column");
});
