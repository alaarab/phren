import { Box, Text } from "ink";
import type { Theme } from "../themes.js";

export interface ApprovalInfo {
  toolName: string;
  risk: "read" | "write" | "dangerous";
  reason: string;
  summary: string;
  detail?: string;
  diff?: string;
  queueDepth: number;
}

const RISK_LABEL: Record<ApprovalInfo["risk"], string> = { read: "READ", write: "WRITE", dangerous: "SHELL" };
const RISK_COLOR: Record<ApprovalInfo["risk"], string> = { read: "green", write: "yellow", dangerous: "red" };

export function ApprovalPanel({ info, theme }: { info: ApprovalInfo; theme?: Theme }) {
  const color = RISK_COLOR[info.risk];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
      <Box>
        <Text bold color={color}>{RISK_LABEL[info.risk]} </Text>
        <Text bold>{info.toolName}</Text>
        {info.queueDepth > 0 ? <Text dimColor>{"  (+"}{info.queueDepth}{" waiting)"}</Text> : null}
      </Box>
      <Text dimColor>{info.reason}</Text>
      <Text color={theme?.tool.preview ?? theme?.separator ?? "cyan"}>{info.summary}</Text>
      {info.detail ? <Text dimColor>{info.detail}</Text> : null}
      {info.diff ? <Text>{info.diff}</Text> : null}
      <Text dimColor>[y]es  [n]o  [a]llow-tool  [s]ession  or type feedback to deny & redirect</Text>
    </Box>
  );
}
