import { Box, Text } from "ink";

interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  return (
    <Box>
      <Text bold>You: </Text>
      <Text>{text}</Text>
    </Box>
  );
}
