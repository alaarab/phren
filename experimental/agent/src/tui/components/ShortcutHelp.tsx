import { Box, Text } from "ink";
import type { Theme } from "../themes.js";

export function ShortcutHelp({ theme }: { theme: Theme }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.separator} paddingX={1}>
      <Text bold>Keyboard shortcuts</Text>
      <Text>Enter send · Shift+Enter newline · Tab complete</Text>
      <Text>Shift+Tab permissions · Esc interrupt / clear draft</Text>
      <Text>Ctrl+R history · Ctrl+F find · Ctrl+O tool details</Text>
      <Text>Ctrl+T plan · Ctrl+G editor · Ctrl+S stash / restore draft</Text>
      <Text>↑↓ history · Shift+↓ next agent · ↓ on empty draft: agent tabs</Text>
      <Text>Ctrl+L clear screen · Ctrl+D quit · Ctrl+C cancel / clear / quit</Text>
      <Text dimColor>Esc, ? or F1 close · F1 opens help with a draft</Text>
    </Box>
  );
}
