/**
 * Slash command handling for the Ink TUI.
 * Captures stderr output from handleCommand and returns it as display text.
 */
import { handleCommand, type CommandContext } from "../../commands.js";

export interface SlashCommandOpts {
  commandContext: CommandContext;
  onOutput: (text: string) => void;
}

export function useSlashCommands(opts: SlashCommandOpts) {
  return {
    /** Try to handle input as a slash command. Returns true if handled. */
    tryHandleCommand(input: string): boolean {
      if (!input.startsWith("/")) return false;

      // Capture stderr writes during command execution
      const captured: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as typeof process.stderr.write;

      let result: boolean | Promise<boolean>;
      try {
        result = handleCommand(input, opts.commandContext);
      } catch {
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
          if (text) opts.onOutput(text);
        }
      }
    },
  };
}
