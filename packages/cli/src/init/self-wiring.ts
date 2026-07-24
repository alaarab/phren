/**
 * Self-wiring snippet printer for the assisted/manual presets.
 *
 * Under presets where phren does not symlink into ~/.claude, users who still
 * want the global instructions and slash-commands wire them up themselves. This
 * prints a copy-pasteable block pointing at the store's canonical files so they
 * are never left guessing where phren keeps things.
 */
import * as path from "path";
import { log } from "./shared.js";
import { getManagementPreset, type ManagementPreset } from "./management-preset.js";

/** Build the self-wiring instructions as lines (testable without stdout). */
export function buildSelfWiringSnippet(phrenPath: string, preset: ManagementPreset): string[] {
  const globalClaude = path.join(phrenPath, "global", "CLAUDE.md");
  const globalSkills = path.join(phrenPath, "global", "skills");
  const lines: string[] = [];
  lines.push("");
  lines.push("─────────────────────────────────────────────────────────────");
  lines.push(`Self-wiring (${preset} preset — phren does not touch ~/.claude)`);
  lines.push("─────────────────────────────────────────────────────────────");

  if (preset === "manual") {
    lines.push("phren runs as an MCP server only. Your agent reaches phren through");
    lines.push("its MCP tools — no global instructions or hooks are installed.");
    lines.push("");
    lines.push("Optional — surface the global guidance to your agent yourself, e.g.");
    lines.push("add a line to your own ~/.claude/CLAUDE.md:");
    lines.push(`    @${globalClaude}`);
    return lines;
  }

  // assisted
  lines.push("Hooks + MCP are active, but phren never writes outside its store.");
  lines.push("To load the global instructions in every session, reference them");
  lines.push("from your own ~/.claude/CLAUDE.md (phren won't overwrite your file):");
  lines.push(`    @${globalClaude}`);
  lines.push("");
  lines.push("  …or symlink it yourself if you prefer:");
  lines.push(`    ln -s ${globalClaude} ~/.claude/CLAUDE.md`);
  lines.push("");
  lines.push("Phren slash-commands live in:");
  lines.push(`    ${globalSkills}`);
  lines.push("  Copy or symlink the ones you want into ~/.claude/skills/, e.g.:");
  lines.push(`    ln -s ${path.join(globalSkills, "phren-sync")} ~/.claude/skills/phren-sync`);
  lines.push("");
  lines.push("Re-print this anytime with:  phren snippet");
  return lines;
}

/** Print the self-wiring snippet for the given (or current) preset. */
export function printSelfWiringSnippet(phrenPath: string, preset?: ManagementPreset): void {
  const resolved = preset ?? getManagementPreset(phrenPath);
  for (const line of buildSelfWiringSnippet(phrenPath, resolved)) log(line);
}
