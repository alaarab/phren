import { expect, test } from "@playwright/test";
import { linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => unlinkUi());
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

test("watch, drive, release on tab change, and seek recording handoffs", async ({ page }) => {
  const startedAt = 1_800_000_000_000;
  const browser = { id: "browser_123", live: true, session: "Checkout agent", startedAt,
    help: { reason: "Sign in to continue", t: startedAt },
    pages: [{ id: "page_1234", live: true, title: "Checkout", url: "https://shop.test/cart", width: 400, height: 200 }] };
  const meta = { ...browser, browserId: browser.id, endedAt: startedAt + 5000, frames: 2,
    pages: [{ pageId: "page_1234", title: "Checkout", url: "https://shop.test/cart", t: startedAt }],
    navigations: [{ pageId: "page_1234", title: "Checkout", url: "https://shop.test/cart", t: startedAt }],
    handoffs: [{ t: startedAt + 2000, kind: "help", reason: "Sign in" }, { t: startedAt + 4000, kind: "take" }] };
  const jpeg = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 200;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "white"; ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = "black"; ctx.fillText("Checkout", 20, 30);
    return canvas.toDataURL("image/jpeg").split(",")[1];
  }), "base64");
  const overview = overviewFrame([]);
  Object.assign(overview.phren.capabilities, { browsers: true });
  h = await startHarness("browsers", { overviewFrames: [overview], routes: {
    "GET /v1/browsers": () => ({ json: { browsers: [browser] } }),
    "GET /v1/browsers/recordings": () => ({ json: { recordings: [meta] } }),
    "GET /v1/browsers/recordings/index": () => ({ json: { meta, frames: [0, 1].map(n => ({ n, t: startedAt + n * 3000, pageId: "page_1234", width: 400, height: 200 })) } }),
    "GET /v1/browsers/recordings/frame": () => ({ body: jpeg, contentType: "image/jpeg" }),
  } });
  // The existing helper scripts HTTP but not arbitrary WebSockets. Intercept just
  // the browser stream, leaving overview and browser HTTP on the real daemon proxy.
  const messages: Array<Record<string, unknown>> = [];
  await page.routeWebSocket(/\/hosts\/.*\/v1\/browsers\/stream\?/, ws => {
    ws.send(JSON.stringify({ type: "start", page: "page_1234", title: "Checkout", url: "https://shop.test/cart", width: 400, height: 200 }));
    ws.send(JSON.stringify({ type: "control", holder: "other", help: browser.help })); ws.send(jpeg);
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw)); messages.push(message);
      if (message.type === "control") ws.send(JSON.stringify({ type: "control", holder: message.action === "take" ? "you" : null, help: message.action === "take" ? browser.help : null }));
    });
  });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-group="fleet"]').click();
  await page.locator('.section-sub[data-section="browsers"]').click();
  await expect(page.locator(".br-badge")).toHaveText("Needs you");
  await page.locator(".br-row").first().click();
  await expect(page.locator(".br-help")).toContainText("Checkout agent needs you: Sign in to continue");
  await expect(page.locator(".br-driving")).toHaveText("Driving on another device");
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeVisible();
  await expect.poll(() => messages.some(m => m.type === "ack")).toBe(true);
  await page.locator(".br-help button").click();
  await expect(page.locator(".br-driving")).toHaveText("You're driving");
  const screen = page.locator(".br-screen");
  await screen.click(); // the centre of a contained image is always inside it
  await page.keyboard.type("hello"); await page.keyboard.press("Enter");
  await expect.poll(() => messages.filter(m => m.event === "click").length).toBe(1);
  await expect.poll(() => messages.some(m => m.event === "key" && m.key === "Enter")).toBe(true);
  const click = messages.find(m => m.event === "click")!;
  expect(click.x).toBeCloseTo(.5, 2); expect(click.y).toBeCloseTo(.5, 2);
  expect(messages.filter(m => m.event === "text").map(m => m.text).join("")).toBe("hello");
  expect(messages).toContainEqual({ type: "input", event: "key", key: "Enter" });
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await expect(page.locator(".br-driving")).toHaveText("Watching");
  await page.locator(".br-toolbar").getByRole("button", { name: "Take control", exact: true }).click();
  await expect(page.locator(".br-driving")).toHaveText("You're driving");
  await page.locator(".br-row").nth(1).click();
  await expect.poll(() => messages.filter(m => m.type === "control" && m.action === "release").length).toBe(2);
  await page.getByRole("button", { name: "0:04 · Took control", exact: true }).click();
  const scrub = page.getByRole("slider", { name: "Recording frame" });
  await expect(scrub).toHaveValue("1");
  await expect.poll(() => h!.hook.calls.some(c => c.path.includes("recordings/frame?") && c.path.includes("n=1"))).toBe(true);
  await page.locator('.section-pill[data-section="home"]').click();
});
