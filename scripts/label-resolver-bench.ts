/**
 * Micro-bench for graph-core's resolveLabelOverlaps (point 1 of the review).
 * Times k=80 and k=200 fixed-rectangle candidate sets over many iterations,
 * against the pre-review greedy (priority then distance, no hysteresis,
 * leaf-only cap) as the "before" baseline.
 *
 *   npx tsx scripts/label-resolver-bench.ts
 */
import { resolveLabelOverlaps } from "../packages/cli/src/graph-core/labels.js";
import type { LabelCandidate, LabelRect } from "../packages/cli/src/graph-core/labels.js";

function makeCandidates(k: number): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  for (let i = 0; i < k; i++) {
    const isGroup = i % 10 === 0;
    const col = i % 20;
    const row = Math.floor(i / 20);
    out.push({
      id: isGroup ? `g${i}` : `f${i}`,
      rect: { x0: col * 40, y0: row * 18, x1: col * 40 + 70, y1: row * 18 + 14 },
      isGroup,
      degree: (i * 7) % 50,
      recency: 1_700_000_000_000 + i * 1000,
      priority: i % 15 === 3 ? 2 : 0,
    });
  }
  return out;
}

/** Pre-review declutter: exact AABB, focus priority only, leaf-only cap. */
function resolveBefore(candidates: LabelCandidate[], cap: number): Set<string> {
  const ordered = candidates.slice().sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    if (pa !== pb) return pb - pa;
    if (a.degree !== b.degree) return b.degree - a.degree;
    return b.recency - a.recency;
  });
  const visible = new Set<string>();
  const placed: LabelRect[] = [];
  let leaves = 0;
  for (const c of ordered) {
    if (!c.isGroup && leaves >= cap) continue;
    let hit = false;
    for (const p of placed) {
      if (c.rect.x0 < p.x1 && c.rect.x1 > p.x0 && c.rect.y0 < p.y1 && c.rect.y1 > p.y0) {
        hit = true;
        break;
      }
    }
    if (hit) continue;
    visible.add(c.id);
    if (!c.isGroup) leaves++;
    placed.push(c.rect);
  }
  return visible;
}

function bench(label: string, run: () => void, iterations: number): void {
  for (let i = 0; i < 50; i++) run();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) run();
  const total = performance.now() - t0;
  console.log(`${label}: ${iterations} iters, ${total.toFixed(1)} ms total, ${(total / iterations).toFixed(3)} ms/call`);
}

const k80 = makeCandidates(80);
const k200 = makeCandidates(200);
const previous = new Set(k80.slice(0, 20).map(c => c.id));
const into = new Set<string>();

bench("BEFORE resolveLabel k=80 (old greedy)", () => { resolveBefore(k80, 72); }, 2000);
bench("BEFORE resolveLabel k=200 (old greedy)", () => { resolveBefore(k200, 72); }, 2000);
bench("AFTER  resolveLabelOverlaps k=80", () => {
  resolveLabelOverlaps(k80, { cap: 72, previousVisible: previous, into, pad: 1 });
}, 2000);
bench("AFTER  resolveLabelOverlaps k=200", () => {
  resolveLabelOverlaps(k200, { cap: 72, previousVisible: previous, into, pad: 1 });
}, 2000);
