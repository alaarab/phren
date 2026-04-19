/**
 * Slash command handling for the Ink TUI.
 * Captures stderr output from handleCommand and returns it as display text.
 */
import { handleCommand } from "../../commands.js";
export function useSlashCommands(opts) {
    return {
        /** Try to handle input as a slash command. Returns true if handled. */
        tryHandleCommand(input) {
            if (!input.startsWith("/"))
                return false;
            // Capture stderr writes during command execution
            const captured = [];
            const origWrite = process.stderr.write;
            process.stderr.write = ((chunk) => {
                captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
                return true;
            });
            let result;
            try {
                result = handleCommand(input, opts.commandContext);
            }
            catch {
                process.stderr.write = origWrite;
                return true;
            }
            if (result instanceof Promise) {
                result.then(() => {
                    process.stderr.write = origWrite;
                    flush();
                }).catch(() => {
                    process.stderr.write = origWrite;
                });
                return true;
            }
            process.stderr.write = origWrite;
            flush();
            return true;
            function flush() {
                if (captured.length > 0) {
                    // Strip ANSI dim/reset codes for cleaner display in Ink
                    const text = captured.join("").replace(/\n$/, "");
                    if (text)
                        opts.onOutput(text);
                }
            }
        },
    };
}
