// Captures the screenshots and GIFs on the public docs' desktop page (docs/desktop.html).
// Not part of the normal e2e run (the main config ignores it): `pnpm --filter @phren/desktop docs:capture`.
// Everything on screen is sample data from the fake Hook; /api/memory/** is mocked so no real store appears.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { chatRow, linkUi, overviewFrame, startHarness, type Harness } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../../docs/apps/desktop");
// The shared fixture without its screenshot message (a placeholder box in a capture).
const transcript = (JSON.parse(readFileSync(path.join(HERE, "fixtures/transcript.json"), "utf8")) as unknown[])
  .filter((entry) => !JSON.stringify(entry).includes('"type":"image"'));
const VIEWPORT = { width: 1440, height: 900 };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const row = (id: string, title: string, status: string, label: string, reply: string, fields: object = {}) =>
  chatRow(id, title, status, { label, lastReply: reply, project: label, lastChangedAt: ago(5), cwd: `/Users/you/${label}`, ...fields });

const localRows = [
  row("fix", "Fix login", "working", "phren", "Running the auth tests now.", { currentStep: "Running pnpm test -- auth" }),
  row("release", "Ship release 0.3.34", "blocked", "phren", "May I push the release branch?", { agent: "codex", approvalPending: true, branch: "release/0.3.34" }),
  row("hero", "Compress the hero image", "idle", "website", "Done. The hero is 120 KB now.", { branch: "feat/hero" }),
  row("nav", "Improve mobile navigation", "working", "website", "Reworking the menu for small screens.", { agent: "opencode" }),
  row("cond", "Conductor", "idle", "phren", "Two workers finished.", { role: "conductor", agent: "codex" }),
];
const peerRows = [
  row("sync", "Faster store sync", "working", "api-gateway", "Profiling the pull path.", { branch: "perf/sync" }),
  row("a11y", "Review accessibility", "idle", "mobile-app", "Found three contrast issues."),
];

const PROJECTS = [
  { name: "phren", findings: 24 }, { name: "website", findings: 11 }, { name: "api-gateway", findings: 7 }, { name: "mobile-app", findings: 15 },
];
const FINDINGS = [
  { id: "fid:1", text: "[pattern] Route requests by host before choosing a handler.", date: "2026-10-14" },
  { id: "fid:2", text: "[decision] Cache the host lookup for one minute.", date: "2026-10-12" },
  { id: "fid:3", text: "[pitfall] Drain the queue before closing the socket.", date: "2026-10-10" },
  { id: "fid:4", text: "[pattern] Read the config once at startup.", date: "2026-10-09" },
];

// A sample memory store per computer, so Projects shows summaries and counts (the UI reads them from the store routes).
const CAPABILITIES = { memoryStore: true, fileWrite: true, fileSearch: true, gitReview: true, files: true, fileResolution: true, repositoryFiles: true, schedules: true, transcript: true, prompt: true, diff: true, overviewStream: true, resources: true };
const SAMPLE_PROJECTS: Record<string, { summary: string; tasks: string[]; findings: number }> = {
  phren: { summary: "Memory for coding agents: findings, tasks and a hook that recalls them.", tasks: ["Polish the Home dashboard", "Review the launch flow", "Check the release notes"], findings: 24 },
  website: { summary: "The marketing site: landing page, docs and the getting started guide.", tasks: ["Refresh the landing page", "Review accessibility"], findings: 11 },
  "api-gateway": { summary: "Routes requests by host and enforces per-tenant rate limits.", tasks: ["Drain the queue before closing the socket"], findings: 7 },
  "mobile-app": { summary: "The phone client: sessions, approvals and talk mode.", tasks: ["Improve mobile navigation", "Cache the host lookup", "Ship the onboarding flow", "Fix the login redirect"], findings: 15 },
};
const b64 = (text: string) => Buffer.from(text).toString("base64");
function storeRoutes(names: string[]) {
  const blobs = new Map<string, string>();
  const tree: Array<{ path: string; type: string; sha: string }> = [];
  for (const name of names) {
    const p = SAMPLE_PROJECTS[name];
    const files: Record<string, string> = {
      "summary.md": `${p.summary}\n`,
      "tasks.md": `## Active\n${p.tasks.map((t) => `- ${t}`).join("\n")}\n\n## Done\n`,
      "FINDINGS.md": `${Array.from({ length: p.findings }, (_, i) => `- [pattern] Sample finding ${i + 1}`).join("\n")}\n`,
    };
    for (const [file, text] of Object.entries(files)) {
      const sha = `${name}-${file}`.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(40, "0").slice(0, 40);
      blobs.set(sha, text);
      tree.push({ path: `${name}/${file}`, type: "blob", sha });
    }
  }
  return {
    "GET /v1/health": () => ({ json: { ok: true, product: "phren-hook", protocol: 1, version: "0.3.55", computer: { id: "docs", name: "docs" }, capabilities: CAPABILITIES } }),
    "GET /v1/projects/repos": () => ({ json: { repos: names.map((name) => ({ name, project: name, directory: `/Users/you/${name}`, registered: true, lastSeen: ago(30) })) } }),
    "GET /v1/store/head": () => ({ json: { sha: `head-${names.join("-")}` } }),
    "GET /v1/store/tree": () => ({ json: { tree } }),
    "GET /v1/store/blob": (_req: unknown, _body: unknown, url: URL) => ({ json: { content: b64(blobs.get(url.searchParams.get("sha") ?? "") ?? "") } }),
  };
}

/** The overview frame the Hooks push, declaring the store routes the Projects section reads. */
const frame = (rows: object[]) => {
  const f = overviewFrame(rows);
  f.phren.capabilities = { ...f.phren.capabilities, ...CAPABILITIES } as typeof f.phren.capabilities;
  return f;
};

let h: Harness;
let unlinkUi: () => void;
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  unlinkUi = linkUi();
  h = await startHarness("docs", {
    overviewFrames: [frame(localRows)],
    transcriptFrames: transcript,
    routes: storeRoutes(["phren", "website"]),
    peer: { name: "Studio", options: { overviewFrames: [frame(peerRows)], routes: storeRoutes(["api-gateway", "mobile-app"]) } },
  });
});
test.afterAll(async () => { await h?.close(); unlinkUi(); });

async function prepare(page: Page) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/api/memory/**", (route) => {
    const url = route.request().url();
    if (/\/projects(\?|$)/.test(url)) return route.fulfill({ json: { projects: PROJECTS } });
    if (/\/findings/.test(url)) return route.fulfill({ json: { items: FINDINGS } });
    return route.fulfill({ json: { items: [], projects: [] } });
  });
  await page.goto(h.url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const section = (page: Page, name: string) => name === "projects"
  ? page.locator(".section-pill", { hasText: "Projects" }).click()
  : page.locator(`.section-pill[data-section="${name}"]`).click();
const openRow = (page: Page, title: string) => page.locator(".sb-row", { hasText: title }).first().click();

test.use({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "dark" });

test("screenshots", async ({ page }) => {
  await prepare(page);
  await expect(page.locator(".section-pill.selected")).toHaveText(/Home/);
  await page.waitForTimeout(1500);
  await shot(page, "home");

  await section(page, "agents");
  await openRow(page, "Fix login");
  await expect(page.locator(".ct-column")).toContainText("Fixed. The guard now runs");
  await page.waitForTimeout(600);
  await shot(page, "chat");

  await page.locator("#side .segments .segment", { hasText: "Changes" }).click();
  await expect(page.locator(".chg-name", { hasText: "app.ts" })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "changes");

  // Tiles: two chats side by side.
  await openRow(page, "Ship release");
  await page.locator(".layout-btn", { hasText: "Split →" }).click();
  await expect(page.locator(".tile")).toHaveCount(2);
  await openRow(page, "Compress the hero image");
  await page.waitForTimeout(800);
  await shot(page, "tiles");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.keyboard.type("login");
  await page.waitForTimeout(500);
  await shot(page, "palette");
  await page.keyboard.press("Escape");

  await section(page, "projects");
  await expect(page.locator(".pj-card").first()).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, "projects");

  await section(page, "settings");
  await page.locator(".settings-tab", { hasText: "Appearance" }).click();
  await expect(page.locator(".settings-theme").first()).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "settings");
});

/** Record one flow in its own context, then convert the video to a small GIF (12 fps, 900 px, palette). */
async function record(browser: Browser, name: string, flow: (page: Page) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "docs-video-"));
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir, size: VIEWPORT } });
  const page = await context.newPage();
  await prepare(page);
  await flow(page);
  await context.close();
  const video = readdirSync(dir).find((f) => f.endsWith(".webm"))!;
  const gif = path.join(OUT, `${name}.gif`);
  const palette = path.join(dir, "palette.png");
  const scale = "fps=12,scale=900:-1:flags=lanczos";
  // Fewer palette colours until the GIF fits the page's budget.
  for (const colors of [96, 64, 40, 24]) {
    execFileSync("ffmpeg", ["-y", "-i", path.join(dir, video), "-vf", `${scale},palettegen=max_colors=${colors}:stats_mode=diff`, palette], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-y", "-i", path.join(dir, video), "-i", palette, "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, gif], { stdio: "ignore" });
    if (statSync(gif).size <= 1.5 * 1024 * 1024) break;
  }
  rmSync(dir, { recursive: true, force: true });
  expect(statSync(gif).size).toBeLessThanOrEqual(1.5 * 1024 * 1024);
}

test("switcher.gif", async ({ browser }) => {
  await record(browser, "switcher", async (page) => {
    await section(page, "agents");
    for (const title of ["Fix login", "Ship release 0.3.34", "Compress the hero image"]) {
      await openRow(page, title);
      await expect(page.locator(".doc-tab.selected .doc-tab-title")).toHaveText(title);
      await page.waitForTimeout(500);
    }
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(900);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(900);
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(700);
    await page.keyboard.up("Control");
    await page.waitForTimeout(1200);
  });
});

test("find.gif", async ({ browser }) => {
  await record(browser, "find", async (page) => {
    await section(page, "agents");
    await openRow(page, "Fix login");
    await expect(page.locator(".ct-column")).toContainText("Fixed. The guard now runs");
    await page.waitForTimeout(800);
    await page.locator(".chat-pane .chat-composer textarea, .chat-pane .chat-composer [contenteditable]").first().focus();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(400);
    await page.keyboard.type("guard", { delay: 140 });
    await page.waitForTimeout(900);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    await page.keyboard.press("Shift+Enter");
    await page.waitForTimeout(1200);
  });
});
