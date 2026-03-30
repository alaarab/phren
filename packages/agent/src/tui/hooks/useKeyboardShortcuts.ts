import { useInput } from "ink";

const SLASH_COMMANDS = [
  "/help", "/turns", "/clear", "/cwd", "/files", "/cost", "/plan", "/undo",
  "/context", "/model", "/provider", "/preset", "/session", "/history",
  "/compact", "/diff", "/git", "/mem", "/ask", "/spawn", "/agents",
  "/mode", "/verbose", "/theme", "/exit", "/quit",
];

export interface KeyboardShortcutOpts {
  isRunning: boolean;
  inputValue: string;
  bashMode: boolean;
  inputHistory: string[];
  historyIndex: number;
  ctrlCCount: number;
  onSetInput: (value: string) => void;
  onSetBashMode: (on: boolean) => void;
  onSetHistoryIndex: (index: number) => void;
  onSetCtrlCCount: (count: number) => void;
  onExit: () => void;
  onCyclePermissions: () => void;
  onCancelTurn: () => void;
}

export function useKeyboardShortcuts(opts: KeyboardShortcutOpts) {
  useInput((input, key) => {
    // Reset Ctrl+C count on any non-Ctrl+C keypress
    if (!(input === "c" && key.ctrl)) {
      if (opts.ctrlCCount > 0) opts.onSetCtrlCCount(0);
    }

    // Ctrl+D -- exit cleanly
    if (key.ctrl && input === "d") {
      opts.onExit();
      return;
    }

    // Ctrl+L -- clear screen
    if (key.ctrl && input === "l") {
      process.stdout.write("\x1b[2J\x1b[H");
      return;
    }

    // Shift+Tab -- cycle permission mode
    if (key.shift && key.tab) {
      opts.onCyclePermissions();
      return;
    }

    // Ctrl+C -- progressive: cancel turn / clear input / warn / quit
    if (key.ctrl && input === "c") {
      if (opts.isRunning) {
        opts.onCancelTurn();
        return;
      }
      if (opts.inputValue) {
        opts.onSetInput("");
        opts.onSetCtrlCCount(0);
        return;
      }
      if (opts.ctrlCCount >= 1) {
        opts.onExit();
        return;
      }
      opts.onSetCtrlCCount(opts.ctrlCCount + 1);
      return;
    }

    // Escape -- exit bash mode or clear input
    if (key.escape) {
      if (opts.bashMode) {
        opts.onSetBashMode(false);
        opts.onSetInput("");
      } else if (opts.inputValue) {
        opts.onSetInput("");
      }
      return;
    }

    // Up arrow -- recall older history
    if (key.upArrow && !opts.isRunning) {
      const history = opts.inputHistory;
      if (history.length === 0) return;
      const newIndex = Math.min(opts.historyIndex + 1, history.length - 1);
      opts.onSetHistoryIndex(newIndex);
      opts.onSetInput(history[history.length - 1 - newIndex]);
      return;
    }

    // Down arrow -- recall newer history
    if (key.downArrow && !opts.isRunning) {
      const history = opts.inputHistory;
      if (opts.historyIndex <= 0) {
        opts.onSetHistoryIndex(-1);
        opts.onSetInput("");
        return;
      }
      const newIndex = opts.historyIndex - 1;
      opts.onSetHistoryIndex(newIndex);
      opts.onSetInput(history[history.length - 1 - newIndex]);
      return;
    }

    // Tab -- slash command completion when input starts with /
    if (key.tab && !key.shift && !opts.isRunning) {
      const val = opts.inputValue;
      if (val.startsWith("/") && val.length > 1) {
        const matches = SLASH_COMMANDS.filter(c => c.startsWith(val));
        if (matches.length === 1) {
          opts.onSetInput(matches[0]);
        }
      }
      return;
    }
  });
}
