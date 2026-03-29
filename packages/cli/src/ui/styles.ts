export const PROJECT_REFERENCE_UI_STYLES = `
  .project-reference-shell {
    height: calc(100vh - 260px);
    min-height: 520px;
  }
  .reference-sidebar-toolbar {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .reference-banner {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
    color: var(--ink-secondary);
    padding: 14px 16px;
    margin-bottom: 12px;
    font-size: var(--text-sm);
    line-height: 1.55;
  }
  .reference-doc-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .reference-hint {
    padding: 20px;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.6;
  }
  .reference-status {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .reference-status.ok { color: var(--success); }
  .reference-status.err { color: var(--danger); }
  .reference-sidebar-note {
    padding: 12px 16px;
    color: var(--muted);
    font-size: var(--text-sm);
    border-bottom: 1px solid var(--border-light);
  }
  .reference-item-main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .reference-item-title {
    font-size: var(--text-base);
    color: var(--ink);
    font-weight: 500;
  }
  .reference-item-meta {
    font-size: var(--text-xs);
    color: var(--muted);
    line-height: 1.4;
  }
  .reference-item-action {
    margin-left: 8px;
    flex-shrink: 0;
  }
  .topic-editor {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 720px;
  }
  .topic-editor label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--ink-secondary);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .topic-editor input,
  .topic-editor textarea {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    font-size: var(--text-base);
    font-family: var(--font);
    background: var(--surface);
    color: var(--ink);
  }
  .topic-editor textarea {
    min-height: 90px;
    resize: vertical;
  }
  .topic-editor-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .topic-empty {
    padding: 24px 20px;
    color: var(--muted);
    line-height: 1.6;
  }
  .topic-keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .topic-keyword {
    display: inline-flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: 999px;
    background: var(--surface-sunken);
    color: var(--ink-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
  }
`;

export const SETTINGS_TAB_UI_STYLES = `
  .settings-shell {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .settings-section {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .settings-section-findings { border-top: 3px solid color-mix(in srgb, var(--accent) 60%, var(--border)); }
  .settings-section-behavior { border-top: 3px solid color-mix(in srgb, var(--blue) 45%, var(--border)); }
  .settings-section-integrations { border-top: 3px solid color-mix(in srgb, var(--purple) 45%, var(--border)); }
  .settings-section-header {
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--border-light);
    background: var(--surface);
  }
  .settings-section-header h3 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--ink);
  }
  .settings-section-header p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  .settings-section-body {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .settings-control {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border-light);
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
  }
  .settings-control-primary {
    background: color-mix(in srgb, var(--accent) 4%, var(--surface-raised));
    border-color: color-mix(in srgb, var(--accent) 18%, var(--border));
  }
  .settings-control-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .settings-control-label {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--ink-secondary);
  }
  .settings-control-note {
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 1.5;
  }
  .settings-control-value {
    color: var(--ink-secondary);
    font-size: var(--text-base);
    font-weight: 600;
  }
  .settings-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .settings-chip {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--ink-secondary);
    border-radius: 999px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: var(--text-sm);
    font-family: var(--font);
    font-weight: 600;
    transition: background .15s, border-color .15s, color .15s;
  }
  .settings-chip:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .settings-chip.active {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
  }
  .settings-chip.readonly {
    cursor: default;
    opacity: 0.92;
  }
  .settings-chip.readonly:hover {
    border-color: var(--border);
    color: var(--ink-secondary);
  }
  .settings-chip.active.readonly:hover {
    border-color: var(--accent);
    color: #fff;
  }
  .settings-status-inline {
    min-height: 18px;
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .settings-status-inline.ok { color: var(--success); }
  .settings-status-inline.err { color: var(--danger); }
  .settings-integrations-table {
    width: 100%;
    border-collapse: collapse;
  }
  .settings-integrations-table th,
  .settings-integrations-table td {
    text-align: left;
    padding: 10px 8px;
    border-bottom: 1px solid var(--border-light);
    font-size: var(--text-sm);
    vertical-align: middle;
  }
  .settings-integrations-table th {
    color: var(--muted);
    font-weight: 650;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    font-size: var(--text-xs);
  }
  .settings-integrations-table tr:last-child td { border-bottom: none; }
  .settings-tool {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    color: var(--ink-secondary);
    text-transform: capitalize;
  }
  .settings-indicator {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
  }
  .settings-indicator.on { background: var(--success); }
  .settings-indicator.off { background: var(--danger); }
`;

export const TASK_UI_STYLES = `
  /* ── Task Manager Styles ──────────────────────────── */
  .task-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }
  .task-filter-select {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    background: var(--surface);
    color: var(--ink);
    font-size: var(--text-sm);
    font-family: var(--font);
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .task-filter-select:hover { border-color: var(--accent); }
  .task-filter-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
  .task-count-label {
    font-size: var(--text-sm);
    color: var(--muted);
    margin-left: auto;
    font-weight: 500;
  }

  .task-empty-state {
    padding: 60px 40px;
    text-align: center;
    color: var(--muted);
  }

  .task-add-bar {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
    align-items: center;
  }
  .task-add-input {
    flex: 1;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--ink);
    font-size: var(--text-base);
    font-family: var(--font);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .task-add-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .task-add-input::placeholder { color: var(--muted); opacity: 0.6; }
  .task-add-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 18px;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 600;
    font-family: var(--font);
    transition: background 0.15s, transform 0.1s;
    white-space: nowrap;
  }
  .task-add-btn:hover { background: var(--accent-hover); }
  .task-add-btn:active { transform: scale(0.97); }

  .task-section-group { margin-bottom: 24px; }
  .task-section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
    padding: 0 4px;
  }
  .task-section-count {
    font-weight: 500;
    color: var(--muted);
    font-size: var(--text-xs);
    opacity: 0.7;
  }

  .task-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }

  .task-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-light);
    transition: background 0.1s;
    cursor: default;
    position: relative;
  }
  .task-row:last-child { border-bottom: none; }
  .task-row:hover { background: var(--surface-raised); }
  .task-row:hover .task-row-actions { opacity: 1; pointer-events: auto; }

  .task-row-priority {
    width: 4px;
    height: 24px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .task-row-priority-high { background: #ef4444; }
  .task-row-priority-medium { background: #f59e0b; }
  .task-row-priority-low { background: #9ca3af; }
  .task-row-priority-none { background: transparent; }

  .task-row-content {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .task-row-text {
    font-size: var(--text-base);
    color: var(--ink);
    line-height: 1.4;
    word-break: break-word;
  }
  .task-row-done .task-row-text {
    text-decoration: line-through;
    opacity: 0.5;
  }
  .task-row-context {
    font-size: var(--text-xs);
    color: var(--muted);
    font-style: italic;
    margin-top: 2px;
  }

  .task-row-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .task-priority-badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    text-transform: capitalize;
  }
  .task-priority-high { background: #ef444418; color: #ef4444; }
  .task-priority-medium { background: #f59e0b18; color: #f59e0b; }
  .task-priority-low { background: #6b728018; color: #6b7280; }

  .task-project-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: 10px;
    font-weight: 500;
    background: var(--accent-dim);
    color: var(--accent);
  }

  .task-pin-indicator {
    color: var(--accent);
    display: inline-flex;
    align-items: center;
  }

  .task-github-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: 10px;
    font-weight: 500;
    background: var(--surface-sunken);
    color: var(--ink-secondary);
    text-decoration: none;
    transition: background 0.15s;
  }
  .task-github-badge:hover { background: var(--accent-dim); color: var(--accent); }

  .task-row-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
    flex-shrink: 0;
  }
  .task-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
    font-size: 12px;
    font-family: var(--font);
    transition: all 0.15s;
    padding: 0;
  }
  .task-action-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-dim);
  }
  .task-action-btn.task-action-complete:hover {
    border-color: var(--success);
    color: var(--success);
    background: var(--success-dim);
  }
  .task-action-btn.task-action-delete:hover {
    border-color: var(--danger);
    color: var(--danger);
    background: var(--danger-dim);
  }

  .task-done-section { margin-top: 24px; }
  .task-done-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 4px;
    background: none;
    border: none;
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 700;
    font-family: var(--font);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    transition: color 0.15s;
  }
  .task-done-toggle:hover { color: var(--ink-secondary); }
  .task-toggle-arrow {
    font-size: 10px;
    transition: transform 0.2s;
  }
  .task-done-list { padding-top: 4px; }

  /* ── Task Summary Bar ──────────────────────────── */
  .task-summary-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--surface-sunken, var(--surface));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    flex-wrap: wrap;
    font-size: var(--text-sm);
  }
  .task-summary-total {
    font-weight: 600;
    color: var(--ink);
    font-size: var(--text-base);
  }
  .task-summary-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .task-summary-high { background: #ef444422; color: #ef4444; }
  .task-summary-medium { background: #f59e0b22; color: #f59e0b; }
  .task-summary-low { background: #6b728022; color: #6b7280; }
  .task-summary-projects {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .task-summary-project {
    font-size: 11px;
    color: var(--muted);
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  /* ── Task Session Badge ──────────────────────────── */
  .task-session-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: 10px;
    font-family: var(--mono, monospace);
    background: var(--surface-sunken, var(--surface));
    color: var(--muted);
    border: 1px solid var(--border);
  }
`;

export const REVIEW_UI_STYLES = `
  /* ── Review Toolbar ──────────────────────────── */
  .review-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .review-flagged-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink-secondary);
    cursor: pointer;
    user-select: none;
  }
  .review-flagged-toggle input[type="checkbox"] {
    width: 14px;
    height: 14px;
    cursor: pointer;
    accent-color: var(--accent);
  }
  .review-sync-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
  .review-sync-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    display: inline-block;
    transition: background 0.3s;
  }
  .review-sync-indicator.syncing {
    background: var(--warning);
    animation: ledPulse 1.2s infinite;
  }
  .review-sync-indicator.error {
    background: var(--danger);
  }
  /* ── Review Card Highlight (keyboard shortcuts) ──── */
  .review-card-highlight {
    border: 2px solid var(--blue) !important;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.08), var(--shadow) !important;
    background: color-mix(in srgb, var(--surface) 98%, var(--blue)) !important;
  }
`;

