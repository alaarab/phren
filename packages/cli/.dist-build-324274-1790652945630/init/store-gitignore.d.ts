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
export declare const STORE_SECRET_GITIGNORE_LINES: readonly [".runtime/", ".sessions/", ".env", "*.pem", "*.key", ".config/auth-profiles.json", ".config/modules.yaml.migration-backup"];
