import { useState, useCallback } from "react";

export interface SearchState {
  active: boolean;
  query: string;
  matchCount: number;
  currentMatch: number;
}

export function useSearch() {
  const [state, setState] = useState<SearchState>({
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

  const setQuery = useCallback((query: string) => {
    setState(s => ({ ...s, query }));
  }, []);

  const setMatchInfo = useCallback((matchCount: number, currentMatch: number) => {
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
export function highlightMatches(text: string, query: string): { highlighted: string; count: number } {
  if (!query || query.length === 0) return { highlighted: text, count: 0 };
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "gi");
  let count = 0;
  const highlighted = text.replace(regex, (match) => {
    count++;
    return `\x1b[43m\x1b[30m${match}\x1b[0m`;
  });
  return { highlighted, count };
}
