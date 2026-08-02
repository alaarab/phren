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
import {
  STORE_SECRET_GITIGNORE_LINES,
  missingSecretGitignoreLines,
} from "../init/store-gitignore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const starterGitignore = path.resolve(here, "..", "..", "starter", ".gitignore");
const initConfigureSrc = path.resolve(here, "..", "init", "init-configure.ts");

describe("store .gitignore templates", () => {
  it("lists the credential store, session transcripts and .env", () => {
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".runtime/");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".sessions/");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".env");
    expect(STORE_SECRET_GITIGNORE_LINES).toContain(".config/auth-profiles.json");
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

  it("matches the unstage guard used by both `git add -A` paths", () => {
    // tools/finding.ts push_changes and cli/session-stop.ts both reset these
    // paths out of the index. .gitignore has to cover the same set, otherwise
    // a file the guard unstages today can still be tracked by another path.
    const guarded = [".env", "*.pem", "*.key", ".config/auth-profiles.json"];
    for (const entry of guarded) {
      expect(STORE_SECRET_GITIGNORE_LINES).toContain(entry);
    }
  });

  // ── missingSecretGitignoreLines ───────────────────────────────────────────

  it("reports every entry missing from an empty file", () => {
    expect(missingSecretGitignoreLines("")).toEqual([...STORE_SECRET_GITIGNORE_LINES]);
  });

  it("ignores commented-out entries", () => {
    const content = STORE_SECRET_GITIGNORE_LINES.map((l) => `# ${l}`).join("\n");
    expect(missingSecretGitignoreLines(content)).toEqual([...STORE_SECRET_GITIGNORE_LINES]);
  });

  it("tolerates surrounding whitespace and unrelated entries", () => {
    const content = ["node_modules", ...STORE_SECRET_GITIGNORE_LINES.map((l) => `  ${l}  `), "*.log"].join("\n");
    expect(missingSecretGitignoreLines(content)).toEqual([]);
  });

  it("reports only what is actually absent", () => {
    const content = STORE_SECRET_GITIGNORE_LINES.filter((l) => l !== ".env").join("\n");
    expect(missingSecretGitignoreLines(content)).toEqual([".env"]);
  });
});
