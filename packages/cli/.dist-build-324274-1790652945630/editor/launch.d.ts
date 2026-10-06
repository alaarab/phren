/**
 * Hand a file to the user's own editor.
 *
 * `$EDITOR` is a command line, not a binary path. Plenty of people set it to
 * something carrying arguments — `code --wait`, `nvim -u NONE`, and on this
 * machine `omarchy-launch-editor --inline` — so passing it straight to
 * `execFileSync` looks for a binary with spaces in its name and fails with
 * ENOENT. Git treats `core.editor` as a command line for the same reason, and
 * so do we: split it, append the path, run the first word.
 *
 * Splitting rather than `shell: true` keeps a file path from ever being
 * interpreted by a shell.
 */
export interface EditorCommand {
    command: string;
    args: string[];
}
/**
 * Split a command line into a command and its arguments, honouring single and
 * double quotes so a quoted path with spaces survives. Backslash escapes are
 * deliberately not handled: `$EDITOR` values that need them are vanishingly
 * rare, and guessing wrong is worse than not trying.
 */
export declare function splitCommandLine(raw: string): string[];
/** The editor to use, from `$EDITOR`, then `$VISUAL`, then a sensible default. */
export declare function resolveEditorCommand(env?: NodeJS.ProcessEnv): EditorCommand | null;
export interface EditorResult {
    ok: boolean;
    /** The command that ran, for messages. */
    command: string;
    error?: string;
}
/**
 * Run the editor on `filePath` and wait for it to exit. The child inherits the
 * terminal, so the caller must have released it first.
 *
 * Returns a result rather than throwing or exiting: inside the shell an editor
 * that will not start is a message on the status line, not the end of the
 * session.
 */
export declare function openInEditor(filePath: string, env?: NodeJS.ProcessEnv): EditorResult;
