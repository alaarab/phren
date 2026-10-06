export declare function resolveProjectStorePath(phrenPath: string, project: string): string;
export declare function parseMcpToggle(raw: string | undefined): boolean | undefined;
/**
 * One-shot CLI wrapper around the shared launcher: exits non-zero when the
 * editor will not start, which is right for a command and wrong inside the
 * shell — hence the split.
 */
export declare function openInEditor(filePath: string): void;
