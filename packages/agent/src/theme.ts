/**
 * Phren Agent theme system — warm, muted color palette with consistent styling.
 *
 * Inspired by Claude Code's pleasant visual design but with phren's own identity.
 * Uses 256-color ANSI for richer gradients on supported terminals, with fallback.
 */

const ESC = "\x1b[";

// ── 256-color helpers ──────────────────────────────────────────────────────

function fg256(code: number, text: string): string {
  return `${ESC}38;5;${code}m${text}${ESC}0m`;
}

function bg256(code: number, text: string): string {
  return `${ESC}48;5;${code}m${text}${ESC}0m`;
}

function fgBg256(fg: number, bg: number, text: string): string {
  return `${ESC}38;5;${fg};48;5;${bg}m${text}${ESC}0m`;
}

// ── Phren color palette ────────────────────────────────────────────────────
// Warm, muted tones: dusty rose, soft teal, warm amber, sage green

export const palette = {
  // Primary brand
  brand:      176,  // soft magenta/dusty rose
  brandDim:   133,  // muted magenta

  // Accents
  teal:       73,   // soft teal for info
  tealDim:    66,   // muted teal
  amber:      179,  // warm amber for warnings
  amberDim:   136,  // muted amber
  sage:       108,  // sage green for success
  sageDim:    65,   // muted sage
  coral:      174,  // soft coral for errors
  coralDim:   131,  // muted coral
  sky:        110,  // soft blue for read operations
  skyDim:     67,   // muted blue
  lavender:   183,  // soft lavender for accents
  lavenderDim: 139, // muted lavender

  // Neutrals
  text:       252,  // primary text
  textDim:    245,  // secondary text
  textMuted:  240,  // tertiary text
  surface:    236,  // surface background
  surfaceDim: 234,  // darker surface
  border:     238,  // borders and separators

  // Semantic
  success:    108,  // sage
  warning:    179,  // amber
  error:      174,  // coral
  info:       73,   // teal
};

// ── Themed style functions ─────────────────────────────────────────────────

export const t = {
  // Brand
  brand: (text: string) => fg256(palette.brand, text),
  brandBold: (text: string) => `${ESC}1m${fg256(palette.brand, text)}`,
  brandDim: (text: string) => fg256(palette.brandDim, text),

  // Semantic
  success: (text: string) => fg256(palette.success, text),
  warning: (text: string) => fg256(palette.warning, text),
  error: (text: string) => fg256(palette.error, text),
  info: (text: string) => fg256(palette.info, text),

  // Text hierarchy
  text: (text: string) => fg256(palette.text, text),
  dim: (text: string) => fg256(palette.textDim, text),
  muted: (text: string) => fg256(palette.textMuted, text),
  bold: (text: string) => `${ESC}1m${text}${ESC}0m`,
  italic: (text: string) => `${ESC}3m${text}${ESC}0m`,

  // Tool-specific colors
  tool: (text: string) => fg256(palette.teal, text),
  toolDim: (text: string) => fg256(palette.tealDim, text),
  file: (text: string) => fg256(palette.lavender, text),
  command: (text: string) => fg256(palette.amber, text),
  search: (text: string) => fg256(palette.sky, text),

  // Status bar
  statusBar: (text: string) => fgBg256(palette.text, palette.surface, text),
  statusBrand: (text: string) => fgBg256(palette.brand, palette.surface, text),
  statusAccent: (text: string) => fgBg256(palette.teal, palette.surface, text),
  statusWarn: (text: string) => fgBg256(palette.amber, palette.surface, text),

  // Borders
  border: (text: string) => fg256(palette.border, text),
  separator: (width: number) => fg256(palette.border, "─".repeat(width)),

  // Permission modes
  permSuggest: (text: string) => fg256(palette.sky, text),
  permAuto: (text: string) => fg256(palette.sage, text),
  permFull: (text: string) => fg256(palette.amber, text),

  // Diff colors
  diffAdd: (text: string) => fg256(palette.sage, text),
  diffRemove: (text: string) => fg256(palette.coral, text),
  diffContext: (text: string) => fg256(palette.textMuted, text),
  diffHeader: (text: string) => fg256(palette.teal, text),

  // Effort levels
  effortLow: (text: string) => fg256(palette.sage, text),
  effortMedium: (text: string) => fg256(palette.teal, text),
  effortHigh: (text: string) => fg256(palette.amber, text),
  effortMax: (text: string) => fg256(palette.coral, text),

  // Cost
  cost: (text: string) => fg256(palette.textDim, text),
  costHigh: (text: string) => fg256(palette.amber, text),

  // Cache
  cached: (text: string) => fg256(palette.sage, text),

  // Raw
  fg256,
  bg256,
  fgBg256,
};

// ── Effort display helpers ─────────────────────────────────────────────────

const EFFORT_ICONS: Record<string, string> = {
  low: "◇",
  medium: "◈",
  high: "◆",
  max: "◆◆",
};

const EFFORT_COLORS: Record<string, (t: string) => string> = {
  low: t.effortLow,
  medium: t.effortMedium,
  high: t.effortHigh,
  max: t.effortMax,
};

export function formatEffort(level: string): string {
  const icon = EFFORT_ICONS[level] ?? "◆";
  const color = EFFORT_COLORS[level] ?? t.info;
  return color(`${icon} ${level}`);
}

// ── Context usage bar ──────────────────────────────────────────────────────

export function formatContextBar(usedTokens: number, limitTokens: number, width: number = 12): string {
  const pct = Math.min(usedTokens / limitTokens, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  // Color based on usage
  const pctStr = `${(pct * 100).toFixed(0)}%`;
  if (pct > 0.85) return t.error(`${bar} ${pctStr}`);
  if (pct > 0.65) return t.warning(`${bar} ${pctStr}`);
  return t.dim(`${bar} ${pctStr}`);
}

// ── Cost formatting ────────────────────────────────────────────────────────

export function formatInlineCost(cost: number): string {
  const str = cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
  return cost > 1.0 ? t.costHigh(str) : t.cost(str);
}

// ── Cache hit indicator ────────────────────────────────────────────────────

export function formatCacheHit(cacheRead: number, cacheCreation: number): string {
  if (cacheRead === 0 && cacheCreation === 0) return "";
  if (cacheRead > 0) return t.cached(` ↻${cacheRead}`);
  if (cacheCreation > 0) return t.dim(` ↻+${cacheCreation}`);
  return "";
}

// ── Tool call themed rendering ─────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  read_file: "📖",
  write_file: "✏️",
  edit_file: "✏️",
  shell: "⚡",
  glob: "🔍",
  grep: "🔍",
  git_status: "📊",
  git_diff: "📊",
  git_commit: "📝",
  phren_search: "🧠",
  phren_add_finding: "💡",
  phren_get_tasks: "📋",
  phren_complete_task: "✅",
  phren_add_task: "📌",
  web_fetch: "🌐",
  web_search: "🌐",
  lsp: "🔗",
  subagent: "🤖",
};

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "⚙️";
}

export function formatToolName(name: string): string {
  // Color tools by category
  if (name.startsWith("phren_")) return t.brand(name);
  if (name === "shell") return t.command(name);
  if (name === "read_file" || name === "glob" || name === "grep") return t.search(name);
  if (name === "edit_file" || name === "write_file") return t.file(name);
  if (name.startsWith("git_")) return t.info(name);
  if (name.startsWith("web_")) return t.info(name);
  if (name === "subagent") return t.warning(name);
  return t.tool(name);
}

// ── Permission prompt theming ──────────────────────────────────────────────

export function formatPermissionHeader(risk: "read" | "write" | "dangerous", toolName: string): string {
  const colors = {
    read: { bg: palette.skyDim, fg: palette.text, label: "READ" },
    write: { bg: palette.amberDim, fg: palette.text, label: "WRITE" },
    dangerous: { bg: palette.coralDim, fg: palette.text, label: "SHELL" },
  };
  const c = colors[risk];
  const badge = fgBg256(c.fg, c.bg, ` ${c.label} `);
  return `\n${badge} ${t.bold(toolName)}`;
}

export function formatPermissionBorder(): string {
  return t.border("┈".repeat(Math.min(60, process.stdout.columns || 60)));
}

export function formatPermissionHint(): string {
  return t.muted("  [y]es  [n]o  [a]llow-tool  [s]ession-allow  ");
}

// ── Diff preview rendering ─────────────────────────────────────────────────

export function renderCompactDiff(oldText: string, newText: string, filePath: string, maxLines: number = 8): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const lines: string[] = [
    t.diffHeader(`  ┌─ ${filePath}`),
  ];

  // Simple line-by-line diff (no full diff algorithm — keep it fast)
  let shown = 0;
  const maxOldIdx = Math.min(oldLines.length, 50); // cap scan
  const maxNewIdx = Math.min(newLines.length, 50);

  for (let i = 0; i < Math.max(maxOldIdx, maxNewIdx) && shown < maxLines; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) continue; // identical, skip

    if (oldLine !== undefined && (newLine === undefined || oldLine !== newLine)) {
      lines.push(t.diffRemove(`  │ - ${oldLine.slice(0, 80)}`));
      shown++;
    }
    if (newLine !== undefined && (oldLine === undefined || oldLine !== newLine)) {
      lines.push(t.diffAdd(`  │ + ${newLine.slice(0, 80)}`));
      shown++;
    }
  }

  const totalChanges = Math.abs(newLines.length - oldLines.length) +
    oldLines.filter((l, i) => i < newLines.length && l !== newLines[i]).length;
  if (totalChanges > maxLines) {
    lines.push(t.muted(`  │ ... ${totalChanges - shown} more changes`));
  }

  lines.push(t.diffHeader("  └─"));

  return lines.join("\n");
}

// ── Slash command autocomplete ─────────────────────────────────────────────

const SLASH_COMMANDS = [
  "/help", "/model", "/provider", "/turns", "/clear", "/cost",
  "/plan", "/undo", "/history", "/compact", "/mode", "/spawn",
  "/agents", "/preset", "/exit", "/permissions", "/effort",
];

/**
 * Autocomplete a partial slash command.
 * Returns matching commands, or empty array if no match.
 */
export function autocompleteSlashCommand(partial: string): string[] {
  if (!partial.startsWith("/")) return [];
  const lower = partial.toLowerCase();
  return SLASH_COMMANDS.filter(cmd => cmd.startsWith(lower));
}
