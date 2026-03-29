import { Box, Text } from "ink";

interface AgentMessageProps {
  text: string;
}

export function AgentMessage({ text }: AgentMessageProps) {
  return (
    <Box flexDirection="column">
      <Text color="magenta">{"◆"} <Text>{text}</Text></Text>
      <Text>{""}</Text>
    </Box>
  );
}
