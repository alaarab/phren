/**
 * Terminal control — manages scroll regions and fixed status bar.
 * Uses DECSTBM (Set Top and Bottom Margins) to create a scrollable area
 * that excludes the bottom N lines, keeping the status bar pinned.
 */

export class TerminalControl {
  private statusHeight = 1;
  private enabled = false;
  private resizeHandler: (() => void) | null = null;

  /** Enable scroll regions. Call after Ink render() is set up. */
  enable(stdout: NodeJS.WriteStream): void {
    if (!stdout.isTTY || this.enabled) return;
    this.enabled = true;
    this.setScrollRegion(stdout);
    this.resizeHandler = () => {
      this.setScrollRegion(stdout);
      this.renderStatusBar(stdout, this.lastContent);
    };
    stdout.on("resize", this.resizeHandler);
  }

  /** Disable scroll regions and restore full terminal. */
  disable(stdout: NodeJS.WriteStream): void {
    if (!this.enabled) return;
    this.enabled = false;
    // Reset scroll region to full screen
    stdout.write("\x1b[r");
    // Clear status bar line
    const rows = stdout.rows || 24;
    stdout.write(`\x1b[${rows};1H\x1b[2K`);
    if (this.resizeHandler) {
      stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  private lastContent = "";

  private setScrollRegion(stdout: NodeJS.WriteStream): void {
    const rows = stdout.rows || 24;
    // Set scrollable region to exclude bottom statusHeight lines
    stdout.write(`\x1b[1;${rows - this.statusHeight}r`);
    // Move cursor back to the scroll region (don't leave it in the status area)
    stdout.write(`\x1b[${rows - this.statusHeight};1H`);
  }

  /** Render content in the fixed status bar area. */
  renderStatusBar(stdout: NodeJS.WriteStream, content: string): void {
    if (!this.enabled) return;
    this.lastContent = content;
    const rows = stdout.rows || 24;
    const cols = stdout.columns || 80;
    // Save cursor, move to status line, clear it, write content, restore cursor
    stdout.write("\x1b[s");                              // save cursor
    stdout.write(`\x1b[${rows};1H`);                    // move to last row
    stdout.write("\x1b[2K");                             // clear line
    stdout.write(content.slice(0, cols));                // write (truncate to width)
    stdout.write("\x1b[u");                              // restore cursor
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}
