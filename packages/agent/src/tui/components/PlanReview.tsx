import { Box, Text } from "ink";
import { renderMarkdown } from "../../multi/markdown.js";
import type { Theme } from "../themes.js";

export function PlanReview({ text, theme }: { text: string; theme?: Theme }) {
  const accent = theme?.statusBar.accent ?? "magenta";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginTop={1}>
      <Text bold color={accent}>Plan ready for review</Text>
      <Text wrap="wrap">{text ? renderMarkdown(text, theme?.markdown) : "(empty plan)"}</Text>
      <Text dimColor>[y]es approve  [n]o abort  or type feedback to revise</Text>
    </Box>
  );
}
