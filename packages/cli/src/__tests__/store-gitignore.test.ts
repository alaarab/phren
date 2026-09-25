/**
 * A phren store is a git repo that phren pushes on its own initiative
 * (`push_changes`, the session-stop hook — both `git add -A`). Anything
 * secret-bearing that the store's .gitignore does not cover gets committed and,
 * on a synced store, pushed to a remote.
 *
 * There are two independent store templates — the shared-mode starter file and
 * the project-local inline list in init-configure.ts — and they had already
 * drifted apart. This pins both to one list.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { STORE_SECRET_GITIGNORE_LINES } from "../init/store-gitignore.js";

/** Entries a .gitignore body lacks, by whole trimmed line (a commented-out entry does not count). */
function missingSecretGitignoreLines(content: string): string[] {
  const present = new Set(content.split("\n").map((line) => line.trim()));
  return STORE_SECRET_GITIGNORE_LINES.filter((entry) => !present.has(entry));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const starterGitignore = path.resolve(here, "..", "..", "starter", ".gitignore");
const initConfigureSrc = path.resolve(here, "..", "init", "init-configure.ts");

describe("store .gitignore templates", () => {
  it("lists the credential store, session transcripts and .env", () => {
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".runtime/");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".sessions/");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".env");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".config/auth-profiles.json");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".config/modules.yaml.migration-backup");
    // The unstage guard in tools/finding.ts push_changes and cli/session-stop.ts
    // resets these paths out of the index; .gitignore has to cover the same set.
    expect(STORE_SECRET_GITIGNORE_LINES).toContain("*.pem");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain("*.key");
  });

  it("the shared-mode starter template covers every secret-bearing entry", () => {
    const content = fs.readFileSync(starterGitignore, "utf8");
    expect(missingSecretGitignoreLines(content)).toEqual([]);
  });

  it("the project-local template is built from the shared list, not a copy", () => {
    // Guards against the drift that let the project-local template ship
    // without .env: it must spread the const rather than restate the entries.
    const src = fs.readFileSync(initConfigureSrc, "utf8");
    expect(src).toContain("...STORE_SECRET_GITIGNORE_LINES");
  });

  // ── missingSecretGitignoreLines ───────────────────────────────────────────
});
