/** Removes CSI sequences (colors, cursor moves, modes), OSC sequences (window
 * titles, hyperlinks) and carriage returns. Line breaks and every printable
 * character are kept, box drawing and spinners included: callers that parse a
 * harness screen drop those themselves, because there they carry meaning. */
export declare function stripTerminal(text: string): string;
