import React from "react";
import { Box, Text } from "ink";

export interface SteerQueueProps {
  items: string[];
}

export function SteerQueue({ items }: SteerQueueProps) {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={i} color="yellow">{"  "}↳ steer: {item.slice(0, 60)}</Text>
      ))}
    </Box>
  );
}
