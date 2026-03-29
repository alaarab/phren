import React, { useState, useCallback } from "react";
import { Static, Box, Text, useApp } from "ink";
import { StatusBar } from "./StatusBar.js";
import { Banner } from "./Banner.js";
import { UserMessage } from "./UserMessage.js";
import { StreamingText } from "./StreamingText.js";
import { ToolCall, type ToolCallProps } from "./ToolCall.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { SteerQueue } from "./SteerQueue.js";
import { InputArea, PermissionsLine } from "./InputArea.js";
import type { PermissionMode } from "../../permissions/types.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";

// ── Message types for Static history ─────────────────────────────────────────

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
  onSubmit: (input: string) => void;
  onPermissionCycle: () => void;
  onCancelTurn: () => void;
  onExit: () => void;
}

function CompletedItem({ msg }: { msg: CompletedMessage }) {
  switch (msg.kind) {
    case "user":
      return <UserMessage text={msg.text} />;
    case "assistant":
      return (
        <Box flexDirection="column">
          {msg.text ? <StreamingText text={msg.text} /> : null}
          {msg.toolCalls?.map((tc, i) => (
            <ToolCall key={i} {...tc} />
          ))}
        </Box>
      );
    case "status":
      return <Text dimColor>{msg.text}</Text>;
  }
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

  // Build the Static items — banner first if shown, then completed messages
  const staticItems: Array<{ id: string; kind: string }> = [];
  if (showBanner) {
    staticItems.push({ id: "banner", kind: "banner" });
  }
  for (const msg of completedMessages) {
    staticItems.push(msg);
  }

  return (
    <>
      <StatusBar
        provider={state.provider}
        project={state.project}
        turns={state.turns}
        cost={state.cost}
        permMode={state.permMode}
        agentCount={state.agentCount}
      />

      {/* Banner and completed messages — rendered once, leave React tree */}
      <Static items={staticItems}>
        {(item) => {
          if (item.kind === "banner") {
            return (
              <Box key="banner">
                <Banner version={state.version} />
              </Box>
            );
          }
          return (
            <Box key={item.id} flexDirection="column">
              <CompletedItem msg={item as CompletedMessage} />
            </Box>
          );
        }}
      </Static>

      {/* Dynamic area: active turn content + prompt */}
      <Box flexDirection="column">
        {/* Completed tool calls in current turn (not yet finalized) */}
        {completedToolCalls.map((tc, i) => (
          <ToolCall key={`tc-${i}`} {...tc} />
        ))}

        {/* Active streaming text */}
        {streamingText !== "" && <StreamingText text={streamingText} />}

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
          focus={!running}
        />
        <PermissionsLine mode={state.permMode} />
      </Box>
    </>
  );
}
