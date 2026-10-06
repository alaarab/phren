/**
 * Write an edited file back into the store.
 *
 * The store is git-backed and other tools read it, so a save is not a bare
 * writeFileSync: it refuses to clobber a symlink, checks that a skill is still
 * loadable before replacing a working one, and lands atomically.
 */
export type EditKind = "skill" | "claude";
export interface SaveResult {
    ok: boolean;
    error?: string;
    /** True when a skill's frontmatter changed, so the manifests need rebuilding. */
    frontmatterChanged?: boolean;
}
export declare function saveEditedFile(filePath: string, content: string, kind: EditKind): SaveResult;
