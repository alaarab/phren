import React, { useState, useCallback, useEffect } from "react";
import { Static, Box, Text, useApp, useInput } from "ink";
import { Banner } from "./Banner.js";
import { ToolCall, type ToolCallProps } from "./ToolCall.js";
import { ToolSpinner } from "./ToolSpinner.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { SteerQueue } from "./SteerQueue.js";
import { StatusBar } from "./StatusBar.js";
import { InputArea, PermissionsLine, type AgentTab } from "./InputArea.js";
import type { PermissionMode } from "../../permissions/types.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";
import type { Theme } from "../themes.js";
import { renderMarkdown } from "../../multi/markdown.js";
import { useSearch, highlightMatches } from "../hooks/useSearch.js";

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
  const [stashedInput, setStashedInput] = useState("");
  const [historySearchMode, setHistorySearchMode] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historySearchIndex, setHistorySearchIndex] = useState(0);

  // ── Ctrl+F content search ────────────────────────────────────────────────
  const search = useSearch();

  // When the query changes, recompute total match count across all completed messages
  useEffect(() => {
    if (!search.state.active || !search.state.query) {
      search.setMatchInfo(0, 0);
      return;
    }
    let total = 0;
    for (const msg of completedMessages) {
      if (msg.kind === "user" || msg.kind === "status") {
        const { count } = highlightMatches(msg.text, search.state.query);
        total += count;
      } else if (msg.kind === "assistant") {
        const { count } = highlightMatches(msg.text, search.state.query);
        total += count;
      }
    }
    search.setMatchInfo(total, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.state.query, search.state.active, completedMessages]);

  // Handle keypresses while search mode is active
  useInput((input, key) => {
    if (!search.state.active) return;

    // Escape: deactivate search
    if (key.escape) {
      search.deactivate();
      return;
    }

    // Enter or n: next match
    if (key.return || input === "n") {
      search.nextMatch();
      return;
    }

    // N (shift+n): previous match
    if (input === "N") {
      search.prevMatch();
      return;
    }

    // Backspace: remove last char from query
    if (key.backspace || key.delete) {
      search.setQuery(search.state.query.slice(0, -1));
      return;
    }

    // Skip ctrl/meta combinations
    if (key.ctrl || key.meta) return;

    // Regular character: append to query
    if (input.length > 0 && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) {
      search.setQuery(search.state.query + input);
    }
  }, { isActive: search.state.active });

  // History search: compute matches from current query
  const historyMatches = historySearchMode
    ? inputHistory.filter((h) => h.toLowerCase().includes(historySearchQuery.toLowerCase()))
    : [];
  const currentMatch = historyMatches.length > 0
    ? historyMatches[historySearchIndex % historyMatches.length]
    : null;

  // Handle keypresses while in history search mode
  useInput((input, key) => {
    if (!historySearchMode) return;

    // Ctrl+R again: cycle to next match
    if (key.ctrl && input === "r") {
      if (historyMatches.length > 0) {
        setHistorySearchIndex((i) => (i + 1) % historyMatches.length);
      }
      return;
    }

    // Enter: accept match
    if (key.return) {
      if (currentMatch) {
        setInputValue(currentMatch);
      }
      setHistorySearchMode(false);
      setHistorySearchQuery("");
      setHistorySearchIndex(0);
      return;
    }

    // Escape: cancel search
    if (key.escape) {
      setHistorySearchMode(false);
      setHistorySearchQuery("");
      setHistorySearchIndex(0);
      return;
    }

    // Backspace: remove last char from query
    if (key.backspace || key.delete) {
      setHistorySearchQuery((q) => q.slice(0, -1));
      setHistorySearchIndex(0);
      return;
    }

    // Skip ctrl/meta combinations (except already handled)
    if (key.ctrl || key.meta) return;

    // Regular character: append to query
    if (input.length > 0 && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) {
      setHistorySearchQuery((q) => q + input);
      setHistorySearchIndex(0);
    }
  }, { isActive: historySearchMode });

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

  const isAnyModeActive = search.state.active || historySearchMode;

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
    onHistorySearch: () => {
      setHistorySearchMode(true);
      setHistorySearchQuery("");
      setHistorySearchIndex(0);
    },
    onContentSearch: () => {
      search.activate();
    },
    onOpenEditor: () => {
      // Write input to temp file, open $EDITOR, read back
      const tmpFile = `/tmp/phren-input-${Date.now()}.md`;
      try {
        const fs = require("fs");
        const { execSync } = require("child_process");
        fs.writeFileSync(tmpFile, inputValue);
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        execSync(`${editor} ${tmpFile}`, { stdio: "inherit" });
        const result = fs.readFileSync(tmpFile, "utf-8");
        fs.unlinkSync(tmpFile);
        setInputValue(result.replace(/\n$/, ""));
      } catch { /* editor cancelled or failed */ }
    },
    stashedInput,
    onStash: (text: string) => { setStashedInput(text); },
    onUnstash: () => { const s = stashedInput; setStashedInput(""); return s || null; },
    tabFocused,
    onEnterTabBar: agents && agents.length > 0 ? () => { setTabFocused(true); setHighlightedTabIndex(0); } : undefined,
    onExitTabBar: () => { setTabFocused(false); },
    onTabLeft: () => { setHighlightedTabIndex((p) => Math.max(0, p - 1)); },
    onTabRight: () => { setHighlightedTabIndex((p) => Math.min((agents?.length ?? 1) - 1, p + 1)); },
    onTabSelect: () => {
      if (agents && agents[highlightedTabIndex]) {
        const id = agents[highlightedTabIndex].id;
        onSelectAgent?.(id === "__main__" ? null : id);
      }
    },
  });

  // Helper: apply search highlighting to a text string (ANSI only works in
  // non-Ink raw text mode). Since Ink's <Text> will escape ANSI we pass raw
  // strings to renderMarkdown which outputs ANSI directly.
  const applySearch = useCallback((text: string): string => {
    if (!search.state.active || !search.state.query) return text;
    return highlightMatches(text, search.state.query).highlighted;
  }, [search.state.active, search.state.query]);

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
                <Banner version={state.version} theme={theme} />
              </Box>
            );
          }
          if (item.kind === "user") {
            return (
              <Box key={item.id} flexDirection="column">
                <Text bold={theme.user.bold ?? true} color={theme.user.color}>{theme.user.label} {applySearch((item as UserMsg).text)}</Text>
              </Box>
            );
          }
          if (item.kind === "assistant") {
            const aMsg = item as AssistantMsg;
            const renderedText = aMsg.text
              ? applySearch(renderMarkdown(aMsg.text, theme.markdown))
              : "";
            return (
              <Box key={item.id} flexDirection="column" marginTop={1}>
                {aMsg.toolCalls?.map((tc, i) => (
                  <ToolCall key={i} {...tc} verbose={verbose} theme={theme} />
                ))}
                {renderedText ? (
                  <Box>
                    <Text color={theme.agent.color} wrap="truncate">{theme.agent.label} </Text>
                    <Text wrap="wrap">{renderedText}</Text>
                  </Box>
                ) : null}
              </Box>
            );
          }
          if (item.kind === "status") {
            return <Text key={item.id} color={theme.system.color} dimColor>{applySearch((item as StatusMsg).text)}</Text>;
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
            <ToolSpinner theme={theme} />
            <Text bold color={theme.tool.name}>{activeTool.name}</Text>
            {activeTool.preview ? <Text color={theme.tool.preview ?? theme.separator}> {activeTool.preview}</Text> : null}
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
        {thinking && <Box marginTop={1}><ThinkingIndicator startTime={thinkStartTime} theme={theme} /></Box>}

        {/* "thought for Xs" after turn completes */}
        {thinkElapsed !== null && (
          <Text color={theme.dim} dimColor>{"  "}{"\u25c6"} thought for {thinkElapsed}s</Text>
        )}

        {/* Ctrl+C warning */}
        {ctrlCCount > 0 && !running && (
          <Text dimColor>{"  "}Press Ctrl+C again to exit.</Text>
        )}

        {/* Steer queue display */}
        <SteerQueue items={steerQueue} theme={theme} />

        {/* Content search bar (Ctrl+F) */}
        {search.state.active && (
          <Box>
            <Text color={theme.search?.prompt ?? "cyan"}>{"  "}find: {search.state.query}<Text inverse> </Text></Text>
            {search.state.matchCount > 0
              ? <Text dimColor color={theme.search?.match ?? undefined}> ({search.state.currentMatch + 1} of {search.state.matchCount})</Text>
              : search.state.query.length > 0
                ? <Text dimColor color={theme.search?.noMatch ?? "red"}> (no matches)</Text>
                : <Text dimColor> (type to search)</Text>
            }
          </Box>
        )}

        {/* History search indicator */}
        {historySearchMode && (
          <Box>
            <Text color={theme.search?.prompt ?? "cyan"}>{"  "}search: {historySearchQuery}<Text inverse> </Text></Text>
            {historyMatches.length > 0
              ? <Text dimColor color={theme.search?.match ?? undefined}> (match {(historySearchIndex % historyMatches.length) + 1} of {historyMatches.length})</Text>
              : historySearchQuery.length > 0
                ? <Text dimColor color={theme.search?.noMatch ?? "red"}> (no matches)</Text>
                : <Text dimColor> (type to search history)</Text>
            }
          </Box>
        )}
        {historySearchMode && currentMatch && (
          <Box>
            <Text dimColor>{"  "}{"\u25b8"} {currentMatch}</Text>
          </Box>
        )}

        {/* Input + permissions */}
        <InputArea
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          bashMode={bashMode}
          focus={!isAnyModeActive}
          separatorColor={theme.separator}
          theme={theme}
        />
        <PermissionsLine
          mode={state.permMode}
          theme={theme}
          agents={agents}
          selectedAgentId={selectedAgentId}
          highlightedTabId={agents?.[highlightedTabIndex]?.id ?? null}
          tabFocused={tabFocused}
        />
        {/* StatusBar is now rendered outside Ink via TerminalControl (DECSTBM scroll region) */}
      </Box>
    </>
  );
}
