import { stripTerminal } from "../terminal-text.js";
export declare const RESET = "\u001B[0m";
export declare const BOLD = "\u001B[1m";
export declare const DIM = "\u001B[2m";
export declare const GREEN = "\u001B[32m";
export declare const YELLOW = "\u001B[33m";
export declare const RED = "\u001B[31m";
export declare const CYAN = "\u001B[36m";
export declare const style: {
    bold: (s: string) => string;
    dim: (s: string) => string;
    italic: (s: string) => string;
    cyan: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    red: (s: string) => string;
    magenta: (s: string) => string;
    blue: (s: string) => string;
    white: (s: string) => string;
    gray: (s: string) => string;
    boldCyan: (s: string) => string;
    boldGreen: (s: string) => string;
    boldYellow: (s: string) => string;
    boldRed: (s: string) => string;
    boldMagenta: (s: string) => string;
    boldBlue: (s: string) => string;
    dimItalic: (s: string) => string;
    invert: (s: string) => string;
};
export declare function badge(label: string, colorFn: (s: string) => string): string;
export declare function separator(width?: number): string;
/** The shell's name for {@link stripTerminal}. */
export declare const stripAnsi: typeof stripTerminal;
/** Terminal cells occupied by `s`, ignoring any ANSI escape codes it contains. */
export declare function displayWidth(s: string): number;
export declare function padToWidth(s: string, width: number): string;
export declare function truncateLine(s: string, cols: number): string;
export declare function renderWidth(columns?: number): number;
interface WrapSegmentsOptions {
    indent?: string;
    maxLines?: number;
    separator?: string;
}
export declare function wrapSegments(segments: string[], cols: number, opts?: WrapSegmentsOptions): string;
export declare function gradient(text: string, colors?: string[]): string;
export declare function lineViewport(allLines: string[], cursorFirstLine: number, cursorLastLine: number, height: number, prevStart: number): {
    lines: string[];
    scrollStart: number;
};
export declare function shellHelpText(): string;
export declare function clearScreen(): void;
export declare function clearToEnd(): void;
/** Switch to the alternate screen buffer and put the terminal in TUI mode. */
export declare function enterFullscreen(): void;
/** Undo enterFullscreen(). Safe to call more than once. */
export declare function exitFullscreen(): void;
/**
 * Write one frame as a single synchronized write.
 *
 * The old path issued three separate writes (home, body, erase-to-end) with the
 * cursor visible, which let a concurrent repaint interleave between them and
 * dragged the caret across the screen on every keystroke.
 */
export declare function paintFrame(frame: string): void;
/**
 * Lay out one splash frame from the character art the caller supplies (a live
 * animation frame, or the static art).
 *
 * Every branch is chosen so the result fits the terminal it is about to be
 * painted into: the wide layout needs room for art + gap + logo, the stacked
 * one drops the logo rather than clipping it, and a terminal too short for the
 * character drops the character rather than pushing the tagline off the bottom.
 * A frame taller than the screen would scroll the alternate buffer, and once it
 * scrolls every later cursor-home repaint lands on shifted rows, stacking the
 * frames on top of each other.
 */
export declare function composeStartupFrame(artLines: string[], version: string, hint?: string, logo?: string[], tagline?: string): string[];
/**
 * Clamp a frame to the terminal before painting: truncate each line to the
 * render width, erase whatever the previous frame left to the right of it, and
 * drop rows past the bottom so the frame can never scroll the screen.
 */
export declare function fitFrame(lines: string[]): string;
export declare function shellStartupFrames(version: string, tagline?: string): string[];
export {};
