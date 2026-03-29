import React, { useState, useCallback } from "react";
import { Static, Box, useInput, useApp } from "ink";
import { StatusBar } from "./StatusBar.js";
import { ChatMessage, type ChatMessageProps } from "./ChatMessage.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { SteerQueue } from "./SteerQueue.js";
import { InputArea, PermissionsLine } from "./InputArea.js";
import { nextPermissionMode } from "../ansi.js";
import type { PermissionMode } from "../../permissions/types.js";

export interface AppState {
  provider: string;
  project: string | null;
  turns: number;
  cost: string;
  permMode: PermissionMode;
  agentCount: number;
}

export interface AppProps {
  state: AppState;
  completedMessages: ChatMessageProps[];
  streamingText: string;
  thinking: boolean;
  thinkStartTime: number;
  steerQueue: string[];
  running: boolean;
  onSubmit: (input: string) => void;
  onPermissionCycle: () => void;
  onExit: () => void;
}

export function App({
  state,
  completedMessages,
  streamingText,
  thinking,
  thinkStartTime,
  steerQueue,
  running,
  onSubmit,
  onPermissionCycle,
  onExit,
}: AppProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");
  const [bashMode, setBashMode] = useState(false);

  const handleSubmit = useCallback((value: string) => {
    setInputValue("");
    if (value === "") return;

    // ! at start toggles bash mode
    if (value === "!" && !bashMode) {
      setBashMode(true);
      return;
    }

    onSubmit(bashMode ? `!${value}` : value);
    setBashMode(false);
  }, [bashMode, onSubmit]);

  useInput((input, key) => {
    // Ctrl+D — exit
    if (key.ctrl && input === "d") {
      onExit();
      exit();
      return;
    }
    // Shift+Tab — cycle permission mode
    if (key.shift && key.tab) {
      onPermissionCycle();
      return;
    }
    // Escape — exit bash mode or clear
    if (key.escape) {
      if (bashMode) {
        setBashMode(false);
        setInputValue("");
      } else if (inputValue) {
        setInputValue("");
      }
    }
  });

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
      <Static items={completedMessages}>
        {(msg) => <ChatMessage key={msg.id} {...msg} />}
      </Static>
      <Box flexDirection="column">
        {streamingText !== "" && <Box><ChatMessage id="streaming" role="assistant" text={streamingText} /></Box>}
        {thinking && <ThinkingIndicator startTime={thinkStartTime} />}
        <SteerQueue items={steerQueue} />
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
