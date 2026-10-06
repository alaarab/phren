export interface ManifestHooks {
    SessionStart?: string;
    UserPromptSubmit?: string;
    Stop?: string;
}
export interface SkillFrontmatter {
    name: string;
    description: string;
    version?: string;
    license?: string;
    dependencies?: string[];
    hooks?: Record<string, unknown>;
    command?: string;
    aliases?: string[];
}
export interface SkillValidationResult {
    valid: boolean;
    errors: string[];
    frontmatter?: SkillFrontmatter;
}
export declare function parseSkillFrontmatter(rawContent: string): {
    frontmatter: Record<string, unknown> | null;
    body: string;
};
export declare function validateSkillFrontmatter(content: string, filePath?: string): SkillValidationResult;
export declare function validateSkillsDir(skillsDir: string): SkillValidationResult[];
export declare function readSkillManifestHooks(phrenPath: string): ManifestHooks | null;
export interface SkillCollision {
    skillName: string;
    destPath: string;
    message: string;
}
/**
 * Returns true if `destPath` is a symlink whose resolved target lives under
 * `managedRoot`.  Used to decide whether phren owns a symlink.
 */
export declare function isManagedSymlink(destPath: string, managedRoot: string): boolean;
/**
 * Scan destDir for files that phren would want to link (based on srcDir) but
 * can't because a user-owned file already occupies the destination slot.
 */
export declare function detectSkillCollisions(srcDir: string, destDir: string, managedRoot: string): SkillCollision[];
export declare function linkSkillsDir(srcDir: string, destDir: string, managedRoot: string, symlinkFile: (src: string, dest: string, managedRoot: string) => boolean, opts?: {
    phrenPath?: string;
    scope?: string;
}): SkillCollision[];
export declare function writeSkillMd(phrenPath: string): void;
