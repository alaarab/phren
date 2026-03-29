import { Box, Text } from "ink";

interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{"❯"} {text}</Text>
      <Text>{""}</Text>
    </Box>
  );
}
