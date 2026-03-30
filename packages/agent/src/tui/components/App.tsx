import React, { useState, useCallback } from "react";
import { Static, Box, Text, useApp } from "ink";
import { Banner } from "./Banner.js";
import { ToolCall, type ToolCallProps } from "./ToolCall.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { SteerQueue } from "./SteerQueue.js";
import { InputArea, PermissionsLine } from "./InputArea.js";
import type { PermissionMode } from "../../permissions/types.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";

// ── Message types for Static history ─────────────────────────────────────────

export interface BannerMsg {
  id: string;
  kind: "banner";
}

export interface UserMsg {
  id: string;
  kind: "user";
  text: string;
}

export interface AssistantMsg {
  id: string;
  kind: "assistant";
  text: string;
  toolCalls?: ToolCallProps[];
}

export interface StatusMsg {
  id: string;
  kind: "status";
  text: string;
}

export type CompletedMessage = UserMsg | AssistantMsg | StatusMsg;
type StaticItem = BannerMsg | CompletedMessage;

// ── App state and props ──────────────────────────────────────────────────────

export interface AppState {
  provider: string;
  project: string | null;
  turns: number;
  cost: string;
  permMode: PermissionMode;
  agentCount: number;
  version: string;
}

export interface AppProps {
  state: AppState;
  completedMessages: CompletedMessage[];
  streamingText: string;
  completedToolCalls: ToolCallProps[];
  thinking: boolean;
  thinkStartTime: number;
  thinkElapsed: string | null;
  steerQueue: string[];
  running: boolean;
  showBanner: boolean;
  inputHistory: string[];
  verbose: boolean;
  onSubmit: (input: string) => void;
  onPermissionCycle: () => void;
  onCancelTurn: () => void;
  onExit: () => void;
}

export function App({
  state,
  completedMessages,
  streamingText,
  completedToolCalls,
  thinking,
  thinkStartTime,
  thinkElapsed,
  steerQueue,
  running,
  showBanner,
  inputHistory,
  verbose,
  onSubmit,
  onPermissionCycle,
  onCancelTurn,
  onExit,
}: AppProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");
  const [bashMode, setBashMode] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [ctrlCCount, setCtrlCCount] = useState(0);

  const handleSubmit = useCallback((value: string) => {
    setInputValue("");
    setHistoryIndex(-1);
    if (value === "") return;

    // ! at start of empty input toggles bash mode
    if (value === "!" && !bashMode) {
      setBashMode(true);
      return;
    }

    onSubmit(bashMode ? `!${value}` : value);
    setBashMode(false);
  }, [bashMode, onSubmit]);

  useKeyboardShortcuts({
    isRunning: running,
    inputValue,
    bashMode,
    inputHistory,
    historyIndex,
    ctrlCCount,
    onSetInput: setInputValue,
    onSetBashMode: setBashMode,
    onSetHistoryIndex: setHistoryIndex,
    onSetCtrlCCount: setCtrlCCount,
    onExit: () => { onExit(); exit(); },
    onCyclePermissions: onPermissionCycle,
    onCancelTurn,
  });

  // Build Static items — banner first, then completed messages
  const staticItems: StaticItem[] = [];
  if (showBanner) {
    staticItems.push({ id: "banner", kind: "banner" });
  }
  for (const msg of completedMessages) {
    staticItems.push(msg);
  }

  return (
    <>
      {/* Completed messages — rendered once, scroll up in terminal */}
      <Static items={staticItems}>
        {(item) => {
          if (item.kind === "banner") {
            return (
              <Box key="banner" flexDirection="column">
                <Banner version={state.version} />
              </Box>
            );
          }
          if (item.kind === "user") {
            return (
              <Box key={item.id} flexDirection="column">
                <Text bold>{"\u276f"} {(item as UserMsg).text}</Text>
              </Box>
            );
          }
          if (item.kind === "assistant") {
            const aMsg = item as AssistantMsg;
            return (
              <Box key={item.id} flexDirection="column" marginTop={1}>
                {aMsg.text ? (
                  <Box>
                    <Text color="magenta">{"\u25c6"} </Text>
                    <Text>{aMsg.text}</Text>
                  </Box>
                ) : null}
                {aMsg.toolCalls?.map((tc, i) => (
                  <ToolCall key={i} {...tc} verbose={verbose} />
                ))}
              </Box>
            );
          }
          if (item.kind === "status") {
            return <Text key={item.id} dimColor>{(item as StatusMsg).text}</Text>;
          }
          return null;
        }}
      </Static>

      {/* Dynamic area — only active turn content + input */}
      <Box flexDirection="column">
        {/* In-progress tool calls (not yet finalized) */}
        {completedToolCalls.map((tc, i) => (
          <ToolCall key={`tc-${i}`} {...tc} verbose={verbose} />
        ))}

        {/* Active streaming text with diamond prefix */}
        {streamingText !== "" && (
          <Box>
            <Text color="magenta">{"\u25c6"} </Text>
            <Text>{streamingText}</Text>
          </Box>
        )}

        {/* Thinking animation */}
        {thinking && <ThinkingIndicator startTime={thinkStartTime} />}

        {/* "thought for Xs" after turn completes */}
        {thinkElapsed !== null && (
          <Text dimColor>{"  "}{"\u25c6"} thought for {thinkElapsed}s</Text>
        )}

        {/* Ctrl+C warning */}
        {ctrlCCount > 0 && !running && (
          <Text dimColor>{"  "}Press Ctrl+C again to exit.</Text>
        )}

        {/* Steer queue display */}
        <SteerQueue items={steerQueue} />

        {/* Input + permissions */}
        <InputArea
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          bashMode={bashMode}
          focus={true}
        />
        <PermissionsLine mode={state.permMode} />
      </Box>
    </>
  );
}
