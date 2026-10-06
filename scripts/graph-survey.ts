/**
 * Graph scaling survey.
 *
 * Renders the shell's Graph view against synthetic stores from 3 to 40
 * projects at several terminal sizes and prints node counts, cap behaviour,
 * build time and ink density. Written because three defects — labels
 * overwriting each other, the node cap concentrating on a few projects, and
 * whole categories vanishing — were all invisible on the small fixtures the
 * view was built against.
 *
 *   cd packages/cli && tsx ../../scripts/graph-survey.ts
 *
 * Frames are written to /tmp/sv-<scale>-<cols>x<rows>.ansi for eyeballing.
 */
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import { writeRootManifest } from "../packages/cli/src/shared.js";
import { PhrenShell } from "../packages/cli/src/shell/shell.js";
import { stripAnsi } from "../packages/cli/src/shell/render.js";
process.env.COLORTERM = "truecolor";

const TOPICS = ["architecture","debugging","security","performance","testing","devops","api","frontend","database","auth"];
const FRAGS = ["RetryPolicy","RateLimiter","AuthGuard","SessionStore","EventBus","CacheLayer","MigrationRunner","WebhookClient"];
const VERBS = ["wraps","caps","rejects","normalises","batches","retries","invalidates","serialises","short-circuits","backfills"];
const NOUNS = ["outbound calls","the checkout flow","webhook payloads","the session cookie","tenant lookups","the migration order","cold starts","the audit log","index rebuilds","the review queue"];

function makeStore(projects: number, findingsEach: number, tasksEach: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-survey-"));
  const w = (p: string, c: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  writeRootManifest(dir, { version: 1, installMode: "shared", syncMode: "managed-git" });
  const names = Array.from({ length: projects }, (_, i) => `${["web","api","mobile","infra","docs","data","auth","billing","search","media","admin","edge"][i % 12]}-${Math.floor(i / 12) || ""}${i % 12 === i ? "" : ""}`.replace(/-$/, "") + (i >= 12 ? `-${Math.floor(i / 12)}` : ""));
  const manual: unknown[] = [];
  for (const [pi, name] of names.entries()) {
    const lines = [`# ${name} FINDINGS`, "", "## 2026-09-01", ""];
    for (let i = 0; i < findingsEach; i++) {
      const frag = FRAGS[(i + pi) % FRAGS.length];
      const other = names[(pi + i + 1) % names.length];
      const mention = i % 7 === 0 && other !== name ? ` (also affects ${other})` : "";
      lines.push(`- [${TOPICS[(i + pi) % TOPICS.length]}] ${name}: ${frag} ${VERBS[i % VERBS.length]} ${NOUNS[(i + pi) % NOUNS.length]} under sustained load${mention}`);
      if (i % 40 === 39) lines.push("", `## 2026-08-${String(20 - (i / 40 | 0)).padStart(2, "0")}`, "");
    }
    w(path.join(dir, name, "FINDINGS.md"), lines.join("\n") + "\n");
    const act = Array.from({ length: Math.ceil(tasksEach / 2) }, (_, i) => `- [ ] ${name}: ${VERBS[i % VERBS.length]} ${NOUNS[i % NOUNS.length]} (${["high","medium","low"][i % 3]})`);
    const q = Array.from({ length: Math.floor(tasksEach / 2) }, (_, i) => `- [ ] ${name}: queued work item ${i}`);
    w(path.join(dir, name, "tasks.md"), `# ${name} tasks\n\n## Active\n\n${act.join("\n")}\n\n## Queue\n\n${q.join("\n")}\n\n## Done\n`);
    w(path.join(dir, name, "reference", "runbook.md"), `# ${name} runbook\n\n${FRAGS.slice(0, 4).join(", ")} notes.\n`);
    for (const f of FRAGS.slice(0, 4 + (pi % 4))) manual.push({ entity: f, entityType: "class", sourceDoc: `${name}/FINDINGS.md`, relType: "mentions" });
  }
  w(path.join(dir, ".runtime", "manual-links.json"), JSON.stringify(manual));
  return dir;
}

const SCALES: Array<[string, number, number, number]> = [
  ["tiny",    3,  10,  4],
  ["small",   6,  30,  8],
  ["medium", 12,  60, 16],
  ["large",  25, 120, 30],
  ["huge",   40, 250, 40],
];
const TERMS: Array<[number, number]> = [[80, 24], [120, 32], [200, 50]];

console.log("scale     proj  find  task | nodes links | visible  cap? | build layout | term      ink%  labels");
for (const [label, projects, findingsEach, tasksEach] of SCALES) {
  const dir = makeStore(projects, findingsEach, tasksEach);
  for (const [cols, rows] of TERMS) {
    Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
    const t0 = Date.now();
    const shell = new PhrenShell(dir, "", undefined, { view: "Graph" });
    await shell.render();
    const g = shell.graph();
    const build = Date.now() - t0;
    const t1 = Date.now();
    g.fitAll();
    const frame = await shell.render();
    const layout = Date.now() - t1;
    const plain = frame.split("\n").map(stripAnsi);
    // Ink density over the canvas region only (skip top 2 and bottom 3 chrome rows).
    const canvas = plain.slice(2, plain.length - 3);
    const cells = canvas.reduce((n, l) => n + l.length, 0);
    const inked = canvas.reduce((n, l) => n + [...l].filter((ch) => ch !== " ").length, 0);
    // Count label-ish runs: sequences of 3+ letters in the canvas.
    const labels = canvas.join("\n").match(/[A-Za-z][A-Za-z0-9 :._-]{2,}/g)?.length ?? 0;
    if (cols === 80) {
      const n = g.model.rawNodes.length, l = g.model.rawLinks.length;
      const capped = g.visible.nodes.length < n ? "YES" : "no";
      process.stdout.write(`${label.padEnd(9)} ${String(projects).padStart(4)} ${String(findingsEach).padStart(5)} ${String(tasksEach).padStart(5)} | ${String(n).padStart(5)} ${String(l).padStart(5)} | ${String(g.visible.nodes.length).padStart(7)}  ${capped.padEnd(4)} | ${String(build).padStart(5)} ${String(layout).padStart(6)} | `);
    } else {
      process.stdout.write(`${"".padEnd(9)} ${"".padStart(4)} ${"".padStart(5)} ${"".padStart(5)} | ${"".padStart(5)} ${"".padStart(5)} | ${"".padStart(7)}  ${"".padEnd(4)} | ${"".padStart(5)} ${String(layout).padStart(6)} | `);
    }
    console.log(`${`${cols}x${rows}`.padEnd(9)} ${String(Math.round((inked / Math.max(1, cells)) * 100)).padStart(4)}  ${String(labels).padStart(6)}`);
    fs.writeFileSync(`/tmp/sv-${label}-${cols}x${rows}.ansi`, frame);
    shell.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
