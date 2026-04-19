import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback, useEffect } from "react";
import { Static, Box, Text, useApp, useInput } from "ink";
import { Banner } from "./Banner.js";
import { ToolCall } from "./ToolCall.js";
import { ToolSpinner } from "./ToolSpinner.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { SteerQueue } from "./SteerQueue.js";
import { InputArea, PermissionsLine } from "./InputArea.js";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts.js";
import { renderMarkdown } from "../../multi/markdown.js";
import { useSearch, highlightMatches } from "../hooks/useSearch.js";
export function App({ state, completedMessages, streamingText, completedToolCalls, activeTool, thinking, thinkStartTime, thinkElapsed, steerQueue, running, showBanner, inputHistory, verbose, theme, onSubmit, onPermissionCycle, onCancelTurn, onExit, onExpandTool, agents, selectedAgentId, onSelectAgent, onCancelAgent, }) {
    const { exit } = useApp();
    const [inputValue, setInputValue] = useState("");
    const [bashMode, setBashMode] = useState(false);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [ctrlCCount, setCtrlCCount] = useState(0);
    const [tabFocused, setTabFocused] = useState(false);
    const [highlightedTabIndex, setHighlightedTabIndex] = useState(0);
    const [showTaskList, setShowTaskList] = useState(false);
    const [stashedInput, setStashedInput] = useState("");
    const [historySearchMode, setHistorySearchMode] = useState(false);
    const [historySearchQuery, setHistorySearchQuery] = useState("");
    const [historySearchIndex, setHistorySearchIndex] = useState(0);
    const [expandedTools, setExpandedTools] = useState(new Set());
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
            }
            else if (msg.kind === "assistant") {
                const { count } = highlightMatches(msg.text, search.state.query);
                total += count;
            }
        }
        search.setMatchInfo(total, 0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search.state.query, search.state.active, completedMessages]);
    // Handle keypresses while search mode is active
    useInput((input, key) => {
        if (!search.state.active)
            return;
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
        if (key.ctrl || key.meta)
            return;
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
        if (!historySearchMode)
            return;
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
        if (key.ctrl || key.meta)
            return;
        // Regular character: append to query
        if (input.length > 0 && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) {
            setHistorySearchQuery((q) => q + input);
            setHistorySearchIndex(0);
        }
    }, { isActive: historySearchMode });
    const handleSubmit = useCallback((value) => {
        setInputValue("");
        setHistoryIndex(-1);
        if (value === "")
            return;
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
        onExpandTool: () => {
            const lastIndex = completedToolCalls.length - 1;
            if (lastIndex < 0)
                return;
            setExpandedTools((prev) => {
                const next = new Set(prev);
                if (next.has(lastIndex)) {
                    next.delete(lastIndex);
                }
                else {
                    next.add(lastIndex);
                }
                return next;
            });
            onExpandTool?.();
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
            }
            catch { /* editor cancelled or failed */ }
        },
        stashedInput,
        onStash: (text) => { setStashedInput(text); },
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
        onCycleAgent: agents && agents.length > 0 ? () => {
            const currentIdx = agents.findIndex(a => a.id === selectedAgentId || (selectedAgentId === null && a.id === "__main__"));
            const nextIdx = (currentIdx + 1) % agents.length;
            const nextId = agents[nextIdx].id;
            onSelectAgent?.(nextId === "__main__" ? null : nextId);
        } : undefined,
        onToggleTaskList: () => setShowTaskList(v => !v),
    });
    // Helper: apply search highlighting to a text string (ANSI only works in
    // non-Ink raw text mode). Since Ink's <Text> will escape ANSI we pass raw
    // strings to renderMarkdown which outputs ANSI directly.
    const applySearch = useCallback((text) => {
        if (!search.state.active || !search.state.query)
            return text;
        return highlightMatches(text, search.state.query).highlighted;
    }, [search.state.active, search.state.query]);
    return (_jsxs(_Fragment, { children: [_jsx(Static, { items: completedMessages, children: (item) => {
                    if (item.kind === "user") {
                        return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { bold: theme.user.bold ?? true, color: theme.user.color, children: [theme.user.label, " ", applySearch(item.text)] }) }, item.id));
                    }
                    if (item.kind === "assistant") {
                        const aMsg = item;
                        const renderedText = aMsg.text
                            ? applySearch(renderMarkdown(aMsg.text, theme.markdown))
                            : "";
                        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [aMsg.toolCalls?.map((tc, i) => (_jsx(ToolCall, { ...tc, verbose: verbose, theme: theme }, i))), renderedText ? (_jsxs(Box, { children: [_jsxs(Text, { color: theme.agent.color, wrap: "truncate", children: [theme.agent.label, " "] }), _jsx(Text, { wrap: "wrap", children: renderedText })] })) : null] }, item.id));
                    }
                    if (item.kind === "status") {
                        return _jsx(Text, { color: theme.system.color, dimColor: true, children: applySearch(item.text) }, item.id);
                    }
                    return null;
                } }), _jsxs(Box, { flexDirection: "column", children: [showBanner && completedMessages.length === 0 && _jsx(Banner, { state: state, theme: theme }), completedToolCalls.map((tc, i) => (_jsx(ToolCall, { ...tc, verbose: verbose, theme: theme, expanded: expandedTools.has(i) }, `tc-${i}`))), activeTool && (_jsxs(Box, { paddingLeft: 2, children: [_jsx(ToolSpinner, { theme: theme }), _jsx(Text, { bold: true, color: theme.tool.name, children: activeTool.name }), activeTool.preview ? _jsxs(Text, { color: theme.tool.preview ?? theme.separator, children: [" ", activeTool.preview] }) : null] })), streamingText !== "" && (_jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { color: theme.agent.color, wrap: "truncate", children: [theme.agent.label, " "] }), _jsx(Text, { wrap: "wrap", children: renderMarkdown(streamingText, theme.markdown) })] })), thinking && _jsx(Box, { marginTop: 1, children: _jsx(ThinkingIndicator, { startTime: thinkStartTime, theme: theme }) }), thinkElapsed !== null && (_jsxs(Text, { color: theme.dim, dimColor: true, children: ["  ", "\u25c8", " ", thinkElapsed] })), ctrlCCount > 0 && !running && (_jsxs(Text, { dimColor: true, children: ["  ", "Press Ctrl+C again to exit."] })), _jsx(SteerQueue, { items: steerQueue, theme: theme }), showTaskList && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { dimColor: true, children: ["  ", "Tasks: (ctrl+t to hide)"] }), _jsxs(Text, { dimColor: true, children: ["  ", "No shared task list in this session."] })] })), search.state.active && (_jsxs(Box, { children: [_jsxs(Text, { color: theme.search?.prompt ?? "cyan", children: ["  ", "find: ", search.state.query, _jsx(Text, { inverse: true, children: " " })] }), search.state.matchCount > 0
                                ? _jsxs(Text, { dimColor: true, color: theme.search?.match ?? undefined, children: [" (", search.state.currentMatch + 1, " of ", search.state.matchCount, ")"] })
                                : search.state.query.length > 0
                                    ? _jsx(Text, { dimColor: true, color: theme.search?.noMatch ?? "red", children: " (no matches)" })
                                    : _jsx(Text, { dimColor: true, children: " (type to search)" })] })), historySearchMode && (_jsxs(Box, { children: [_jsxs(Text, { color: theme.search?.prompt ?? "cyan", children: ["  ", "search: ", historySearchQuery, _jsx(Text, { inverse: true, children: " " })] }), historyMatches.length > 0
                                ? _jsxs(Text, { dimColor: true, color: theme.search?.match ?? undefined, children: [" (match ", (historySearchIndex % historyMatches.length) + 1, " of ", historyMatches.length, ")"] })
                                : historySearchQuery.length > 0
                                    ? _jsx(Text, { dimColor: true, color: theme.search?.noMatch ?? "red", children: " (no matches)" })
                                    : _jsx(Text, { dimColor: true, children: " (type to search history)" })] })), historySearchMode && currentMatch && (_jsx(Box, { children: _jsxs(Text, { dimColor: true, children: ["  ", "\u25b8", " ", currentMatch] }) })), _jsx(InputArea, { value: inputValue, onChange: setInputValue, onSubmit: handleSubmit, bashMode: bashMode, focus: !isAnyModeActive, separatorColor: theme.separator, theme: theme }), _jsx(PermissionsLine, { mode: state.permMode, theme: theme, running: running, agents: agents, selectedAgentId: selectedAgentId, highlightedTabId: agents?.[highlightedTabIndex]?.id ?? null, tabFocused: tabFocused })] })] }));
}
