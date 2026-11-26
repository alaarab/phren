import * as fs from "fs";
import * as path from "path";

/**
 * The gitignore entries every phren store must have, whichever install mode
 * created it.
 *
 * A store is a git repo that phren itself pushes: `push_changes` and the
 * session-stop hook both run `git add -A` against it, and a synced store has a
 * remote. Anything secret-bearing that is not ignored therefore ends up in a
 * commit — this is exactly how `.config/auth-profiles.json` leaked before
 * credentials moved to `.runtime/`.
 *
 * Both `git add -A` paths already carry an unstage guard for the same set
 * (`tools/finding.ts` push_changes, `cli/session-stop.ts`). That guard is the
 * second line of defence, and only the second: it can unstage a change, but it
 * cannot un-commit a file that some other path — a user's own `git add .`, an
 * editor's git integration — already tracked. .gitignore is the line that
 * stops the file from ever becoming tracked, so the two lists must agree.
 *
 * Kept as a shared const because there were two templates that had already
 * drifted: `packages/cli/starter/.gitignore` (shared mode) and the inline list
 * in `init-configure.ts` (project-local mode). Neither covered `.env`, which
 * `phren init` writes into the store itself and which the docs tell users to
 * put `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `PHREN_LLM_KEY` in.
 */
export const STORE_SECRET_GITIGNORE_LINES = [
  // Credential store (API keys, OpenAI Codex OAuth access + refresh tokens),
  // debug/hook-error logs, and cached memory content.
  ".runtime/",
  // Session transcripts and per-session message artifacts.
  ".sessions/",
  // Feature flags *and* API keys — see docs/environment.md. Written by
  // `phren init` (ensureDefaultFeatureFlags), so it always exists.
  ".env",
  // Key material a user may have dropped in the store directory.
  "*.pem",
  "*.key",
  // Legacy credential location, pre-`.runtime/` migration. Stays forever so a
  // store created before the move, or one where the migration has not run yet,
  // never has its credentials committed.
  ".config/auth-profiles.json",
  // Legacy module migration backups were once written into the working tree.
  ".config/modules.yaml.migration-backup",
] as const;

/** Editor and OS noise every store ignores too. `.obsidian/` is Obsidian's per-computer workspace
 * state, written when the store is opened as a vault; syncing it churns every computer's history. */
const STORE_NOISE_LINES = [".DS_Store", "*.swp", ".cache/", ".obsidian/"] as const;

/**
 * Writes the store's .gitignore from code, or appends whatever secret-bearing
 * line it lacks, and returns the lines it added. The starter template's own
 * .gitignore cannot be relied on: npm leaves `.gitignore` files out of a
 * published package, so a store created with `npx @phren/cli init` had none,
 * and `.env` (API keys) and `.runtime/` (credentials) went unignored.
 */
export function ensureStoreGitignore(storePath: string): string[] {
  const file = path.join(storePath, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = [...STORE_NOISE_LINES, ...STORE_SECRET_GITIGNORE_LINES].filter(line => !present.has(line));
  if (!missing.length) return [];
  const header = current ? "" : "# phren store: never sync secrets, credentials, transcripts or caches\n";
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${current}${separator}${header}${missing.join("\n")}\n`);
  return missing;
}
