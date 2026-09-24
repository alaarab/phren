#!/usr/bin/env node
/**
 * Phren Hook load benchmark.
 *
 * Samples a running Hook's /v1/metrics counters and its CPU and RSS (ps) in
 * three scenarios, one after another:
 *
 *   idle      nothing but this script's metrics reads
 *   chat      one /v1/transcripts websocket open on a live session, read-only
 *   overview  GET /v1/workspaces?watchApprovals=1 every 3 s, as the phone polls
 *
 * and prints Herdr calls/min by method, identity probes/min, git spawns/min,
 * timer ticks/min, CPU% and RSS per scenario.
 *
 * Read-only: it never sends a prompt, key, model change or any POST. The
 * websocket is opened and listened to; nothing is written to it.
 *
 *   node scripts/bench-hook.mjs [--socket <hook.sock>] [--minutes 2]
 *     [--scenarios idle,chat,overview] [--sample 5] [--settle 15]
 *     [--server default] [--target server,workspace,tab,pane,source,session] [--json]
 *
 * --socket defaults to $PHREN_BRIDGE_HOME/hook.sock, else the installed Hook's.
 * Without --target the chat scenario picks the first pane whose conversation
 * the Hook has identified. CPU% is CPU time used over wall time in the
 * window (100 = one core), measured from ps's cumulative time, not ps's
 * decaying %cpu.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { request } from "node:http";
import { homedir, loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const WebSocket = createRequire(path.join(here, "../packages/cli/package.json"))("ws");

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}
const socket = option("socket", path.join(process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge"), "hook.sock"));
const minutes = Number(option("minutes", "2"));
const sampleSeconds = Number(option("sample", "5"));
const settleSeconds = Number(option("settle", "15"));
const scenarios = option("scenarios", "idle,chat,overview").split(",").filter(Boolean);
const server = option("server", "default");
const asJson = process.argv.includes("--json");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);

/** GET only: this script has no way to send anything else. */
function get(url) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: url, method: "GET", timeout: 30_000 }, res => {
      let data = ""; res.on("data", bytes => data += bytes);
      res.on("end", () => {
        try { const body = JSON.parse(data); res.statusCode === 200 ? resolve(body) : reject(new Error(`${url}: ${res.statusCode} ${body.error ?? ""}`)); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${url}: timed out`)));
    req.on("error", reject); req.end();
  });
}

/** Cumulative CPU seconds and RSS in KiB for one process. */
async function processSample(pid) {
  const { stdout } = await exec("ps", ["-o", "time=,rss=", "-p", String(pid)]);
  const [time, rss] = stdout.trim().split(/\s+/);
  // [[dd-]hh:]mm:ss.ss
  const [days, clock] = time.includes("-") ? [Number(time.split("-")[0]), time.split("-")[1]] : [0, time];
  const seconds = days * 86_400 + clock.split(":").map(Number).reduce((sum, value) => sum * 60 + value, 0);
  return { at: Date.now(), cpu: seconds, rss: Number(rss) };
}

async function chatTarget() {
  const given = option("target");
  if (given) {
    // Herdr tab and pane ids carry a colon ("w13:t2"), so commas separate them too.
    const parts = given.includes(",") ? given.split(",") : given.split(":");
    const [srv, workspace, tab, pane, source, session] = parts.length === 6 ? parts : [];
    if (!session) throw new Error("--target is server,workspace,tab,pane,source,session (or colons when no id has one)");
    return { server: srv, workspace, tab, pane, source, session };
  }
  const overview = await get(`/v1/workspaces?mux=herdr:${encodeURIComponent(server)}`);
  for (const group of overview.groups ?? []) for (const child of group.children ?? []) {
    if (!child.agent) continue;
    const panes = await get(`/v1/workspaces/panes?mux=herdr:${encodeURIComponent(server)}&groupId=${encodeURIComponent(group.id)}&childId=${encodeURIComponent(child.id)}`);
    const pane = (panes.panes ?? []).find(p => p.sessionId && p.agent);
    if (pane) return { server, workspace: group.id, tab: child.id, pane: pane.id, source: pane.agent, session: pane.sessionId };
  }
  throw new Error("No live session with an identified conversation; pass --target.");
}

/** Opens the transcript stream and only listens. */
function openChat(target) {
  const ws = new WebSocket(`ws+unix:${socket}:/v1/transcripts?${new URLSearchParams(target)}`);
  const state = { frames: 0, bytes: 0, closed: undefined, close: () => ws.terminate() };
  ws.on("message", data => { state.frames++; state.bytes += data.length; });
  ws.on("close", (code, reason) => { state.closed = `${code} ${reason}`.trim(); });
  ws.on("error", error => { state.closed = error.message; });
  return state;
}

function difference(before, after) {
  const result = {};
  for (const kind of ["herdr", "identity", "git", "timers"]) {
    result[kind] = {};
    for (const [name, value] of Object.entries(after[kind] ?? {})) {
      const delta = value.total - (before[kind]?.[name]?.total ?? 0);
      if (delta) result[kind][name] = delta;
    }
  }
  return result;
}

async function run(name, pid) {
  let chat, poller, polls = 0, pollErrors = 0, pollMs = 0;
  if (name === "chat") {
    const target = await chatTarget();
    log(`chat: streaming ${target.source} session ${target.session.slice(0, 8)} read-only`);
    chat = openChat(target);
    await sleep(3000);
  }
  if (name === "overview") {
    const poll = async () => {
      const started = Date.now();
      try { await get(`/v1/workspaces?watchApprovals=1&mux=herdr:${encodeURIComponent(server)}`); polls++; pollMs += Date.now() - started; }
      catch { pollErrors++; }
    };
    void poll(); poller = setInterval(poll, 3000);
  }
  const load = [loadavg()[0]];
  const before = await get("/v1/metrics");
  const samples = [await processSample(pid)];
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    await sleep(Math.min(sampleSeconds * 1000, Math.max(0, end - Date.now())));
    samples.push(await processSample(pid));
  }
  const after = await get("/v1/metrics");
  load.push(loadavg()[0]);
  clearInterval(poller); chat?.close();
  const first = samples[0], last = samples.at(-1), wallMinutes = (last.at - first.at) / 60_000;
  const perMinute = Object.fromEntries(Object.entries(difference(before, after)).map(([kind, values]) =>
    [kind, Object.fromEntries(Object.entries(values).map(([key, count]) => [key, Math.round(count / wallMinutes * 10) / 10]))]));
  return { scenario: name, minutes: Math.round(wallMinutes * 100) / 100, perMinute,
    cpuPercent: Math.round((last.cpu - first.cpu) / ((last.at - first.at) / 1000) * 1000) / 10,
    rssMiB: { mean: Math.round(samples.reduce((sum, s) => sum + s.rss, 0) / samples.length / 1024 * 10) / 10, max: Math.round(Math.max(...samples.map(s => s.rss)) / 1024 * 10) / 10 },
    load: { start: Math.round(load[0] * 100) / 100, end: Math.round(load[1] * 100) / 100 },
    ...(chat ? { chat: { frames: chat.frames, bytes: chat.bytes, closed: chat.closed } } : {}),
    ...(poller ? { overview: { polls, errors: pollErrors, meanMs: polls ? Math.round(pollMs / polls) : undefined } } : {}) };
}

function table(results) {
  const rows = [];
  const keys = kind => [...new Set(results.flatMap(r => Object.keys(r.perMinute[kind] ?? {})))].sort();
  const sum = (r, kind) => Math.round(Object.values(r.perMinute[kind] ?? {}).reduce((a, b) => a + b, 0) * 10) / 10;
  rows.push(["Herdr calls/min (all)", ...results.map(r => sum(r, "herdr"))]);
  for (const key of keys("herdr")) rows.push([`  herdr ${key}`, ...results.map(r => r.perMinute.herdr[key] ?? 0)]);
  rows.push(["Identity probes/min (lsof/proc)", ...results.map(r => Math.round(((r.perMinute.identity.lsof ?? 0) + (r.perMinute.identity.proc ?? 0)) * 10) / 10)]);
  for (const key of keys("identity")) rows.push([`  identity ${key}`, ...results.map(r => r.perMinute.identity[key] ?? 0)]);
  rows.push(["Git spawns/min", ...results.map(r => sum(r, "git"))]);
  for (const key of keys("git")) rows.push([`  git ${key}`, ...results.map(r => r.perMinute.git[key] ?? 0)]);
  for (const key of keys("timers")) rows.push([`  timer ${key}`, ...results.map(r => r.perMinute.timers[key] ?? 0)]);
  rows.push(["CPU % (of one core)", ...results.map(r => r.cpuPercent)]);
  rows.push(["RSS MiB mean / max", ...results.map(r => `${r.rssMiB.mean} / ${r.rssMiB.max}`)]);
  rows.push(["Load avg start / end", ...results.map(r => `${r.load.start} / ${r.load.end}`)]);
  rows.push(["Minutes sampled", ...results.map(r => r.minutes)]);
  const header = ["", ...results.map(r => r.scenario)];
  const lines = [header, header.map(() => "---"), ...rows].map(row => `| ${row.join(" | ")} |`);
  return lines.join("\n");
}

const metrics = await get("/v1/metrics").catch(error => { throw new Error(`No /v1/metrics on ${socket}: ${error.message}. Is this Hook new enough?`); });
const pid = Number(option("pid", metrics.pid));
log(`Hook pid ${pid}, socket ${path.basename(path.dirname(socket))}/${path.basename(socket)}, ${minutes} min per scenario`);
const results = [];
for (const [index, name] of scenarios.entries()) {
  if (!["idle", "chat", "overview"].includes(name)) throw new Error(`Unknown scenario ${name}`);
  if (index > 0) { log(`settling ${settleSeconds} s`); await sleep(settleSeconds * 1000); }
  log(`${name}: sampling`);
  results.push(await run(name, pid));
}
if (asJson) console.log(JSON.stringify(results, null, 2));
else {
  console.log(table(results));
  for (const r of results) {
    if (r.chat) console.log(`chat: ${r.chat.frames} frames, ${r.chat.bytes} bytes${r.chat.closed ? `, closed early: ${r.chat.closed}` : ""}`);
    if (r.overview) console.log(`overview: ${r.overview.polls} polls, ${r.overview.errors} errors, mean ${r.overview.meanMs} ms`);
  }
}
