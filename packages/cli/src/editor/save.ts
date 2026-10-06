/**
 * Write an edited file back into the store.
 *
 * The store is git-backed and other tools read it, so a save is not a bare
 * writeFileSync: it refuses to clobber a symlink, checks that a skill is still
 * loadable before replacing a working one, and lands atomically.
 */

import * as fs from "fs";
import { atomicWriteText } from "../phren-paths.js";
import { validateSkillFrontmatter, parseSkillFrontmatter } from "../link/skills.js";
import { errorMessage } from "../utils.js";

export type EditKind = "skill" | "claude";

export interface SaveResult {
  ok: boolean;
  error?: string;
  /** True when a skill's frontmatter changed, so the manifests need rebuilding. */
  frontmatterChanged?: boolean;
}

/**
 * The registry never lists a symlink as a skill — it skips them — so a link
 * here means we are pointed at one of the mirrors in ~/.claude/skills or
 * ~/.copilot/skills. Writing atomically through one would replace the link
 * with a regular file and silently detach the mirror from the store, so refuse
 * rather than quietly break it. Matches the guard the write_skill MCP tool has.
 */
function symlinkRefusal(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      return "Refusing to write through a symlinked path — edit the file in the store instead.";
    }
  } catch {
    // An unreadable path fails later, with a better message, at write time.
  }
  return null;
}

/** Compare the fields the skill manifests bake in, so a re-sync only runs when needed. */
function frontmatterDiffers(before: string, after: string): boolean {
  const key = (raw: string): string => {
    const { frontmatter } = parseSkillFrontmatter(raw);
    if (!frontmatter) return "";
    const fm = frontmatter as Record<string, unknown>;
    return JSON.stringify([fm.name, fm.description, fm.command, fm.aliases]);
  };
  return key(before) !== key(after);
}

export function saveEditedFile(filePath: string, content: string, kind: EditKind): SaveResult {
  const refusal = symlinkRefusal(filePath);
  if (refusal) return { ok: false, error: refusal };

  let previous = "";
  try {
    previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  } catch {
    previous = "";
  }

  if (kind === "skill") {
    // A skill with broken frontmatter loads as nameless and description-less,
    // so it is better to refuse than to leave one behind.
    const check = validateSkillFrontmatter(content, filePath);
    if (!check.valid) {
      return { ok: false, error: check.errors[0] ?? "invalid skill frontmatter" };
    }
  }

  try {
    atomicWriteText(filePath, content);
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }

  return {
    ok: true,
    frontmatterChanged: kind === "skill" && frontmatterDiffers(previous, content),
  };
}
