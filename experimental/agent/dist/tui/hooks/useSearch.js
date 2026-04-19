import { useState, useCallback } from "react";
export function useSearch() {
    const [state, setState] = useState({
        active: false,
        query: "",
        matchCount: 0,
        currentMatch: 0,
    });
    const activate = useCallback(() => {
        setState(s => ({ ...s, active: true, query: "", matchCount: 0, currentMatch: 0 }));
    }, []);
    const deactivate = useCallback(() => {
        setState(s => ({ ...s, active: false }));
    }, []);
    const setQuery = useCallback((query) => {
        setState(s => ({ ...s, query }));
    }, []);
    const setMatchInfo = useCallback((matchCount, currentMatch) => {
        setState(s => ({ ...s, matchCount, currentMatch }));
    }, []);
    const nextMatch = useCallback(() => {
        setState(s => ({
            ...s,
            currentMatch: s.matchCount > 0 ? (s.currentMatch + 1) % s.matchCount : 0,
        }));
    }, []);
    const prevMatch = useCallback(() => {
        setState(s => ({
            ...s,
            currentMatch: s.matchCount > 0 ? (s.currentMatch - 1 + s.matchCount) % s.matchCount : 0,
        }));
    }, []);
    return { state, activate, deactivate, setQuery, setMatchInfo, nextMatch, prevMatch };
}
/** Highlight all occurrences of query in text with ANSI yellow background. */
export function highlightMatches(text, query) {
    if (!query || query.length === 0)
        return { highlighted: text, count: 0 };
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    let count = 0;
    const highlighted = text.replace(regex, (match) => {
        count++;
        return `\x1b[43m\x1b[30m${match}\x1b[0m`;
    });
    return { highlighted, count };
}
