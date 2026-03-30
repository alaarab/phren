import React, { useState, useCallback } from "react";
import { Static, Box, Text, useApp } from "ink";
import { Banner } from "./Banner.js";
import { ToolCall, type ToolCallProps } from "./ToolCall.js";
import { ToolSpinner } from "./ToolSpinner.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { SteerQueue } from "./SteerQueue.js";
import { InputArea, PermissionsLine, type AgentTab } from "./InputArea.js";
import type { PermissionMode } from "../../permissions/types.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";
import type { Theme } from "../themes.js";
import { renderMarkdown } from "../../multi/markdown.js";

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

export interface ActiveToolInfo {
  name: string;
  preview: string;
}

export interface AppProps {
  state: AppState;
  completedMessages: CompletedMessage[];
  streamingText: string;
  completedToolCalls: ToolCallProps[];
  activeTool: ActiveToolInfo | null;
  thinking: boolean;
  thinkStartTime: number;
  thinkElapsed: string | null;
  steerQueue: string[];
  running: boolean;
  showBanner: boolean;
  inputHistory: string[];
  verbose: boolean;
  theme: Theme;
  onSubmit: (input: string) => void;
  onPermissionCycle: () => void;
  onCancelTurn: () => void;
  onExit: () => void;
  /** Agent tabs for multi-agent mode */
  agents?: AgentTab[];
  /** Currently selected agent ID (null = main orchestrator) */
  selectedAgentId?: string | null;
  /** Callback when user selects a different agent tab */
  onSelectAgent?: (agentId: string | null) => void;
  /** Callback when user presses Esc to cancel agent work */
  onCancelAgent?: () => void;
}

export function App({
  state,
  completedMessages,
  streamingText,
  completedToolCalls,
  activeTool,
  thinking,
  thinkStartTime,
  thinkElapsed,
  steerQueue,
  running,
  showBanner,
  inputHistory,
  verbose,
  theme,
  onSubmit,
  onPermissionCycle,
  onCancelTurn,
  onExit,
  agents,
  selectedAgentId,
  onSelectAgent,
  onCancelAgent,
}: AppProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState("");
  const [bashMode, setBashMode] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [ctrlCCount, setCtrlCCount] = useState(0);
  const [tabFocused, setTabFocused] = useState(false);
  const [highlightedTabIndex, setHighlightedTabIndex] = useState(0);

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
    onEscCancelAgent: onCancelAgent,
    // Tab navigation: down enters tab bar, left/right cycles, enter selects, up exits
    tabFocused,
    onTabNavigate: agents && agents.length > 0 ? {
      onEnterTabBar: () => { setTabFocused(true); setHighlightedTabIndex(0); },
      onExitTabBar: () => { setTabFocused(false); },
      onLeft: () => { setHighlightedTabIndex((prev) => Math.max(0, prev - 1)); },
      onRight: () => { setHighlightedTabIndex((prev) => Math.min((agents?.length ?? 1) - 1, prev + 1)); },
      onSelect: () => {
        if (agents && agents[highlightedTabIndex]) {
          const id = agents[highlightedTabIndex].id;
          onSelectAgent?.(id === "__main__" ? null : id);
        }
        // Stay in tab bar — user presses Up to go back to chat
      },
    } : undefined,
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
                <Text bold color={theme.user.color}>{theme.user.label} {(item as UserMsg).text}</Text>
              </Box>
            );
          }
          if (item.kind === "assistant") {
            const aMsg = item as AssistantMsg;
            return (
              <Box key={item.id} flexDirection="column" marginTop={1}>
                {aMsg.toolCalls?.map((tc, i) => (
                  <ToolCall key={i} {...tc} verbose={verbose} theme={theme} />
                ))}
                {aMsg.text ? (
                  <Box>
                    <Text color={theme.agent.color} wrap="truncate">{theme.agent.label} </Text>
                    <Text wrap="wrap">{renderMarkdown(aMsg.text)}</Text>
                  </Box>
                ) : null}
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
          <ToolCall key={`tc-${i}`} {...tc} verbose={verbose} theme={theme} />
        ))}

        {/* Currently executing tool — animated spinner */}
        {activeTool && (
          <Box paddingLeft={2}>
            <ToolSpinner />
            <Text bold>{activeTool.name}</Text>
            {activeTool.preview ? <Text color={theme.separator}> {activeTool.preview}</Text> : null}
          </Box>
        )}

        {/* Active streaming text with diamond prefix */}
        {streamingText !== "" && (
          <Box marginTop={1}>
            <Text color={theme.agent.color} wrap="truncate">{theme.agent.label} </Text>
            <Text wrap="wrap">{streamingText}</Text>
          </Box>
        )}

        {/* Thinking animation */}
        {thinking && <Box marginTop={1}><ThinkingIndicator startTime={thinkStartTime} /></Box>}

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
          separatorColor={theme.separator}
        />
        <PermissionsLine
          mode={state.permMode}
          theme={theme}
          agents={agents}
          selectedAgentId={selectedAgentId}
          highlightedTabId={agents && agents[highlightedTabIndex] ? agents[highlightedTabIndex].id : null}
          tabFocused={tabFocused}
        />
      </Box>
    </>
  );
}
