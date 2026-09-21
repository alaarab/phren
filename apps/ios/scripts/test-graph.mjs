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
