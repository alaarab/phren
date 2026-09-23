// Plain text from terminal output: pane reads, harness screens, CLI stdout.

// CSI (ESC [ parameters, intermediates, final byte), OSC (ESC ] up to BEL or
// ESC \) and carriage returns, in one pass.
const TERMINAL_CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;

/** Removes CSI sequences (colors, cursor moves, modes), OSC sequences (window
 * titles, hyperlinks) and carriage returns. Line breaks and every printable
 * character are kept, box drawing and spinners included: callers that parse a
 * harness screen drop those themselves, because there they carry meaning. */
export function stripTerminal(text: string): string {
  return text.replace(TERMINAL_CONTROL, "");
}
