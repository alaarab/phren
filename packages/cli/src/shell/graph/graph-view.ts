/**
 * Renders the terminal graph view: a braille force-graph canvas with a
 * details pane beside it (or a strip beneath it on narrow terminals).
 *
 * Mirrors the web viewer's layout — canvas left, contents pane right — and
 * its colour language: nodes take their topic/kind colour, the selection is
 * amber, search dims everything that does not match.
 */

import { ACCENT_AMBER, ACCENT_CYAN, BG_COLOR, KIND_COLORS } from "../../graph-core/types.js";
import type { NodeKind, RawLink, RuntimeNode } from "../../graph-core/types.js";
import { nodeRank } from "../../graph-core/model.js";
import { displayWidth, padToWidth, style } from "../render.js";
import { BrailleCanvas, blendHex, hexToSgr } from "./canvas.js";
import type { GraphController } from "./controller.js";
import { graphGlyphs } from "./glyphs.js";
import { MASCOT_COLOR, MASCOT_SPARK } from "./mascot.js";
import { formatAge } from "./watch.js";

const PANE_WIDTH = 34;
const WIDE_BREAKPOINT = 100;
/** Ceiling for the narrow-terminal detail strip; it only takes what it fills. */
const NARROW_STRIP_MAX = 6;
const DIM_TARGET = "#3a3f55";

/** Resolved per frame so PHREN_ICONS is honoured without a restart. */
let KIND_GLYPH = graphGlyphs();

const KIND_LABEL: Record<NodeKind, string> = {
  project: "project",
  finding: "finding",
  task: "task",
  entity: "fragment",
  reference: "reference",
  other: "node",
};

const HEALTH_COLOR: Record<RuntimeNode["health"], string> = {
  healthy: "#3ae374",
  decaying: "#ffb648",
  stale: "#ff5470",
};

function sgr(hex: string, extra = ""): string {
  return `${hexToSgr(hex)}${extra}`;
}

function colored(hex: string, text: string): string {
  return `${hexToSgr(hex)}${text}\x1b[0m`;
}

/** Word-wrap plain text to `width` cells, at most `maxLines` lines, ellipsised. */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= width) { current = candidate; continue; }
    if (current) lines.push(current);
    current = displayWidth(word) > width ? `${sliceWidth(word, width - 1)}…` : word;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) lines.length = maxLines;
  const complete = lines.join(" ") === words.join(" ");
  if (lines.length === maxLines && !complete && !lines[maxLines - 1].endsWith("…")) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = displayWidth(last) >= width ? `${sliceWidth(last, width - 1)}…` : `${last}…`;
  }
  return lines;
}

function sliceWidth(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Braille radius for a node from its viewer size. */
function dotRadius(node: RuntimeNode, selected: boolean): number {
  const base = node.kind === "project" ? 3 : node.size >= 16 ? 2 : node.size >= 10 ? 1 : 0;
  return selected ? base + 1 : base;
}

interface Placed {
  node: RuntimeNode;
  x: number;
  y: number;
}

export function renderGraphView(controller: GraphController, width: number, height: number): string[] {
  KIND_GLYPH = graphGlyphs();
  if (controller.status === "loading" || controller.status === "idle") return centered(width, height, [
    colored(ACCENT_CYAN, "⠿ building your knowledge graph…"),
    style.dim("scanning findings, tasks, fragments and references"),
  ]);
  if (controller.status === "error") return centered(width, height, [
    style.boldRed("graph build failed"),
    style.dim(controller.errorText || "unknown error"),
    style.dim("press r to retry"),
  ]);
  if (controller.status === "empty") return centered(width, height, [
    style.bold("nothing to draw yet"),
    style.dim("add a project and some findings, then come back"),
  ]);

  const wide = width >= WIDE_BREAKPOINT;
  const selected = controller.selectedId ? controller.model.nodeById.get(controller.selectedId) ?? null : null;
  // Build the strip first so it takes only the rows it fills; every row it
  // gives back goes to the graph, which is the part worth the space.
  const strip = !wide && selected ? renderStrip(controller, selected, width, NARROW_STRIP_MAX) : [];
  const canvasCols = wide ? width - PANE_WIDTH - 1 : width;
  const canvasRows = Math.max(4, height - strip.length);

  const canvasLines = drawCanvas(controller, canvasCols, canvasRows, selected);

  if (wide) {
    const pane = renderPane(controller, selected, PANE_WIDTH, canvasRows);
    const divider = style.dim("│");
    return canvasLines.map((line, i) => `${line}${divider}${padToWidth(pane[i] ?? "", PANE_WIDTH)}`);
  }
  return [...canvasLines, ...strip.map((line) => padToWidth(line, width))];
}

function centered(width: number, height: number, lines: string[]): string[] {
  const out: string[] = [];
  const top = Math.max(0, Math.floor((height - lines.length) / 2));
  for (let i = 0; i < height; i++) {
    const line = lines[i - top];
    if (!line) { out.push(" ".repeat(width)); continue; }
    const pad = Math.max(0, Math.floor((width - displayWidth(line)) / 2));
    out.push(padToWidth(" ".repeat(pad) + line, width));
  }
  return out;
}

function drawCanvas(controller: GraphController, cols: number, rows: number, selected: RuntimeNode | null): string[] {
  const canvas = new BrailleCanvas(cols, rows);
  controller.setViewport(canvas.dotWidth, canvas.dotHeight);
  const positions = controller.positions;
  const searching = Boolean(controller.search.query);
  const matches = controller.search.matchIds;
  const placed: Placed[] = [];
  const projected = new Map<string, { x: number; y: number }>();
  for (const node of controller.visible.nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    const d = controller.project(p);
    projected.set(node.id, d);
    placed.push({ node, x: d.x, y: d.y });
  }
  const isLit = (id: string): boolean => !searching || matches.has(id);
  // How connected the selection is, so a hub's highlight stays readable.
  const selectedDegree = selected ? (controller.model.visibleAdjacency.get(selected.id)?.size ?? 0) : 0;

  // Edges first so node dots win the cell colour.
  for (const link of controller.visible.links) {
    const a = projected.get(link.source);
    const b = projected.get(link.target);
    if (!a || !b) continue;
    const touchesSelected = selected !== null && (link.source === selected.id || link.target === selected.id);
    const color = edgeColor(controller, link, touchesSelected, isLit(link.source) && isLit(link.target), selectedDegree);
    canvas.line(a.x, a.y, b.x, b.y, color, { z: touchesSelected ? 2 : 0, dotted: link.kind === "contradicts" });
  }

  const watching = controller.watchEnabled && controller.watch.running;
  const heatOf = (id: string): number => (watching ? controller.watch.heatOf(id) : 0);
  for (const { node, x, y } of placed) {
    const isSelected = selected?.id === node.id;
    const heat = heatOf(node.id);
    let color = node.baseColor;
    if (isSelected) color = ACCENT_AMBER;
    else if (searching && !matches.has(node.id)) color = blendHex(node.baseColor, DIM_TARGET, 0.7);
    // A just-touched node pulses toward the live cyan and swells a little.
    if (heat > 0) color = blendHex(color, ACCENT_CYAN, 0.3 + heat * 0.55);
    const radius = dotRadius(node, isSelected) + (heat > 0.35 ? 1 : 0);
    canvas.disc(x, y, radius, color, isSelected ? 4 : heat > 0 ? 3 : node.kind === "project" ? 3 : 1);
    // A ring around the hottest nodes, so a hit reads at a glance.
    if (heat > 0.55) {
      const r = radius + 2;
      for (let a = 0; a < 16; a++) {
        const t = (a / 16) * Math.PI * 2;
        canvas.setDot(x + Math.cos(t) * r, y + Math.sin(t) * r * 0.9, blendHex(ACCENT_CYAN, BG_COLOR, 1 - heat), 2);
      }
    }
  }

  // Glyphs and labels are drawn in two separate passes, and the order matters.
  // Drawing a glyph and its label per node let a later node's glyph land inside
  // an earlier node's label, which is what produced `sear◉hweb` on a busy
  // canvas. Every glyph goes down first; labels then treat those cells as
  // occupied and route around them.
  const neighborIndex = new Map<string, number>();
  if (selected) controller.neighborsOf(selected.id).slice(0, 9).forEach((node, i) => neighborIndex.set(node.id, i + 1));
  const currentHit = searching ? controller.search.results[controller.search.index]?.id : undefined;
  const zoomedIn = Math.min(controller.camera.scaleX, controller.camera.scaleY) >= 5;
  const ranked = placed.slice().sort((a, b) => labelPriority(controller, b.node, selected, neighborIndex) - labelPriority(controller, a.node, selected, neighborIndex));
  const onCanvas = ({ x, y }: Placed): { col: number; row: number } | null => {
    const col = Math.floor(x / 2);
    const row = Math.floor(y / 4);
    return col < 0 || col >= cols || row < 0 || row >= rows ? null : { col, row };
  };

  // Pass 1 — glyphs.
  for (const item of ranked) {
    const at = onCanvas(item);
    if (!at) continue;
    const { node } = item;
    const isSelected = selected?.id === node.id;
    const lit = isLit(node.id);
    const glyphColor = isSelected ? ACCENT_AMBER : lit ? node.baseColor : blendHex(node.baseColor, DIM_TARGET, 0.7);
    const number = neighborIndex.get(node.id);
    if (isSelected) canvas.putText(at.col, at.row, "◆", sgr(ACCENT_AMBER, "\x1b[1m"));
    else if (node.kind === "project") canvas.putText(at.col, at.row, KIND_GLYPH.project, sgr(glyphColor, "\x1b[1m"));
    else if (number !== undefined) canvas.putText(at.col, at.row, String(number), sgr(ACCENT_CYAN, "\x1b[1m"));
  }

  // Every project used to force a label, so forty of them piled into one
  // unreadable heap. Only as many as the canvas can carry get named, largest
  // first; the rest still show their glyph.
  const projectLabelBudget = Math.max(4, Math.floor((cols * rows) / 120));
  const namedProjects = new Set(
    placed
      .filter(({ node }) => node.kind === "project")
      .sort((a, b) => projectWeight(b.node) - projectWeight(a.node))
      .slice(0, projectLabelBudget)
      .map(({ node }) => node.id),
  );

  /** A label needs a clear cell either side, or two labels read as one word. */
  const hasRoom = (col: number, row: number, w: number, avoidDots: boolean): boolean => {
    if (col < 0 || col + w > cols) return false;
    const start = Math.max(0, col - 1);
    const end = Math.min(cols, col + w + 1);
    return canvas.isFree(start, row, end - start, avoidDots);
  };

  // Pass 2 — labels.
  const labelBudget = searching ? 14 : zoomedIn ? Math.max(8, Math.floor((cols * rows) / 60)) : Math.max(4, Math.floor((cols * rows) / 220));
  let labels = 0;
  for (const item of ranked) {
    const at = onCanvas(item);
    if (!at) continue;
    const { node } = item;
    const { col, row } = at;
    const isSelected = selected?.id === node.id;
    const lit = isLit(node.id);
    const glyphColor = isSelected ? ACCENT_AMBER : lit ? node.baseColor : blendHex(node.baseColor, DIM_TARGET, 0.7);
    const number = neighborIndex.get(node.id);
    const forced = isSelected
      || node.id === currentHit
      || heatOf(node.id) > 0
      || (node.kind === "project" ? namedProjects.has(node.id) : node.forceLabel);
    const wanted = forced || number !== undefined || (lit && labels < labelBudget && (zoomedIn || searching));
    if (!wanted) continue;
    const maxLabel = node.kind === "project" ? 20 : number !== undefined ? 14 : 18;
    const text = sliceWidth(node.label, maxLabel);
    const w = displayWidth(text);
    const labelSgr = isSelected
      ? `${hexToSgr(BG_COLOR)}\x1b[48;2;255;209;102m\x1b[1m`
      : node.kind === "project"
        ? sgr(glyphColor, "\x1b[1m")
        : number !== undefined
          ? sgr(lit ? blendHex(node.baseColor, "#ffffff", 0.35) : blendHex(node.baseColor, DIM_TARGET, 0.6))
          : sgr(lit ? blendHex(node.baseColor, "#ffffff", 0.2) : blendHex(node.baseColor, DIM_TARGET, 0.6));
    const slots: Array<[number, number]> = [[col + 2, row], [col - w - 1, row], [col + 2, row - 1], [col + 2, row + 1], [col - w - 1, row - 1], [col - w - 1, row + 1]];
    // Clean slots first (no text, no dots); forced labels may cover dots as a
    // last resort, but never another label.
    const placedAt = slots.find(([c, r]) => hasRoom(c, r, w, true)) ?? (forced ? slots.find(([c, r]) => hasRoom(c, r, w, false)) : undefined);
    if (!placedAt) continue;
    canvas.putText(placedAt[0], placedAt[1], text, labelSgr);
    if (!forced) labels++;
  }

  // Agents sit beside the project they are working in. They are runtime state,
  // not memory, so they decorate a node rather than becoming one.
  if (controller.agents.enabled && controller.agents.agents.length) {
    const highlighted = controller.agents.current;
    for (const [project, agents] of controller.agents.byProject()) {
      const p = positions.get(project);
      if (!p) continue;
      const d = controller.project(p);
      const col = Math.floor(d.x / 2);
      const row = Math.floor(d.y / 4) - 1;
      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const busiest = agents.find((a) => a.status === "working") ?? agents[0];
      const isHighlighted = agents.some((a) => a.id === highlighted?.id);
      const mark = agents.length > 1 ? `▲${agents.length}` : "▲";
      const color = AGENT_STATUS_COLOR[busiest.status] ?? "#7f8db3";
      const marker = isHighlighted
        ? `${hexToSgr(BG_COLOR)}\x1b[48;2;58;227;116m\x1b[1m`
        : sgr(color, "\x1b[1m");
      canvas.putText(col, row, mark, marker);
    }
  }

  // phren, wherever he currently is. Drawn after everything else so he is
  // never lost in the dot field — he is the thing you are meant to follow.
  const mascotPos = controller.mascot.pos;
  if (mascotPos) {
    const d = controller.project(mascotPos);
    const col = Math.floor(d.x / 2);
    const row = Math.floor(d.y / 4);
    if (col >= 0 && col < cols && row >= 0 && row < rows) {
      const glow = controller.mascot.arrivalGlow();
      // A cyan halo on arrival, fading out, so a landing reads at a glance.
      if (glow > 0) {
        for (let a = 0; a < 12; a++) {
          const t = (a / 12) * Math.PI * 2;
          canvas.setDot(d.x + Math.cos(t) * 5, d.y + Math.sin(t) * 4.5, blendHex(MASCOT_SPARK, BG_COLOR, 1 - glow), 5);
        }
      }
      // He perches *beside* what he is visiting, never on top of it — sitting
      // on the node would hide the very marker you are meant to be looking at.
      const perch = [[col - 1, row], [col + 1, row], [col, row - 1], [col - 1, row - 1]]
        .find(([c, r]) => canvas.isFree(c, r, 1)) ?? [col - 1, row];
      if (glow > 0) canvas.putText(perch[0], perch[1] - 1, "✦", sgr(blendHex(MASCOT_SPARK, BG_COLOR, 1 - glow), "\x1b[1m"));
      canvas.putText(perch[0], perch[1], "◕", sgr(MASCOT_COLOR, "\x1b[1m"));
    }
  }

  if (controller.refreshing) {
    const badge = " ⟳ refreshing ";
    canvas.putText(cols - displayWidth(badge), 0, badge, sgr(ACCENT_CYAN, "\x1b[2m"));
  }
  return canvas.render();
}

/**
 * Edges keep their own colour when the selection touches them, lifted toward
 * amber rather than replaced by it. Painting every attached edge solid amber
 * turned a selected project into a solid yellow fan — the more a node connected,
 * the less the highlight told you — so a hub is lifted least.
 */
function edgeColor(controller: GraphController, link: RawLink, touchesSelected: boolean, lit: boolean, degree = 0): string {
  let base: string;
  if (link.kind === "fragment") base = blendHex(ACCENT_CYAN, BG_COLOR, 0.45);
  else if (link.kind === "contradicts") base = "#ff5470";
  else if (link.kind === "supersedes") base = "#8a93b8";
  else {
    const leaf = controller.model.nodeById.get(link.target)?.kind === "project" ? link.source : link.target;
    const node = controller.model.nodeById.get(leaf);
    base = blendHex(node?.baseColor ?? KIND_COLORS.other, BG_COLOR, 0.55);
  }
  const shown = lit ? base : blendHex(base, BG_COLOR, 0.6);
  if (!touchesSelected) return shown;
  const lift = degree > 24 ? 0.22 : degree > 8 ? 0.34 : 0.5;
  return blendHex(shown, ACCENT_AMBER, lift);
}

/** How much of the store a project holds; decides which get named when space is short. */
function projectWeight(node: RuntimeNode): number {
  return (node.findingCount ?? 0) + (node.taskCount ?? 0) + (node.refCount ?? 0);
}

function labelPriority(controller: GraphController, node: RuntimeNode, selected: RuntimeNode | null, neighborIndex: Map<string, number>): number {
  let score = nodeRank(node, controller.filters, controller.model.scores);
  if (selected?.id === node.id) score += 100000;
  if (node.kind === "project") score += 50000;
  if (neighborIndex.has(node.id)) score += 30000 - (neighborIndex.get(node.id) ?? 0);
  if (controller.search.matchIds.has(node.id)) score += 20000;
  return score;
}

/**
 * The one line of graph state worth spending characters on, rendered into the
 * shell header rather than a row of its own. A legend of kind counts told you
 * nothing the colours on screen did not, but whether you are looking at your
 * whole store or a sample of it changes how you read the picture.
 */
export function graphSummary(controller: GraphController): string {
  if (controller.status !== "ready") return "";
  const shown = controller.visible.nodes.length;
  const total = controller.model.rawNodes.length;
  const n = (v: number) => v.toLocaleString("en-US");
  const capped = shown < total ? `${n(shown)} of ${n(total)} nodes` : `${n(shown)} nodes`;
  const parts = [capped, `${n(controller.visible.links.length)} edges`];
  if (controller.watchEnabled && controller.watch.running) parts.push(`${colored(ACCENT_CYAN, "◉")}${style.dim(" live")}`);
  return parts.join(style.dim("  ·  "));
}

function healthDot(node: RuntimeNode): string {
  return `${colored(HEALTH_COLOR[node.health], "●")} ${node.health}`;
}

function renderPane(controller: GraphController, selected: RuntimeNode | null, width: number, height: number): string[] {
  const inner = width - 2;
  const watching = controller.watchEnabled && controller.watch.running;
  const lines: string[] = [];
  const push = (line = "") => { if (lines.length < height) lines.push(` ${line}`); };
  const row = (label: string, value: string) => push(`${style.dim(label.padEnd(9))}${value}`);

  if (selected) {
    const detail = controller.detail(selected.id);
    push(`${colored(selected.kind === "project" ? KIND_COLORS.project : selected.baseColor, KIND_GLYPH[selected.kind])} ${style.bold(KIND_LABEL[selected.kind])}${selected.kind === "task" && selected.section ? style.dim(`  ${selected.section.toLowerCase()}`) : ""}`);
    for (const line of wrapText(selected.fullLabel || selected.label, inner, watching ? 7 : 4)) push(line);
    push();
    if (selected.kind !== "project" && selected.project) row("project", style.cyan(selected.project));
    if (selected.kind === "project") {
      row("findings", String(selected.findingCount ?? 0));
      row("tasks", String(selected.taskCount ?? 0));
      if (selected.store && selected.store !== "primary") row("store", selected.store);
    }
    if (selected.topicLabel || selected.topicSlug) row("topic", colored(selected.baseColor, selected.topicLabel || selected.topicSlug || ""));
    if (selected.entityType) row("type", selected.entityType);
    if (selected.priority) row("priority", selected.priority);
    if (selected.date) row("date", selected.date);
    row("health", healthDot(selected));
    if (detail?.qualityScore != null) row("quality", `${Math.round(detail.qualityScore * 100)}%`);
    if (detail?.score?.helpful) row("helpful", `${detail.score.helpful}×`);
    if (detail) {
      const c = detail.connections;
      const bits = [
        c.projects ? `${c.projects} proj` : "",
        c.findings ? `${c.findings} find` : "",
        c.tasks ? `${c.tasks} task` : "",
        c.entities ? `${c.entities} frag` : "",
        c.references ? `${c.references} ref` : "",
      ].filter(Boolean);
      row("links", `${c.total}${bits.length ? style.dim(`  ${bits.join(" ")}`) : ""}`);
    }
    const docs = (selected.refDocs ?? []).map((ref) => ref.doc);
    if (docs.length && selected.kind !== "finding" && selected.kind !== "task") {
      row("docs", sliceWidth(docs[0], inner - 9));
      for (const doc of docs.slice(1, 3)) push(`${" ".repeat(9)}${sliceWidth(doc, inner - 9)}`);
      if (docs.length > 3) push(`${" ".repeat(9)}${style.dim(`+${docs.length - 3} more`)}`);
    }
    const neighbors = controller.neighborsOf(selected.id);
    if (neighbors.length) {
      push();
      push(style.dim(`neighbours ${style.dim(`(1-9 jump)`)}`));
      const budget = Math.max(0, height - lines.length - 1);
      neighbors.slice(0, Math.min(9, budget)).forEach((node, i) => {
        push(`${style.boldCyan(String(i + 1))} ${colored(node.baseColor, KIND_GLYPH[node.kind])} ${sliceWidth(node.label, inner - 4)}`);
      });
      if (neighbors.length > 9) push(style.dim(`  +${neighbors.length - 9} more`));
    }
    const agentBudget = height - lines.length - 1;
    if (agentBudget > 3) for (const line of agentLines(controller, inner, agentBudget)) push(line);
    if (watching) {
      const budget = height - lines.length - 1;
      if (budget > 3) for (const line of activityLines(controller, inner, budget)) push(line);
    }
  } else {
    const total = controller.model.rawNodes.length;
    const shown = controller.visible.nodes.length;
    push(`${colored(ACCENT_CYAN, "❖")} ${style.bold("knowledge graph")}${controller.refreshing ? style.dim("  ⟳") : ""}${watching ? `  ${colored(ACCENT_CYAN, "◉")}${style.dim(" live")}` : ""}`);
    push(style.dim(shown === total ? `${shown} nodes · ${controller.visible.links.length} edges` : `${shown} of ${total} nodes · ${controller.visible.links.length} edges`));
    push();
    row("filter", `${controller.preset.name}${style.dim("  f")}`);
    row("focus", `${controller.focusedProject ? style.cyan(controller.focusedProject) : style.dim("all projects")}${style.dim("  [ ]")}`);
    row("search", controller.search.query
      ? `${style.yellow(controller.search.query)} ${style.dim(`${controller.search.results.length} hit${controller.search.results.length === 1 ? "" : "s"}`)}`
      : `${style.dim("—")}${style.dim("  /")}`);
    push();
    const projects = controller.projects;
    if (projects.length) {
      push(style.dim("projects"));
      const budget = Math.max(0, height - lines.length - 9);
      for (const project of projects.slice(0, budget)) {
        const name = project.project || project.id;
        const isFocus = controller.focusedProject === name;
        push(`${colored(project.baseColor, KIND_GLYPH.project)} ${isFocus ? style.boldCyan(sliceWidth(name, inner - 12)) : sliceWidth(name, inner - 12)} ${style.dim(`${project.findingCount ?? 0}✦ ${project.taskCount ?? 0}▤`)}`);
      }
      if (projects.length > budget) push(style.dim(`  +${projects.length - budget} more`));
      push();
    }
    const agentBudget = height - lines.length - 1;
    if (agentBudget > 3) for (const line of agentLines(controller, inner, agentBudget)) push(line);
    if (watching) {
      const budget = height - lines.length - 1;
      if (budget > 3) {
        for (const line of activityLines(controller, inner, budget)) push(line);
        while (lines.length < height) lines.push("");
        return lines.slice(0, height);
      }
    }
    const k = (s: string) => style.boldCyan(s);
    const d = (s: string) => style.dim(s);
    push(`${k("↑↓←→")} ${d("walk")}   ${k("↵")} ${d("select")}`);
    push(`${k("1-9")} ${d("jump to neighbour")}`);
    push(`${k("/")} ${d("search")}  ${k("n")}${d("/")}${k("N")} ${d("next/prev")}`);
    push(`${k("f")} ${d("filter")}   ${k("[ ]")} ${d("project")}`);
    push(`${k("+ -")} ${d("zoom")}   ${k("0")} ${d("fit")}   ${k("r")} ${d("relayout")}`);
    push(`${k("⇧↑↓←→")} ${d("pan")}   ${k("o")} ${d("3D viewer")}`);
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}


const AGENT_STATUS_COLOR: Record<string, string> = {
  working: "#3ae374",
  idle: "#48b2ff",
  done: "#5c6b8a",
  error: "#ff5470",
};

const SOURCE_COLOR: Record<string, string> = {
  search: ACCENT_CYAN,
  inject: ACCENT_AMBER,
  write: "#3ae374",
};

/**
 * The live feed: what phren has just landed on, newest first. Each event gets
 * a meta line and as much of the memory's text as the pane can carry, because
 * the point of watching is reading what was found, not just seeing it blink.
 */
/**
 * Who is working, and where. Rendered above the activity feed so the pane reads
 * top to bottom as: what is selected, who is on it, what phren just touched.
 */
function agentLines(controller: GraphController, inner: number, budget: number): string[] {
  const agents = controller.agents.agents;
  const out: string[] = [];
  if (!controller.agents.enabled) return out;
  out.push("");
  out.push(`${colored(agents.length ? "#3ae374" : "#5c6b8a", "▲")} ${style.dim(`agents${agents.length ? "" : " — none running"}`)}`);
  const current = controller.agents.current;
  for (const agent of agents) {
    if (out.length >= budget - 1) break;
    const isCurrent = agent.id === current?.id;
    const color = AGENT_STATUS_COLOR[agent.status] ?? "#7f8db3";
    const marker = isCurrent ? style.boldCyan("›") : " ";
    out.push(`${marker}${colored(color, "●")} ${sliceWidth(agent.label, inner - 3)}`);
    if (out.length >= budget - 1) break;
    const where = agent.project ?? style.dim("outside phren");
    out.push(`  ${style.dim(agent.status)} ${style.dim("·")} ${agent.project ? style.cyan(where) : where}`);
  }
  if (agents.length) out.push(style.dim("  tab cycle · ↵ focus"));
  return out.slice(0, budget);
}

function activityLines(controller: GraphController, inner: number, budget: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  const live = controller.watch.hot;
  out.push("");
  out.push(`${colored(live ? ACCENT_CYAN : "#5c6b8a", live ? "◉" : "○")} ${style.dim("activity")}`);
  if (!controller.watch.activity.length) {
    out.push(style.dim("  nothing yet — run a search"));
    out.push(style.dim("  in another terminal"));
    return out.slice(0, budget);
  }
  for (const item of controller.watch.activity) {
    if (out.length >= budget - 1) break;
    const age = item.historical ? "" : formatAge(now - item.seenAt);
    const source = item.event.source || "lookup";
    const color = SOURCE_COLOR[source] ?? "#7f8db3";
    const heat = item.nodeId ? controller.watch.heatOf(item.nodeId) : 0;
    const meta = `${style.dim(age.padEnd(4))}${colored(color, source)} ${style.dim("·")} ${style.cyan(sliceWidth(item.event.project, inner - age.length - source.length - 4))}`;
    out.push(heat > 0.5 ? `${meta}` : meta);
    const text = item.event.snippet || item.event.filename || "";
    if (text && out.length < budget - 1) {
      const wrapped = wrapText(text, inner - 2, heat > 0 ? 3 : 2);
      for (const line of wrapped) {
        if (out.length >= budget - 1) break;
        out.push(`  ${heat > 0 ? colored(blendHex("#e2e8f0", ACCENT_CYAN, heat * 0.7), line) : style.dim(line)}`);
      }
    }
  }
  return out.slice(0, budget);
}

function renderStrip(controller: GraphController, selected: RuntimeNode, width: number, rows: number): string[] {
  const detail = controller.detail(selected.id);
  const lines: string[] = [];
  const head = [
    `${colored(selected.baseColor, KIND_GLYPH[selected.kind])} ${style.bold(KIND_LABEL[selected.kind])}`,
    selected.project && selected.kind !== "project" ? style.cyan(selected.project) : "",
    selected.topicLabel || selected.topicSlug || "",
    healthDot(selected),
    detail ? style.dim(`${detail.connections.total} links`) : "",
  ].filter(Boolean);
  lines.push(` ${head.join(style.dim(" · "))}`);
  for (const line of wrapText(selected.fullLabel || selected.label, width - 2, 2)) lines.push(` ${line}`);
  const neighbors = controller.neighborsOf(selected.id).slice(0, 9);
  if (neighbors.length) {
    const items = neighbors.map((node, i) => `${style.boldCyan(String(i + 1))} ${colored(node.baseColor, KIND_GLYPH[node.kind])} ${sliceWidth(node.label, 14)}`);
    let line = " ";
    for (const item of items) {
      if (displayWidth(line + item) + 2 > width) break;
      line += `${item}  `;
    }
    lines.push(line.trimEnd());
  }
  return lines.slice(0, rows);
}
