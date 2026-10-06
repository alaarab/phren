export declare function generatedRootMemoryPath(): string;
/** Remove only complete managed blocks; surrounding notes and unmarked files survive. */
export declare function removeGeneratedHomeFiles(): string[];
/** Remove the phren-owned ~/.claude/CLAUDE.md and copilot-instructions.md symlinks. */
export declare function removePhrenHomeSymlinks(): string[];
/** Remove ~/.local/bin/{copilot,cursor,codex,phren} wrappers that carry the phren marker. */
export declare function removePhrenWrappers(): string[];
/** Remove skill symlinks in agent skill dirs that resolve into the phren store, plus manifests. */
export declare function sweepAgentSkillSymlinks(phrenPath: string): void;
/** Remove the given exclude entries (and the phren-managed marker) from a repo's .git/info/exclude. */
export declare function removeGitExcludes(projectDir: string, entries: string[]): void;
/**
 * Remove per-project repo mirror symlinks (AGENTS.md, REFERENCE.md, findings,
 * AGENTS.md, CLAUDE-*.md, .github/copilot-instructions.md, .claude/skills/*) that
 * phren created in phren-managed repos, and strip the matching exclude lines.
 * Only removes symlinks that resolve back into the phren store.
 */
export declare function sweepProjectMirrors(phrenPath: string): void;
