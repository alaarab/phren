import { expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

let h: Harness | undefined;
let unlinkUi: () => void;
test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async () => { await h?.close(); h = undefined; });

const fix = chatRow("fix", "Fix login", "idle", { account: { id: "default", label: "Team" } });
const codex = chatRow("cdx", "Codex chat", "idle", { agent: "codex", target: { server: "default", workspace: "1", tab: "cdx", pane: "cdx", source: "codex", session: "cdx" } });
const accounts = [
  { id: "default", label: "Team", signedIn: true, usable: true },
  { id: "gmail", label: "Personal Max", signedIn: true, usable: true },
  { id: "max", label: "Second Max", signedIn: true, usable: true },
  { id: "spare", label: "Spare", signedIn: false, usable: false, reason: "Not signed in" },
];

async function start(page: Page, capabilities: Record<string, unknown>) {
  const frame = overviewFrame([fix, codex]);
  frame.phren.capabilities = { ...frame.phren.capabilities, moveNewChat: true, ...capabilities };
  let polls = 0;
  h = await startHarness("switch-account", {
    overviewFrames: [frame],
    routes: {
      "GET /v1/health": () => ({ json: { ok: true, capabilities: frame.phren.capabilities } }),
      "GET /v1/harnesses": () => ({ json: { harnesses: [{ source: "claude", installed: true, usable: true, accounts }, { source: "codex", installed: true, usable: true }] } }),
      "POST /v1/sessions/move": (_req: unknown, body: unknown) => ({ json: { ok: true, move: { id: (body as { id: string }).id, state: "exiting", continuation: "resume" } } }),
      "GET /v1/sessions/move": () => ({ json: { move: { state: (polls += 1) < 2 ? "launching" : "moved", continuation: "resume" } } }),
    },
  });
  const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const row = (account: string, used: number) => ({ id: `claude-${account}`, harness: "claude", name: "Claude", account,
    computers: [{ name: "This computer", account }], windows: [{ id: "five_hour", name: "5-hour", usedPercent: used, resetsAt: reset, exhausted: used >= 100 }] });
  await page.route("**/api/usage", (route) => route.fulfill({ json: { accounts: [row("default", 100), row("gmail", 30), row("max", 100)],
    computers: ["This computer"], noData: [], unreachable: [], at: new Date().toISOString() } }));
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
}

test("Switch account is the Claude chat's first menu item and resumes the same conversation on the picked account", async ({ page }) => {
  await start(page, { moveResume: true });
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.locator(".chat-more").click();
  await expect(page.locator(".chat-menu button").first()).toHaveText("Switch account…");
  await page.locator(".chat-menu button").first().click();
  const sheet = page.getByRole("dialog", { name: "Switch account" });
  const rows = sheet.locator(".switch-account-row");
  await expect(rows).toHaveCount(4);
  // The chat's own account first, then room, then the ones that can't take it.
  await expect(rows.nth(0)).toContainText("Team · current");
  await expect(rows.nth(0)).toBeDisabled();
  await expect(rows.nth(1)).toContainText("Personal Max");
  await expect(rows.nth(1)).toContainText("70% left of 5-hour");
  await expect(rows.nth(1)).toBeEnabled();
  await expect(sheet.locator('.switch-account-row[data-account="max"]')).toContainText(/Out of usage · resets/);
  await expect(sheet.locator('.switch-account-row[data-account="max"]')).toBeDisabled();
  await expect(sheet.locator('.switch-account-row[data-account="spare"]')).toBeDisabled();
  await expect(sheet.locator(".move-copy-command")).toHaveText("CLAUDE_CONFIG_DIR=~/.claude-spare claude /login");
  await page.waitForTimeout(200);
  await sheet.screenshot({ path: test.info().outputPath("switch-account.png") });
  await rows.nth(1).click();
  await expect.poll(() => h!.hook.calls.filter((c) => c.method === "POST" && c.path === "/v1/sessions/move").length).toBe(1);
  expect(h!.hook.calls.find((c) => c.method === "POST" && c.path === "/v1/sessions/move")!.body)
    .toEqual({ target: fix.target, to: { harness: "claude", account: "gmail" }, continuation: "resume", id: expect.any(String) });
  await expect(sheet.locator(".launch-status")).toHaveText("Switched", { timeout: 10_000 });
});

test("an older Hook says so, and other agents stay one click away", async ({ page }) => {
  await start(page, {});
  const row = page.locator(".sb-row", { hasText: "Fix login" });
  await row.hover();
  await row.locator(".sb-more").click();
  await row.locator(".sb-menu button", { hasText: "Switch account…" }).click();
  const sheet = page.getByRole("dialog", { name: "Switch account" });
  await expect(sheet).toContainText("can't switch accounts without a hand-off yet");
  await expect(sheet.locator(".switch-account-row")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Other agents and computers…" }).click();
  await expect(page.getByRole("dialog", { name: "Continue in another agent" })).toBeVisible();
});

test("a chat in another harness keeps Continue in…", async ({ page }) => {
  await start(page, { moveResume: true });
  const row = page.locator(".sb-row", { hasText: "Codex chat" });
  await row.hover();
  await row.locator(".sb-more").click();
  await expect(row.locator(".sb-menu button", { hasText: "Continue in…" })).toBeVisible();
  await expect(row.locator(".sb-menu button", { hasText: "Switch account…" })).toHaveCount(0);
  await page.locator(".sb-row", { hasText: "Codex chat" }).click();
  await page.locator(".chat-more").click();
  await expect(page.locator(".chat-menu button", { hasText: "Switch account…" })).toHaveCount(0);
});
