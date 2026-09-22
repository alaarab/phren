// Run after bundle-graph.mjs. Exercises the actual iPhone page at phone dimensions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";

let server;
let browser;
let baseURL;
const assets = new Map();
const root = new URL("../Phren/Resources/graph/", import.meta.url);

before(async () => {
  assets.set("/", [await readFile(new URL("index.html", root)), "text/html"]);
  assets.set("/phren-graph.js", [await readFile(new URL("phren-graph.js", root)), "application/javascript"]);
  server = http.createServer((request, response) => {
    const asset = assets.get(request.url);
    response.writeHead(asset ? 200 : 404, { "Content-Type": asset?.[1] ?? "text/plain" });
    response.end(asset?.[0] ?? "Not found");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

function payload() {
  const nodes = [];
  const links = [];
  for (const [index, project] of ["mobile", "api", "design"].entries()) {
    nodes.push({ id: project, label: project, fullLabel: project, group: "project", project,
                 store: "owner/brain", tagged: false, findingCount: 12, taskCount: 0 });
    for (let n = 0; n < 12; n++) {
      const id = `${project}:${n}`;
      nodes.push({ id, label: `Finding ${n + 1}`, fullLabel: `${project}: preserve the user's offline edits ${n + 1}`,
                   group: `topic:${["architecture", "testing", "frontend"][index]}`, project, store: "owner/brain",
                   tagged: true, scoreKey: `${project}/FINDINGS.md:${n}`, refCount: 1 });
      links.push({ source: project, target: id });
    }
  }
  links.push({ source: "mobile", target: "api" }, { source: "api", target: "design" });
  return { nodes, links, topics: [], total: nodes.length };
}

/** 40 projects x 8 findings: the survey's largest scale, for frame timing. */
function largePayload() {
  const nodes = [];
  const links = [];
  for (let p = 0; p < 40; p++) {
    const project = `proj-${String(p).padStart(2, "0")}`;
    nodes.push({ id: project, label: project, fullLabel: project, group: "project", project,
                 store: "owner/brain", tagged: false, findingCount: 8, taskCount: 0 });
    for (let n = 0; n < 8; n++) {
      const id = `${project}:${n}`;
      nodes.push({ id, label: `Finding ${n + 1}`, fullLabel: `${project}: finding ${n + 1} under load`,
                   group: "topic:architecture", project, store: "owner/brain",
                   tagged: true, scoreKey: `${project}/FINDINGS.md:${n}`, refCount: 1 });
      links.push({ source: project, target: id });
    }
  }
  return { nodes, links, topics: [], total: nodes.length };
}

test("bundle contains the shared collision resolver", async () => {
  const bundle = await readFile(new URL("phren-graph.js", root), "utf8");
  assert.ok(bundle.includes("hysteresisPx"), "phren-graph.js must ship resolveLabelOverlaps options");
  assert.ok(bundle.includes("previousVisible"), "phren-graph.js must ship hysteresis state");
});

test("phone graph renders, selects nodes, and accepts camera commands", { timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 620 }, isMobile: true, hasTouch: true });
  const errors = [];
  const requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(request.url()));
  await page.addInitScript(() => {
    window.messages = [];
    window.webkit = { messageHandlers: Object.fromEntries(["graphReady", "graphSelect", "graphError"].map(
      name => [name, { postMessage: body => window.messages.push({ name, body }) }]
    )) };
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => window.messages.some(message => message.name === "graphReady"));
  const graph = payload();
  await page.evaluate(graph => window.phrenHost.render(graph), graph);
  await page.waitForFunction(() => window.phrenGraph?.getData().nodes.length === 39);
  await page.waitForFunction(() => document.querySelector("#graph-canvas canvas")?.width > 0);
  assert.equal(await page.locator("#graph-canvas").evaluate(el => el.clientWidth), 393);
  assert.equal(await page.locator(".phren-project-nav").isVisible(), false);
  assert.equal(await page.locator(".phren-hud-legend").isVisible(), false);

  await page.evaluate(() => window.phrenHost.focusNode("mobile:0"));
  await page.waitForFunction(() => window.messages.some(message =>
    message.name === "graphSelect" && message.body?.id === "mobile:0"));
  const selected = await page.evaluate(() => window.messages.find(message =>
    message.name === "graphSelect" && message.body?.id === "mobile:0").body);
  assert.equal(selected.store, "owner/brain");
  assert.equal(selected.project, "mobile");
  assert.equal(selected.scoreKey, "mobile/FINDINGS.md:0");
  assert.equal(await page.locator(".phren-project-panel").isVisible(), false);
  await page.evaluate(() => {
    window.phrenHost.zoom(1.4);
    window.phrenHost.zoom(1 / 1.4);
    window.phrenHost.reset();
    window.phrenHost.clear();
  });
  await page.waitForFunction(() => window.messages.some(message => message.name === "graphSelect" && message.body === null));
  await page.evaluate(() => { window.messages = []; window.phrenHost.focusNode("mobile"); });
  await page.waitForFunction(() => window.messages.some(message =>
    message.name === "graphSelect" && message.body?.id === "mobile"));
  assert.equal(await page.locator("#graph-dossier").isVisible(), true, "project selection opens the dossier");
  assert.equal(await page.locator('[data-action="edit"]').isVisible(), false, "project omits Edit");
  assert.equal(await page.locator('[data-action="delete"]').isVisible(), false, "project omits Delete");
  assert.equal(await page.locator(".dossier-step").isVisible(), false, "project omits stepping");
  await page.evaluate(() => window.phrenHost.clear());
  await page.waitForFunction(() => window.messages.some(message => message.name === "graphSelect" && message.body === null));
  await page.evaluate(graph => window.phrenHost.render(graph), graph);
  assert.equal(await page.locator("#graph-canvas canvas").count(), 1, "refresh reuses the canvas");
  // Connection focus moves the camera without reopening the native details sheet.
  await page.evaluate(() => { window.messages = []; window.phrenHost.revealNode("mobile:0"); });
  await page.waitForTimeout(3000);
  assert.equal(await page.evaluate(() => window.messages.filter(message => message.name === "graphSelect" && message.body !== null).length), 0);
  if (process.env.PHREN_GRAPH_SCREENSHOT) await page.screenshot({ path: process.env.PHREN_GRAPH_SCREENSHOT });
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.messages.filter(message => message.name === "graphError")), []);
  assert.ok(requests.every(url => url.startsWith(baseURL)), "graph must not depend on remote assets");
  await page.close();
});

test("no visible finding label overlaps a project label at default zoom", { timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 620 }, isMobile: true, hasTouch: true });
  page.on("pageerror", error => assert.fail(`page error: ${error.message}`));
  await page.addInitScript(() => {
    window.messages = [];
    window.webkit = { messageHandlers: Object.fromEntries(["graphReady", "graphSelect", "graphError"].map(
      name => [name, { postMessage: body => window.messages.push({ name, body }) }]
    )) };
  });
  await page.goto(baseURL);
  await page.waitForFunction(() => window.messages.some(message => message.name === "graphReady"));
  await page.evaluate(graph => window.phrenHost.render(graph), payload());
  await page.waitForFunction(() => window.phrenGraph?.getData().nodes.length === 39);
  // Default zoom: intro/fit must have settled before reading label rects.
  await page.waitForTimeout(3500);
  const overlaps = await page.evaluate(() => {
    const visible = el => {
      if (!el || el.classList.contains("occluded")) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return parseFloat(style.opacity || "0") > 0.01;
    };
    const boxes = el => {
      const r = el.getBoundingClientRect();
      return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    };
    const hit = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    const projects = [...document.querySelectorAll(".phren-label--project")].filter(visible).map(boxes);
    const leaves = [...document.querySelectorAll(".phren-label:not(.phren-label--project)")].filter(visible);
    const bad = [];
    for (const leaf of leaves) {
      const lb = boxes(leaf);
      if (projects.some(pb => hit(lb, pb))) bad.push(leaf.textContent.slice(0, 60));
    }
    return { projectCount: projects.length, leafCount: leaves.length, bad };
  });
  // The resolver may hide every leaf at default zoom; when any draw, none
  // may sit on top of PHREN/LEDGER-style group labels (the reported bug).
  assert.deepEqual(overlaps.bad, [], `finding labels over project labels: ${overlaps.bad.join(" | ")}`);
  assert.ok(overlaps.projectCount > 0, "expected at least one visible project label");

  // Frame budget on the same page: swap in the 40-project store and time
  // 60 labelTicks (declutter every frame, pool reassign on the 0.15s LOD).
  // typeof must be evaluated in-page: Playwright cannot serialize a function
  // result across the bridge, so returning `phrenGraph.benchLabels` would be
  // undefined even when the method exists.
  const hasBench = await page.evaluate(() => typeof window.phrenGraph?.benchLabels === "function");
  assert.equal(hasBench, true, "bundle must expose benchLabels for the frame-budget probe");
  await page.evaluate(graph => window.phrenHost.render(graph), largePayload());
  await page.waitForFunction(() => window.phrenGraph?.getData().nodes.length === 360);
  const ms = await page.evaluate(() => window.phrenGraph.benchLabels(60));
  assert.ok(Number.isFinite(ms) && ms >= 0, `benchLabels returned ${ms}`);
  console.log(`# browser labelTick 60 frames on 40-project store: ${ms.toFixed(1)} ms (${(ms / 60).toFixed(2)} ms/frame)`);
  await page.close();
});

test("missing renderer reports a recoverable failure", { timeout: 20000 }, async () => {
  const page = await browser.newPage();
  await page.route("**/phren-graph.js", route => route.fulfill({ status: 200, body: "" }));
  await page.addInitScript(() => {
    window.messages = [];
    window.webkit = { messageHandlers: { graphReady: { postMessage() {} },
      graphError: { postMessage: body => window.messages.push(body) } } };
  });
  await page.goto(baseURL);
  await page.evaluate(() => window.phrenHost.render({ nodes: [], links: [] }));
  assert.equal(await page.locator("#graph-status").textContent(), "Renderer failed to load");
  assert.equal(await page.evaluate(() => window.messages.length), 1);
  await page.close();
});
