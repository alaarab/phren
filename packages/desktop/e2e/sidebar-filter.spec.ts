import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;

const chat = (id: string, title: string, agentStatus: string, fields: object = {}) =>
  chatRow(id, title, agentStatus, { lastChangedAt: "2026-10-16T09:00:00.000Z", ...fields });
const children = [
  chat("fix", "Fix login redirect", "waiting", { branch: "fix/login", lastReply: "Want me to open a PR?" }),
  chat("docs", "Review the docs", "working", { label: "website", cwd: "/Users/you/website", agent: "codex", target: { server: "default", workspace: "1", tab: "docs", pane: "docs", source: "codex", session: "docs" } }),
  chat("index", "Migrate the index", "idle", { branch: "feat/index-migrate" }),
  chat("ship", "Ship release", "done"),
];

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.beforeEach(async () => { h = await startHarness("sidebar-filter", { overviewFrames: [overviewFrame(children)] }); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

async function openAgents(page: Page) {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row")).toHaveCount(4);
}

const filter = (page: Page) => page.locator(".sb-filter-input");
const titles = (page: Page) => page.locator(".sb-row .sb-title");

test("typing narrows the rows, keeps the grouping, and Escape clears the field", async ({ page }) => {
  await openAgents(page);
  await filter(page).fill("LOGIN");
  await expect(titles(page)).toHaveText(["Fix login redirect"]);
  await expect(page.locator(".sb-header-text")).toHaveText(["Needs you", "Computers"]);

  await filter(page).fill("this codex"); // computer name and harness, every word required
  await expect(titles(page)).toHaveText(["Review the docs"]);
  await expect(page.locator(".sb-header-text").first()).toHaveText("Working");

  await filter(page).fill("migrate");
  await expect(titles(page)).toHaveText(["Migrate the index"]);
  await filter(page).fill("feat/index");
  await expect(titles(page)).toHaveText(["Migrate the index"]);

  await filter(page).press("Escape");
  await expect(filter(page)).toHaveValue("");
  await expect(page.locator(".sb-row")).toHaveCount(4);
});

test("no match says so and Clear brings every row back", async ({ page }) => {
  await openAgents(page);
  await filter(page).fill("zzz nothing");
  await expect(page.locator(".sb-nomatch")).toContainText("No sessions match");
  await expect(page.locator(".sb-row")).toHaveCount(0);
  await page.locator(".sb-nomatch-clear").click();
  await expect(filter(page)).toHaveValue("");
  await expect(page.locator(".sb-row")).toHaveCount(4);
});

test("pinned rows obey the filter, and the filter is not remembered across a reload", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.setItem("phren.desktop.sidebar.pinned", JSON.stringify(["This computer/docs"])));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-header-text").first()).toHaveText("Pinned");
  await filter(page).fill("login");
  await expect(page.locator(".sb-header-text")).not.toContainText(["Pinned"]);
  await expect(titles(page)).toHaveText(["Fix login redirect"]);
  await filter(page).fill("docs");
  await expect(page.locator(".sb-header-text").first()).toHaveText("Pinned");
  await expect(titles(page)).toHaveText(["Review the docs"]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(filter(page)).toHaveValue("");
  await expect(page.locator(".sb-row")).toHaveCount(4);
});

test("the shortcut focuses the filter from anywhere and is listed in Settings › Keys", async ({ page }) => {
  await page.goto(h!.url, { waitUntil: "domcontentloaded" });
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(filter(page)).toBeFocused();
  await page.keyboard.type("docs");
  await expect(titles(page)).toHaveText(["Review the docs"]);

  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Keys" }).click();
  await expect(page.getByText("Filter the sessions sidebar")).toBeVisible();
});

test("in a window under 1440 px the shortcut expands the icon strip to reach the filter", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAgents(page);
  await expect(page.locator("#sidebar")).toHaveClass(/compact/);
  await expect(filter(page)).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(page.locator("#sidebar")).not.toHaveClass(/compact/);
  await expect(filter(page)).toBeFocused();
});
