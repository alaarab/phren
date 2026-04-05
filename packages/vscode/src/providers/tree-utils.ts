import * as vscode from "vscode";
import type { PhrenCategory, TaskNode, TaskSection } from "./tree-types";

export function categoryIconId(category: PhrenCategory): string {
  if (category === "findings") {
    return "list-flat";
  }
  if (category === "truths") {
    return "pin";
  }
  if (category === "sessions") {
    return "history";
  }
  if (category === "task") {
    return "checklist";
  }
  if (category === "queue") {
    return "inbox";
  }
  if (category === "hooks") {
    return "plug";
  }
  return "book";
}

export function taskIconId(task: TaskNode): string {
  if (task.checked || task.section === "Done") {
    return "check";
  }
  if (task.pinned) {
    return "pinned";
  }
  if (task.section === "Active") {
    return "play";
  }
  return "clock";
}

export function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.filter((entry): entry is string => typeof entry === "string");
  return parsed.length > 0 ? parsed : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function asTaskSection(value: unknown): TaskSection | undefined {
  return value === "Active" || value === "Queue" || value === "Done" ? value : undefined;
}

export function asSessionStatus(value: unknown): "active" | "ended" | undefined {
  return value === "active" || value === "ended" ? value : undefined;
}

export function responseData(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  return asRecord(response?.data);
}

export function formatDateLabel(dateStr: string): string {
  if (dateStr === "unknown") { return "Unknown date"; }
  const parsed = new Date(dateStr + "T00:00:00");
  if (isNaN(parsed.getTime())) { return dateStr; }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);

  if (diffDays === 0) { return "Today"; }
  if (diffDays === 1) { return "Yesterday"; }
  if (diffDays < 7) { return `${diffDays} days ago`; }

  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: parsed.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

export function formatSessionTimeLabel(startedAt: string): string {
  const parsed = new Date(startedAt);
  if (isNaN(parsed.getTime())) {
    return startedAt;
  }

  return parsed.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) { return "unknown"; }
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) { return "just now"; }
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) { return "just now"; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) { return `${diffHours}h ago`; }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) { return `${diffDays}d ago`; }
  return `${Math.floor(diffDays / 30)}mo ago`;
}

export function themeIcon(id: string, color?: string): vscode.ThemeIcon {
  if (id === "folder") {
    return vscode.ThemeIcon.Folder;
  }
  if (id === "file") {
    return vscode.ThemeIcon.File;
  }
  if (color) {
    return new vscode.ThemeIcon(id, new vscode.ThemeColor(color));
  }
  return new vscode.ThemeIcon(id);
}
