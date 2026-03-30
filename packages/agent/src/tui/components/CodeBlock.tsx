import { Box, Text } from 'ink';
import React from 'react';
import { highlightCode } from '../../multi/syntax-highlight.js';

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const lang = language || 'generic';
  const highlighted = highlightCode(code, lang);
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text dimColor>{'```' + lang}</Text>
      <Text>{highlighted}</Text>
      <Text dimColor>{'```'}</Text>
    </Box>
  );
}
