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

const PANE_WIDTH = 34;
const WIDE_BREAKPOINT = 100;
const NARROW_STRIP_ROWS = 6;
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
  const stripRows = !wide && selected ? NARROW_STRIP_ROWS : 0;
  const canvasCols = wide ? width - PANE_WIDTH - 1 : width;
  const canvasRows = Math.max(4, height - 1 - stripRows);

  const canvas = drawCanvas(controller, canvasCols, canvasRows, selected);
  const legend = padToWidth(renderLegend(controller, canvasCols), canvasCols);
  const canvasLines = [...canvas, legend];

  if (wide) {
    const pane = renderPane(controller, selected, PANE_WIDTH, canvasRows + 1);
    const divider = style.dim("│");
    return canvasLines.map((line, i) => `${line}${divider}${padToWidth(pane[i] ?? "", PANE_WIDTH)}`);
  }
  const strip = selected ? renderStrip(controller, selected, width, stripRows) : [];
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

  // Edges first so node dots win the cell colour.
  for (const link of controller.visible.links) {
    const a = projected.get(link.source);
    const b = projected.get(link.target);
    if (!a || !b) continue;
    const touchesSelected = selected !== null && (link.source === selected.id || link.target === selected.id);
    const color = edgeColor(controller, link, touchesSelected, isLit(link.source) && isLit(link.target));
    canvas.line(a.x, a.y, b.x, b.y, color, { z: touchesSelected ? 2 : 0, dotted: link.kind === "contradicts" });
  }

  for (const { node, x, y } of placed) {
    const isSelected = selected?.id === node.id;
    let color = node.baseColor;
    if (isSelected) color = ACCENT_AMBER;
    else if (searching && !matches.has(node.id)) color = blendHex(node.baseColor, DIM_TARGET, 0.7);
    canvas.disc(x, y, dotRadius(node, isSelected), color, isSelected ? 4 : node.kind === "project" ? 3 : 1);
  }

  // Glyphs + labels live in the overlay so they are never eaten by dots.
  // Labelling policy: projects, the selection and the current search hit are
  // always named; the selection's neighbours get their 1-9 jump number; other
  // leaves are named only while there is room (zoomed in, or a search has
  // thinned the field) and only where the text does not cover other nodes.
  const neighborIndex = new Map<string, number>();
  if (selected) controller.neighborsOf(selected.id).slice(0, 9).forEach((node, i) => neighborIndex.set(node.id, i + 1));
  const currentHit = searching ? controller.search.results[controller.search.index]?.id : undefined;
  const zoomedIn = controller.camera.scale >= 5;
  const ranked = placed.slice().sort((a, b) => labelPriority(controller, b.node, selected, neighborIndex) - labelPriority(controller, a.node, selected, neighborIndex));
  const labelBudget = searching ? 14 : zoomedIn ? Math.max(8, Math.floor((cols * rows) / 60)) : Math.max(4, Math.floor((cols * rows) / 220));
  let labels = 0;
  for (const { node, x, y } of ranked) {
    const col = Math.floor(x / 2);
    const row = Math.floor(y / 4);
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    const isSelected = selected?.id === node.id;
    const lit = isLit(node.id);
    const glyphColor = isSelected ? ACCENT_AMBER : lit ? node.baseColor : blendHex(node.baseColor, DIM_TARGET, 0.7);
    const number = neighborIndex.get(node.id);
    if (isSelected) canvas.putText(col, row, "◆", sgr(ACCENT_AMBER, "\x1b[1m"));
    else if (node.kind === "project") canvas.putText(col, row, KIND_GLYPH.project, sgr(glyphColor, "\x1b[1m"));
    else if (number !== undefined) canvas.putText(col, row, String(number), sgr(ACCENT_CYAN, "\x1b[1m"));
    const forced = node.forceLabel || isSelected || node.id === currentHit;
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
    // Clean slots first (no text, no dots); forced labels may cover dots as a last resort.
    const placedAt = slots.find(([c, r]) => canvas.isFree(c, r, w, true)) ?? (forced ? slots.find(([c, r]) => canvas.isFree(c, r, w)) : undefined);
    if (!placedAt) continue;
    canvas.putText(placedAt[0], placedAt[1], text, labelSgr);
    if (!forced) labels++;
  }

  if (controller.refreshing) {
    const badge = " ⟳ refreshing ";
    canvas.putText(cols - displayWidth(badge), 0, badge, sgr(ACCENT_CYAN, "\x1b[2m"));
  }
  return canvas.render();
}

function edgeColor(controller: GraphController, link: RawLink, touchesSelected: boolean, lit: boolean): string {
  if (touchesSelected) return ACCENT_AMBER;
  let base: string;
  if (link.kind === "fragment") base = blendHex(ACCENT_CYAN, BG_COLOR, 0.45);
  else if (link.kind === "contradicts") base = "#ff5470";
  else if (link.kind === "supersedes") base = "#8a93b8";
  else {
    const leaf = controller.model.nodeById.get(link.target)?.kind === "project" ? link.source : link.target;
    const node = controller.model.nodeById.get(leaf);
    base = blendHex(node?.baseColor ?? KIND_COLORS.other, BG_COLOR, 0.55);
  }
  return lit ? base : blendHex(base, BG_COLOR, 0.6);
}

function labelPriority(controller: GraphController, node: RuntimeNode, selected: RuntimeNode | null, neighborIndex: Map<string, number>): number {
  let score = nodeRank(node, controller.filters, controller.model.scores);
  if (selected?.id === node.id) score += 100000;
  if (node.kind === "project") score += 50000;
  if (neighborIndex.has(node.id)) score += 30000 - (neighborIndex.get(node.id) ?? 0);
  if (controller.search.matchIds.has(node.id)) score += 20000;
  return score;
}

function renderLegend(controller: GraphController, width: number): string {
  const counts: Record<NodeKind, number> = { project: 0, finding: 0, task: 0, entity: 0, reference: 0, other: 0 };
  for (const node of controller.visible.nodes) counts[node.kind]++;
  const parts: string[] = [];
  const entry = (kind: NodeKind, color: string) => {
    if (!counts[kind]) return;
    parts.push(`${colored(color, KIND_GLYPH[kind])} ${style.dim(`${counts[kind]} ${KIND_LABEL[kind]}${counts[kind] === 1 ? "" : "s"}`)}`);
  };
  entry("project", KIND_COLORS.project);
  entry("finding", "#46c8ff");
  entry("task", KIND_COLORS["task-active"]);
  entry("entity", KIND_COLORS.entity);
  entry("reference", KIND_COLORS.reference);
  const edges = controller.visible.links.length;
  parts.push(style.dim(`${edges} edge${edges === 1 ? "" : "s"}`));
  let line = ` ${parts.join(style.dim("  ·  "))}`;
  if (displayWidth(line) > width) line = ` ${parts.join(style.dim(" · "))}`;
  return line;
}

function healthDot(node: RuntimeNode): string {
  return `${colored(HEALTH_COLOR[node.health], "●")} ${node.health}`;
}

function renderPane(controller: GraphController, selected: RuntimeNode | null, width: number, height: number): string[] {
  const inner = width - 2;
  const lines: string[] = [];
  const push = (line = "") => { if (lines.length < height) lines.push(` ${line}`); };
  const row = (label: string, value: string) => push(`${style.dim(label.padEnd(9))}${value}`);

  if (selected) {
    const detail = controller.detail(selected.id);
    push(`${colored(selected.kind === "project" ? KIND_COLORS.project : selected.baseColor, KIND_GLYPH[selected.kind])} ${style.bold(KIND_LABEL[selected.kind])}${selected.kind === "task" && selected.section ? style.dim(`  ${selected.section.toLowerCase()}`) : ""}`);
    for (const line of wrapText(selected.fullLabel || selected.label, inner, 4)) push(line);
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
  } else {
    const total = controller.model.rawNodes.length;
    const shown = controller.visible.nodes.length;
    push(`${colored(ACCENT_CYAN, "❖")} ${style.bold("knowledge graph")}${controller.refreshing ? style.dim("  ⟳") : ""}`);
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
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}
