/**
 * Mouse support — SGR extended mode for terminal mouse events.
 * Enables click detection for agent tab switching and hyperlink clicks.
 */
/**
 * Enable mouse tracking on the terminal.
 * Uses SGR extended mode (\x1b[?1006h) for coordinates > 223.
 * Also enables normal tracking (\x1b[?1000h) for basic button events.
 */
export function enableMouse(stdout) {
    if (!stdout.isTTY)
        return;
    stdout.write("\x1b[?1000h"); // Normal tracking (button press/release)
    stdout.write("\x1b[?1006h"); // SGR extended mode
}
/** Disable mouse tracking and restore normal terminal behavior. */
export function disableMouse(stdout) {
    if (!stdout.isTTY)
        return;
    stdout.write("\x1b[?1006l");
    stdout.write("\x1b[?1000l");
}
/**
 * Try to parse an SGR mouse event from raw input.
 * SGR format: \x1b[<button;column;row(M|m)
 *   M = press, m = release
 * Returns null if the input is not a mouse event.
 */
export function parseMouseEvent(input) {
    // SGR extended: \x1b[<Cb;Cx;CyM or \x1b[<Cb;Cx;Cym
    const match = input.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!match)
        return null;
    const code = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);
    const isRelease = match[4] === "m";
    const shift = (code & 4) !== 0;
    const alt = (code & 8) !== 0;
    const ctrl = (code & 16) !== 0;
    const baseCode = code & ~(4 | 8 | 16); // strip modifier bits
    let button = "none";
    let type = isRelease ? "release" : "press";
    if (baseCode === 0)
        button = "left";
    else if (baseCode === 1)
        button = "middle";
    else if (baseCode === 2)
        button = "right";
    else if (baseCode === 64)
        button = "scrollUp";
    else if (baseCode === 65)
        button = "scrollDown";
    else if (baseCode === 32) {
        button = "left";
        type = "move";
    }
    else if (baseCode === 33) {
        button = "middle";
        type = "move";
    }
    else if (baseCode === 34) {
        button = "right";
        type = "move";
    }
    else if (baseCode === 35) {
        button = "none";
        type = "move";
    }
    return { type, button, x, y, shift, ctrl, alt };
}
