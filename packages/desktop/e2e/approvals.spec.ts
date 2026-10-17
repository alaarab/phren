import { expect, test, type Page } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const rule = (fields: object) => ({
  id: "11111111-1111-4111-8111-111111111111", tool: "Bash", command: "pnpm test", match: "exact", effect: "always-ask",
  scope: { project: "/Users/me/Projects/phren", harness: "claude" }, projectName: "phren",
  createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), owner: "ab", enabled: true,
  signerFingerprint: "SHA256:x", matchesPairedKey: false, ...fields,
});
const RULES = [
  rule({}),
  rule({ id: "22222222-2222-4222-8222-222222222222", match: "prefix", command: "git push", effect: "deny", scope: { project: "/Users/me/Projects/phren" }, until: new Date(Date.now() + 9 * 86400_000).toISOString() }),
];

async function start(peerRoute: { status?: number; json: unknown }, local: { status?: number; json: unknown } = { json: { rules: RULES } }) {
  h = await startHarness("approvals", {
    overviewFrames: [overviewFrame([chatRow("fix", "Fix login", "idle")])],
    routes: { "GET /v1/approval-rules": () => local },
    peer: { name: "build-box", options: { overviewFrames: [overviewFrame([])], routes: { "GET /v1/approval-rules": () => peerRoute } } },
  });
}
const open = async (page: Page) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Approvals" }).click();
};
const reads = () => [...h!.hook.calls, ...h!.peerHook!.calls].filter((c) => c.path === "/v1/approval-rules").length;

test("lists each computer's rules in words, with its own empty state, and has no edit controls", async ({ page }) => {
  await start({ json: { rules: [] } });
  await open(page);
  const mine = page.locator('.approval-computer[data-computer="This computer"]');
  await expect(mine.locator(".approval-rule")).toHaveCount(2);
  await expect(mine.locator(".approval-sentence").first()).toHaveText("Claude must ask before running `pnpm test` in phren.");
  await expect(mine.locator(".approval-sentence").nth(1)).toHaveText("Any agent may not run commands starting with `git push` in phren.");
  await expect(mine.locator(".approval-dates").first()).toContainText("(3d ago) · No expiry");
  await expect(mine.locator(".approval-dates").nth(1)).toContainText("Expires");
  await expect(page.locator('.approval-computer[data-computer="build-box"] .approval-empty')).toHaveText("No standing approval rules on build-box.");
  await expect(page.locator(".settings-page:not([hidden])")).toContainText("from the phone");
  await expect(page.locator(".settings-page:not([hidden]) button")).toHaveText(["Refresh"]);
});

test("one computer's error does not hide the other's rules; Refresh reads again and nothing polls", async ({ page }) => {
  await start({ status: 500, json: { error: "Approval rules could not be loaded." } });
  await open(page);
  await expect(page.locator('.approval-computer[data-computer="build-box"] .approval-error')).toContainText("Approval rules could not be loaded.");
  await expect(page.locator('.approval-computer[data-computer="This computer"] .approval-rule')).toHaveCount(2);
  const before = reads();
  expect(before).toBe(2);
  await page.waitForTimeout(1500);
  expect(reads()).toBe(before);
  await page.locator(".settings-page:not([hidden]) button", { hasText: "Refresh" }).click();
  await expect.poll(reads).toBe(before + 2);
});

test("is not read until the page is shown", async ({ page }) => {
  await start({ json: { rules: [] } });
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Computers" }).waitFor();
  expect(reads()).toBe(0);
});

for (const width of [360, 420]) {
  test(`Approvals fits ${width}px wide`, async ({ page }) => {
    await start({ json: { rules: [rule({ command: "pnpm --filter @phren/desktop exec playwright test --reporter=line", match: "prefix" })] } });
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    await expect(page.locator(".approval-rule")).toHaveCount(3);
    const report = await page.evaluate(() => {
      const body = document.querySelector(".settings-body")!;
      const out: string[] = [];
      for (const e of [...document.querySelectorAll(".settings-page:not([hidden]) button, .approval-rule")]) {
        const r = (e as HTMLElement).getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < -0.5 || r.right > innerWidth + 0.5) out.push(`${e.tagName}.${(e as HTMLElement).className} ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
      if (body.scrollWidth > body.clientWidth) out.push(`.settings-body scrolls ${body.scrollWidth}/${body.clientWidth}`);
      return { scroll: document.scrollingElement!.scrollWidth, inner: innerWidth, out };
    });
    expect(report.scroll).toBeLessThanOrEqual(report.inner);
    expect(report.out).toEqual([]);
  });
}
