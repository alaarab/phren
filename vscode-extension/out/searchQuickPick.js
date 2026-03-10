"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.showSearchQuickPick = showSearchQuickPick;
const vscode = __importStar(require("vscode"));
const SEARCH_DEBOUNCE_MS = 300;
async function showSearchQuickPick(client) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = "Search cortex knowledge...";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    let requestToken = 0;
    const runSearch = async (query) => {
        const currentToken = ++requestToken;
        quickPick.title = undefined;
        const trimmedQuery = query.trim();
        if (!trimmedQuery) {
            quickPick.items = [];
            quickPick.busy = false;
            return;
        }
        quickPick.busy = true;
        try {
            const rawResponse = await client.searchKnowledge(trimmedQuery);
            const searchResults = parseSearchResults(rawResponse);
            const items = await Promise.all(searchResults.map(async (result) => {
                const fullContent = await resolveFullContent(client, result);
                const labelSource = firstNonEmpty(result.title, result.snippet, result.filename, result.path, "Search result");
                return {
                    label: truncate(labelSource, 80),
                    description: result.project,
                    detail: truncate(fullContent, 200),
                    result,
                    fullContent,
                };
            }));
            if (currentToken !== requestToken) {
                return;
            }
            quickPick.items = items;
            quickPick.title = items.length === 0 ? "No results" : undefined;
        }
        catch (error) {
            if (currentToken !== requestToken) {
                return;
            }
            quickPick.items = [];
            quickPick.title = `Search failed: ${truncate(toErrorMessage(error), 80)}`;
        }
        finally {
            if (currentToken === requestToken) {
                quickPick.busy = false;
            }
        }
    };
    const debouncedSearch = debounce((value) => {
        void runSearch(value);
    }, SEARCH_DEBOUNCE_MS);
    const changeValueDisposable = quickPick.onDidChangeValue((value) => {
        debouncedSearch(value);
    });
    const acceptDisposable = quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (!selected) {
            return;
        }
        const panelTitle = selected.result.filename
            ? `${selected.result.project}/${selected.result.filename}`
            : selected.label;
        const panel = vscode.window.createWebviewPanel("cortex.searchResult", panelTitle, vscode.ViewColumn.Beside, {});
        panel.webview.html = renderSearchResultHtml(panelTitle, selected.result.project, selected.fullContent);
        quickPick.hide();
    });
    const hideDisposable = quickPick.onDidHide(() => {
        changeValueDisposable.dispose();
        acceptDisposable.dispose();
        hideDisposable.dispose();
        quickPick.dispose();
    });
    quickPick.show();
    debouncedSearch("");
}
async function resolveFullContent(client, result) {
    const providedContent = asNonEmptyString(result.content);
    if (providedContent) {
        return providedContent;
    }
    const memoryId = toMemoryId(result);
    if (memoryId) {
        try {
            const rawResponse = await client.getMemoryDetail(memoryId);
            const fullContent = parseMemoryContent(rawResponse);
            if (fullContent) {
                return fullContent;
            }
        }
        catch {
            // Best effort fallback for older servers or missing memory IDs.
        }
    }
    return firstNonEmpty(result.snippet, result.path, "");
}
function toMemoryId(result) {
    const project = asNonEmptyString(result.project);
    const filename = asNonEmptyString(result.filename);
    if (!project || !filename) {
        return undefined;
    }
    const normalizedFilename = filename.replace(/^\/+/, "");
    return `mem:${project}/${normalizedFilename}`;
}
function parseSearchResults(value) {
    const data = responseData(value);
    const results = asArray(data?.results);
    const parsed = [];
    for (const entry of results) {
        const record = asRecord(entry);
        const project = asNonEmptyString(record?.project);
        if (!project) {
            continue;
        }
        parsed.push({
            project,
            filename: asString(record?.filename),
            snippet: asString(record?.snippet),
            title: asString(record?.title),
            path: asString(record?.path),
            content: asString(record?.content),
        });
    }
    return parsed;
}
function parseMemoryContent(value) {
    const data = responseData(value);
    const content = asNonEmptyString(data?.content);
    return content ?? "";
}
function renderSearchResultHtml(title, project, content) {
    const safeTitle = escapeHtml(title);
    const safeProject = escapeHtml(project);
    const safeContent = escapeHtml(content || "(No content available)");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      padding: 20px;
      line-height: 1.45;
    }
    .title {
      margin: 0 0 10px;
      font-size: 1.2rem;
    }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 0.8rem;
      margin-bottom: 16px;
      background: rgba(127, 127, 127, 0.2);
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      border-radius: 8px;
      padding: 14px;
      background: rgba(127, 127, 127, 0.12);
      border: 1px solid rgba(127, 127, 127, 0.25);
    }
  </style>
</head>
<body>
  <h1 class="title">${safeTitle}</h1>
  <div class="badge">${safeProject}</div>
  <pre>${safeContent}</pre>
</body>
</html>`;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function debounce(callback, waitMs) {
    let timeout;
    return (...args) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => {
            callback(...args);
        }, waitMs);
    };
}
function truncate(value, maxLength) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
function firstNonEmpty(...values) {
    for (const value of values) {
        const normalized = asNonEmptyString(value);
        if (normalized) {
            return normalized;
        }
    }
    return "";
}
function responseData(value) {
    const response = asRecord(value);
    return asRecord(response?.data);
}
function asRecord(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return value;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asNonEmptyString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : undefined;
}
function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
//# sourceMappingURL=searchQuickPick.js.map