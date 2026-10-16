import { expect, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";
import { API_PULLS, localRoutes, PEER, peerRoutes } from "./pulls-fixtures.js";

let h: Harness | undefined;
let unlinkUi: () => void;

test.beforeAll(() => { unlinkUi = linkUi(); });
test.afterAll(() => { unlinkUi(); });
test.afterEach(async ({ page }) => { await page.close(); await h?.close(); h = undefined; });

const overview = () => overviewFrame([chatRow("login", "Fix login", "idle", { label: "phren" })]);
type Calls = { calls: Array<{ path: string }> };
const projectReads = (hook: Calls) => hook.calls.filter((c) => /^\/v1\/projects\/[^/]+\/git(\?|$)/.test(c.path));
const listReads = (hook: Calls) => hook.calls.filter((c) => c.path.startsWith("/v1/projects/repos"));
const twoComputers = (name: string) => startHarness(name, { overviewFrames: [overview()], routes: localRoutes(), peer: { name: PEER, options: { overviewFrames: [overviewFrame([])], routes: peerRoutes() } } });

test("Home lists every open pull request once across projects and computers, the ones that need you first", async ({ page }) => {
  h = await twoComputers("pulls");
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  const card = page.locator('[data-block="pulls"]');
  const titles = card.locator(".home-pull .home-row-title");
  await expect(titles).toHaveCount(8);
  await expect(titles).toHaveText([
    "#12 Split the router", "#7 Optimise the hero image", "#9 Add search to the shell", "!3 Rate limit sign-ins",
    "#15 Document the Hook routes", "#8 New footer", "#20 Bump dependencies", "!5 Paginate the list endpoint",
  ]);
  // The repository both computers have is listed once, with the fuller read's flags.
  const hero = card.locator(".home-pull", { hasText: "Optimise the hero image" });
  await expect(hero).toHaveCount(1);
  await expect(hero).toContainText("Changes requested");
  await expect(card.locator(".home-pull", { hasText: "Split the router" })).toContainText("Conflicts");
  await expect(card.locator(".home-pull", { hasText: "New footer" })).toContainText("Draft");
  await expect(card.locator(".home-pull", { hasText: "Rate limit sign-ins" })).toContainText("Pipeline failing");
  await expect(card.locator(".home-pull", { hasText: "Document the Hook routes" })).toContainText("Approved");
  await expect(card.locator(".home-pull", { hasText: "Add search" })).toContainText("Checks failing");
  await expect(card.locator(".count")).toHaveText("9");
  await card.locator(".home-more").click();
  await expect(titles).toHaveCount(9);
  await expect(titles.last()).toHaveText("#2 Tidy the old scripts");
  // One project list per computer, and one read per project per computer: 2 + 4.
  expect(listReads(h.hook).length + listReads(h.peerHook!).length).toBe(2);
  expect(projectReads(h.hook).length + projectReads(h.peerHook!).length).toBe(4);
});

test("GitLab merge requests are named merge requests", async ({ page }) => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ...API_PULLS[0], number: 100 + i, title: `Merge request ${i}`, updated: new Date(Date.now() - i * 60_000).toISOString() }));
  const gitlab = { kind: "gitlab", name: "GitLab", domain: "gitlab.com", webUrl: "https://gitlab.com/you/api", terms: { short: "MR", long: "merge request", ref: "!" } };
  h = await startHarness("pulls-gitlab", {
    overviewFrames: [overview()], routes: { "GET /v1/projects/repos": () => ({ status: 200, json: { repos: [] } }) },
    peer: { name: PEER, options: { overviewFrames: [overviewFrame([])], routes: {
      "GET /v1/projects/repos": () => ({ status: 200, json: { repos: [{ name: "api", directory: "/Users/you/api", registered: true }] } }),
      "GET /v1/projects/api/git": () => ({ status: 200, json: { project: "api", directory: "/Users/you/api", available: true, host: gitlab, pulls: many } }),
    } } },
  });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  const card = page.locator('[data-block="pulls"]');
  await expect(card.locator(".section-label")).toContainText("Merge requests");
  await expect(card.locator(".home-pull .home-row-title").first()).toHaveText("!100 Merge request 0");
  await expect(card.locator(".home-more")).toHaveText("Show all 9 MRs");
});

test("clicking a request opens its project's session on Changes, PRs; a project with no session opens its page", async ({ page }) => {
  h = await twoComputers("pulls-open");
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  const card = page.locator('[data-block="pulls"]');
  await card.locator(".home-pull", { hasText: "Split the router" }).click();
  await expect(page.locator(".section-pill.selected")).toHaveText("Agents");
  await expect(page.locator('.chg-seg.sel[data-view="pulls"]')).toBeVisible();
  await page.locator('.section-pill[data-section="home"]').click();
  await card.locator(".home-pull", { hasText: "Rate limit sign-ins" }).click();
  await expect(page.locator(".section-pill.selected")).toHaveText("Projects");
  await expect(page.locator(".pj-forge")).toContainText("!3");
});

test("no requests while Home is hidden, none sooner than five minutes apart while it is shown and focused", async ({ page }) => {
  await page.addInitScript(() => { document.hasFocus = () => true; });
  await page.clock.install();
  h = await twoComputers("pulls-budget");
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-block="pulls"] .home-pull').first()).toBeVisible();
  const reads = () => projectReads(h!.hook).length + projectReads(h!.peerHook!).length;
  const lists = () => listReads(h!.hook).length + listReads(h!.peerHook!).length;
  expect(reads()).toBe(4);
  // Four minutes later nothing new; past five, one read of each project.
  await page.clock.fastForward(240_000);
  await page.waitForTimeout(300);
  expect(reads()).toBe(4);
  await page.clock.fastForward(65_000);
  await expect.poll(reads).toBe(8);
  // Hidden: ten minutes pass and nothing is asked.
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.waitForTimeout(300);
  const before = { reads: reads(), lists: lists() };
  await page.clock.fastForward(600_000);
  await page.waitForTimeout(300);
  expect({ reads: reads(), lists: lists() }).toEqual(before);
  // Back on Home it reads again.
  await page.locator('.section-pill[data-section="home"]').click();
  await expect.poll(reads).toBe(12);
});

test("the card is hidden when there are no open requests", async ({ page }) => {
  h = await startHarness("pulls-empty", { overviewFrames: [overview()], routes: {
    "GET /v1/projects/repos": () => ({ status: 200, json: { repos: [{ name: "phren", directory: "/Users/you/phren", registered: true }] } }),
    "GET /v1/projects/phren/git": () => ({ status: 200, json: { project: "phren", available: true, host: { kind: "github", name: "GitHub", terms: { short: "PR", long: "pull request", ref: "#" } }, pulls: [] } }),
  } });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await expect.poll(() => projectReads(h!.hook).length).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.locator('[data-block="pulls"]')).toBeHidden();
});

test("an error line shows when every read failed", async ({ page }) => {
  h = await startHarness("pulls-failed", { overviewFrames: [overview()], routes: {
    "GET /v1/projects/repos": () => ({ status: 200, json: { repos: [{ name: "phren", directory: "/Users/you/phren", registered: true }] } }),
    "GET /v1/projects/phren/git": () => ({ status: 500, json: { error: "The Hook could not read the checkout." } }),
  } });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-block="pulls"] .home-empty')).toContainText("Could not read pull requests");
});

test("Refresh forces a round; a project that fails keeps its rows, marked stale, with a note under them", async ({ page }) => {
  const routes = localRoutes();
  const good = routes["GET /v1/projects/phren/git"];
  let down = false;
  routes["GET /v1/projects/phren/git"] = (req, body, url) => down
    ? { status: 200, json: { project: "phren", available: false, reason: "failed", message: "gh timed out", host: { kind: "github", name: "GitHub" }, pulls: [] } }
    : good(req, body, url);
  h = await startHarness("pulls-stale", { overviewFrames: [overview()], routes, peer: { name: PEER, options: { overviewFrames: [overviewFrame([])], routes: peerRoutes() } } });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  const card = page.locator('[data-block="pulls"]');
  await expect(card.locator(".home-pull", { hasText: "Split the router" })).toBeVisible();
  await expect(card.locator(".home-pulls-note")).toHaveText("");
  const before = projectReads(h.hook).length;
  down = true;
  await card.locator(".home-pulls-refresh").click();
  await expect(card.locator(".home-pulls-note")).toHaveText("Couldn’t read 1 project");
  expect(projectReads(h.hook).length).toBe(before + 2);
  const stale = card.locator(".home-pull.stale", { hasText: "Split the router" });
  await expect(stale).toBeVisible();
  // A stale read is never listed above a current one.
  await expect(card.locator(".home-pull .home-row-title").first()).toHaveText("#7 Optimise the hero image");
});
