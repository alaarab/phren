import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "../themes.js";

export interface SteerQueueProps {
  items: string[];
  theme?: Theme;
}

export function SteerQueue({ items, theme }: SteerQueueProps) {
  if (items.length === 0) return null;

  const color = theme?.steer.color ?? "yellow";
  const icon = theme?.steer.icon ?? "↳";

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={i} color={color}>{"  "}{icon} steer: {item.slice(0, 60)}</Text>
      ))}
    </Box>
  );
}
