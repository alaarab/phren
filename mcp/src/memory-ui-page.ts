import { WEB_UI_STYLES, renderWebUiScript } from "./memory-ui-assets.js";
import { renderGraphScript } from "./memory-ui-graph.js";
import { readSyncSnapshot } from "./memory-ui-data.js";
import { PROJECT_REFERENCE_UI_STYLES, SETTINGS_TAB_UI_STYLES, TASK_UI_STYLES } from "./memory-ui-styles.js";
import {
  renderSkillUiEnhancementScript,
  renderProjectReferenceEnhancementScript,
  renderReviewQueueEditSyncScript,
  renderTasksAndSettingsScript,
  renderSearchScript,
  renderEventWiringScript,
} from "./memory-ui-scripts.js";

function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderWebUiPage(phrenPath: string, authToken?: string, nonce?: string): string {
  const sync = readSyncSnapshot(phrenPath) as {
    autoSaveStatus?: string;
    lastPullAt?: string;
    lastPullStatus?: string;
    lastPushAt?: string;
    lastPushStatus?: string;
    unsyncedCommits?: number;
  };

  const nonceAttr = nonce ? ` nonce="${h(nonce)}"` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.bunny.net" />
  <link href="https://fonts.bunny.net/css?family=inter:400,500,600,700&display=swap" rel="stylesheet" />
  <title>phren</title>
  <style>
${WEB_UI_STYLES}
${PROJECT_REFERENCE_UI_STYLES}
${SETTINGS_TAB_UI_STYLES}
${TASK_UI_STYLES}
  </style>
</head>
<body>

<div class="header">
  <div class="header-brand">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="hdr-brain" cx="45%" cy="40%" r="55%">
          <stop offset="0%" stop-color="#9B8BC4"/>
          <stop offset="50%" stop-color="#7B68AE"/>
          <stop offset="100%" stop-color="#5B4B8A"/>
        </radialGradient>
      </defs>
      <!-- brain body -->
      <ellipse cx="12" cy="12" rx="8" ry="7.5" fill="url(#hdr-brain)"/>
      <!-- brain folds -->
      <path d="M8 9.5c1.5-1 3-0.5 4 0s2.5 0.8 3.5-0.2" stroke="#5B4B8A" stroke-width="0.7" fill="none" stroke-linecap="round"/>
      <path d="M7.5 12c2 0.8 3.5 0.2 5-0.5s3 0 4 0.8" stroke="#5B4B8A" stroke-width="0.6" fill="none" stroke-linecap="round"/>
      <!-- eyes (dark diamonds) -->
      <path d="M9 11l0.8-0.8 0.8 0.8-0.8 0.8z" fill="#2D2255"/>
      <path d="M13.4 11l0.8-0.8 0.8 0.8-0.8 0.8z" fill="#2D2255"/>
      <!-- smile -->
      <path d="M10.5 13.5c0.5 0.4 1.2 0.5 2 0.1" stroke="#2D2255" stroke-width="0.5" fill="none" stroke-linecap="round"/>
      <!-- legs -->
      <rect x="9.5" y="18.5" width="1.5" height="2" rx="0.5" fill="#5B4B8A"/>
      <rect x="13" y="18.5" width="1.5" height="2" rx="0.5" fill="#5B4B8A"/>
      <!-- cyan sparkle -->
      <path d="M18 4l0.5 1.5L20 6l-1.5 0.5L18 8l-0.5-1.5L16 6l1.5-0.5z" fill="#00E5FF"/>
    </svg>
    <span style="letter-spacing:0.04em;font-weight:500">phren</span>
  </div>
  <nav class="nav">
    <button class="nav-item active" data-tab="projects">Projects</button>
    <button class="nav-item" data-tab="review">Review</button>
    <button class="nav-item" data-tab="search">Search</button>
    <button class="nav-item" data-tab="graph">Graph</button>
    <button class="nav-item" data-tab="tasks">Tasks</button>
    <button class="nav-item" data-tab="sessions">Sessions</button>
    <button class="nav-item" data-tab="skills">Skills</button>
    <button class="nav-item" data-tab="hooks">Hooks</button>
    <button class="nav-item" data-tab="settings">Settings</button>
  </nav>
  <span class="status-led status-led-ok" id="sync-led" title="phren is synced"></span>
  <button id="theme-toggle" title="Toggle dark mode" style="margin-left:auto;background:none;border:none;cursor:pointer;padding:8px;border-radius:6px;color:var(--muted);font-size:var(--text-md);line-height:1;transition:color .15s" aria-label="Toggle dark mode">☀️</button>
  <button id="cmdpal-open-btn" title="Search projects (⌘K)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 12px;border-radius:6px;color:var(--muted);font-size:var(--text-sm);font-family:var(--font);transition:color .15s,border-color .15s" class="cmdpal-trigger">⌘K</button>
</div>

<div class="main">
  <!-- ── Projects Tab ──────────────────────────────────────── -->
  <div id="tab-projects" class="tab-content active">
    <input type="text" id="projects-search" placeholder="Search projects..." class="projects-search" />
    <div class="projects-grid" id="projects-grid">
      <div style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center"><svg viewBox="0 0 32 32" width="32" height="32" style="display:block;margin:0 auto 12px"><ellipse cx="16" cy="16" rx="10" ry="9.5" fill="#7B68AE" opacity="0.5"/><path d="M12 15l1-1 1 1-1 1z" fill="#2D2255"/><path d="M18 15l1-1 1 1-1 1z" fill="#2D2255"/><path d="M14 18c0.7 0.5 1.6 0.6 2.6 0.1" stroke="#2D2255" stroke-width="0.6" fill="none"/></svg>Loading projects...</div>
    </div>
    <div id="project-detail-area"></div>
  </div>

  <!-- ── Review Tab ────────────────────────────────────────── -->
  <div id="tab-review" class="tab-content">
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><h2>Sync State</h2></div>
      <div class="card-body">
        <div id="sync-state-summary" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;font-size:var(--text-base)">
          <div><strong>Auto-save</strong><div class="text-muted">${h(sync.autoSaveStatus || "n/a")}</div></div>
          <div><strong>Last pull</strong><div class="text-muted">${h(sync.lastPullStatus || "n/a")} ${h(sync.lastPullAt || "")}</div></div>
          <div><strong>Last push</strong><div class="text-muted">${h(sync.lastPushStatus || "n/a")} ${h(sync.lastPushAt || "")}</div></div>
          <div><strong>Unsynced commits</strong><div class="text-muted">${h(String(sync.unsyncedCommits || 0))}</div></div>
        </div>
      </div>
    </div>
    <details class="review-help" style="margin-bottom:16px">
      <summary>Help: How the Review Queue works</summary>
      <dl>
        <dt>What is the Review Queue?</dt>
        <dd>Fragments flagged by governance for human review. Items accumulate here when <code>phren maintain govern</code> is run.</dd>
        <dt>Can I approve, reject, or edit items here?</dt>
        <dd>No. The web UI review queue is read-only and exists for inspection only.</dd>
        <dt>How do I clear items?</dt>
        <dd>Use maintenance flows such as <code>phren maintain prune</code>, or update the underlying findings/tasks directly.</dd>
        <dt>Is this automatic?</dt>
        <dd>No. Agents do not auto-accept review-queue items.</dd>
        <dt>How do items get here?</dt>
        <dd><code>phren maintain govern</code> flags stale or low-confidence fragments for review.</dd>
        <dt>How to reduce noise?</dt>
        <dd>Run <code>phren maintain prune</code> to auto-remove expired items without manual review.</dd>
      </dl>
    </details>

    <p style="font-size:var(--text-sm);color:var(--muted);margin-bottom:12px;letter-spacing:-0.01em">Fragments flagged for review. Inspect them here; the web UI does not mutate queue items.</p>

    <div id="review-summary-banner" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center"></div>

    <div class="review-filters" id="review-filters" style="display:none">
      <select id="review-filter-project">
        <option value="">All projects</option>
      </select>
      <select id="review-filter-machine">
        <option value="">All machines</option>
      </select>
      <select id="review-filter-model">
        <option value="">All models</option>
      </select>
      <span id="review-filter-count" class="text-muted" style="font-size:var(--text-sm);margin-left:8px"></span>
      <button class="btn btn-sm" id="highlight-only-btn" style="margin-left:auto">Flagged only</button>
    </div>

    <div id="review-kbd-hints" style="font-size:var(--text-xs);color:var(--muted);margin-bottom:12px;display:none;gap:16px;flex-wrap:wrap">
      <span><kbd>j</kbd>/<kbd>k</kbd> navigate</span>
    </div>

    <div class="review-cards" id="review-cards-list">
      <div class="review-cards-loading" style="text-align:center;padding:40px;color:var(--muted)">Loading...</div>
    </div>

    <div class="panes">
      <div class="card">
        <div class="card-header"><h2>Recently Accepted</h2></div>
        <div class="card-body"><ul id="accepted-list"><li style="color:var(--muted)">Loading...</li></ul></div>
      </div>
      <div class="card">
        <div class="card-header"><h2>Recently Used</h2></div>
        <div class="card-body"><ul id="usage-list"><li style="color:var(--muted)">Loading...</li></ul></div>
      </div>
    </div>
  </div>

  <!-- ── Search Tab ────────────────────────────────────────── -->
  <div id="tab-search" class="tab-content">
    <div style="max-width:720px;margin:0 auto">
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input type="text" id="search-query" placeholder="Search fragments, findings, tasks..." style="flex:1;border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;background:var(--surface);color:var(--ink);font-size:var(--text-base);font-family:var(--font);outline:none" />
        <select id="search-project-filter" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm)">
          <option value="">All projects</option>
        </select>
        <select id="search-type-filter" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm)">
          <option value="">All types</option>
          <option value="finding">Findings</option>
          <option value="task">Tasks</option>
          <option value="reference">Reference</option>
          <option value="summary">Summaries</option>
        </select>
        <button id="search-btn" style="border:1px solid var(--accent);border-radius:var(--radius-sm);padding:6px 16px;background:var(--accent);color:#fff;font-size:var(--text-sm);cursor:pointer;font-family:var(--font)">Search</button>
      </div>
      <div id="search-status" class="text-muted" style="font-size:var(--text-sm);margin-bottom:12px"></div>
      <div id="search-results">
        <div style="padding:40px;color:var(--muted);text-align:center">Enter a query to search across all your fragments and findings.</div>
      </div>
    </div>
  </div>

  <!-- ── Graph Tab ─────────────────────────────────────────── -->
  <div id="tab-graph" class="tab-content">
    <div class="graph-container">
      <canvas id="graph-canvas"></canvas>
      <div class="graph-tooltip" id="graph-tooltip"></div>
      <div class="graph-controls">
        <button id="graph-zoom-in" title="Zoom in">+</button>
        <button id="graph-zoom-out" title="Zoom out">-</button>
        <button id="graph-reset" title="Reset view">R</button>
      </div>
      <div class="graph-filters">
        <div class="graph-filter" id="graph-filter"></div>
        <div class="graph-filter" id="graph-project-filter"></div>
        <div class="graph-filter" id="graph-limit-row" style="align-items:center;gap:8px"></div>
      </div>
      <!-- legend removed: colors explained in Filters dropdown -->
    </div>
    <div id="graph-detail-panel" class="card" style="margin-top:16px">
      <div class="card-header">
        <h2>Selected Bubble</h2>
        <span id="graph-detail-meta" class="text-muted" style="font-size:var(--text-sm)">Click a bubble to inspect it.</span>
      </div>
      <div class="card-body" id="graph-detail-body" style="display:flex;flex-direction:column;gap:12px">
        <p class="text-muted" style="margin:0">Use the graph filters, then click a project or finding bubble to pin its details here.</p>
      </div>
    </div>
  </div>

  <!-- ── Skills Tab ────────────────────────────────────────── -->
  <div id="tab-skills" class="tab-content">
    <div class="split-view">
      <div class="split-sidebar" id="skills-list">
        <div style="padding:20px;color:var(--muted)">Loading...</div>
      </div>
      <div class="split-reader" id="skills-reader">
        <div class="reader-empty">Select a skill to view its contents.</div>
      </div>
    </div>
  </div>

  <!-- ── Hooks Tab ─────────────────────────────────────────── -->
  <div id="tab-hooks" class="tab-content">
    <div class="split-view">
      <div class="split-sidebar" id="hooks-list">
        <div style="padding:20px;color:var(--muted)">Loading...</div>
      </div>
      <div class="split-reader" id="hooks-reader">
        <div class="reader-empty">Select a hook config to view its contents.</div>
      </div>
    </div>
  </div>

  <!-- ── Tasks Tab ─────────────────────────────────────────── -->
  <div id="tab-tasks" class="tab-content">
    <div class="task-toolbar">
      <select id="tasks-filter-project" class="task-filter-select">
        <option value="">All projects</option>
      </select>
      <select id="tasks-filter-section" class="task-filter-select">
        <option value="">Active + Queue</option>
        <option value="Active">Active only</option>
        <option value="Queue">Queue only</option>
        <option value="Done">Completed</option>
      </select>
      <span id="tasks-count" class="task-count-label"></span>
    </div>
    <div id="tasks-list">
      <div class="task-empty-state"><svg viewBox="0 0 48 48" width="64" height="64" style="display:block;margin:0 auto 16px"><ellipse cx="24" cy="24" rx="16" ry="15" fill="#7B68AE" opacity="0.25"/><ellipse cx="24" cy="24" rx="12" ry="11.5" fill="#7B68AE" opacity="0.4"/><circle cx="19" cy="22" r="1.5" fill="#2D2255"/><circle cx="29" cy="22" r="1.5" fill="#2D2255"/><path d="M21 28c1 1.2 2.5 1.5 3.5 1.3 1-.2 2-1 2.5-1.3" stroke="#2D2255" stroke-width="1" fill="none" stroke-linecap="round"/></svg><div style="font-size:var(--text-md);font-weight:600;color:var(--ink)">Loading tasks...</div></div>
    </div>
  </div>

  <!-- ── Sessions Tab ──────────────────────────────────────── -->
  <div id="tab-sessions" class="tab-content">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <select id="sessions-filter-project" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm)">
        <option value="">All projects</option>
      </select>
      <span id="sessions-count" class="text-muted" style="font-size:var(--text-sm);margin-left:auto"></span>
    </div>
    <div id="sessions-list">
      <div style="padding:40px;color:var(--muted);text-align:center"><svg viewBox="0 0 32 32" width="32" height="32" style="display:block;margin:0 auto 12px"><ellipse cx="16" cy="16" rx="10" ry="9.5" fill="#7B68AE" opacity="0.5"/><path d="M12 15l1-1 1 1-1 1z" fill="#2D2255"/><path d="M18 15l1-1 1 1-1 1z" fill="#2D2255"/><path d="M14 18c0.7 0.5 1.6 0.6 2.6 0.1" stroke="#2D2255" stroke-width="0.6" fill="none"/></svg>Loading sessions...</div>
    </div>
    <div id="session-detail" style="display:none"></div>
  </div>

  <!-- ── Settings Tab ───────────────────────────────────────── -->
  <div id="tab-settings" class="tab-content">
    <div class="settings-shell">
      <div id="settings-status-inline" class="settings-status-inline" aria-live="polite"></div>
      <section class="settings-section" style="border-top:3px solid color-mix(in srgb, var(--cyan) 45%, var(--border))">
        <div class="settings-section-header" style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <span>Scope</span>
          <select id="settings-project-select" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm);font-family:var(--font)">
            <option value="">Global (all projects)</option>
          </select>
        </div>
        <div class="settings-section-body" style="padding:12px 18px">
          <div id="settings-scope-note" style="font-size:var(--text-sm);color:var(--muted)">Showing global settings. Select a project to view and edit per-project overrides.</div>
        </div>
      </section>
      <section class="settings-section settings-section-findings">
        <div class="settings-section-header">Findings</div>
        <div class="settings-section-body">
          <div id="settings-findings" style="color:var(--muted)">Loading...</div>
        </div>
      </section>
      <section class="settings-section settings-section-behavior">
        <div class="settings-section-header">Behavior</div>
        <div class="settings-section-body">
          <div id="settings-behavior" style="color:var(--muted)">Loading...</div>
        </div>
      </section>
      <section class="settings-section" style="border-top:3px solid color-mix(in srgb, var(--warning) 45%, var(--border))">
        <div class="settings-section-header">Retention Policy</div>
        <div class="settings-section-body">
          <div id="settings-retention" style="color:var(--muted)">Loading...</div>
        </div>
      </section>
      <section class="settings-section" style="border-top:3px solid color-mix(in srgb, var(--success) 45%, var(--border))">
        <div class="settings-section-header">Workflow Policy</div>
        <div class="settings-section-body">
          <div id="settings-workflow" style="color:var(--muted)">Loading...</div>
        </div>
      </section>
      <section class="settings-section settings-section-integrations">
        <div class="settings-section-header">Integrations</div>
        <div class="settings-section-body">
          <div id="settings-integrations" style="color:var(--muted)">Loading...</div>
        </div>
      </section>
    </div>
  </div>
</div>

<div class="toast-container" id="toast-container"></div>

<div class="cmdpal-overlay" id="cmdpal">
  <div class="cmdpal-box" id="cmdpal-box">
    <input class="cmdpal-input" id="cmdpal-input" placeholder="Search projects..." autocomplete="off" />
    <div class="cmdpal-results" id="cmdpal-results"></div>
  </div>
</div>

<script${nonceAttr}>
${renderWebUiScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderGraphScript()}
</script>
<script${nonceAttr}>
${renderReviewQueueEditSyncScript()}
</script>
<script${nonceAttr}>
${renderSkillUiEnhancementScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderProjectReferenceEnhancementScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderTasksAndSettingsScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderSearchScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderEventWiringScript()}
</script>
</body>
</html>`;
}

export function renderPageForTests(phrenPath: string, _csrfToken?: string, authToken?: string): string {
  return renderWebUiPage(phrenPath, authToken, "test-nonce");
}
