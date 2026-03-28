import { WEB_UI_STYLES, renderWebUiScript } from "./assets.js";
import { renderGraphScript } from "./graph.js";
import { PROJECT_REFERENCE_UI_STYLES, REVIEW_UI_STYLES, SETTINGS_TAB_UI_STYLES, TASK_UI_STYLES } from "./styles.js";
import {
  renderSharedWebUiHelpers,
  renderSkillUiEnhancementScript,
  renderProjectReferenceEnhancementScript,
  renderTasksAndSettingsScript,
  renderSearchScript,
  renderEventWiringScript,
  renderGraphHostScript,
} from "./scripts.js";

function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderWebUiPage(_phrenPath: string, authToken?: string, nonce?: string): string {
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
${REVIEW_UI_STYLES}
  </style>
</head>
<body>

<div class="header">
  <div class="header-brand">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="24" height="24" style="image-rendering:pixelated">
      <circle cx="32" cy="32" r="32" fill="#12122a"/>
      <g fill="rgb(103,226,248)"><rect x="44" y="12" width="4" height="4"/></g>
      <g fill="rgb(138,127,236)"><rect x="20" y="16" width="4" height="4"/></g>
      <g fill="rgb(150,144,247)"><rect x="24" y="16" width="4" height="4"/></g>
      <g fill="rgb(102,74,242)"><rect x="28" y="16" width="4" height="4"/></g>
      <g fill="rgb(168,165,249)"><rect x="32" y="16" width="4" height="4"/></g>
      <g fill="rgb(144,147,247)"><rect x="36" y="16" width="4" height="4"/></g>
      <g fill="rgb(119,108,251)"><rect x="40" y="16" width="4" height="4"/></g>
      <g fill="rgb(102,80,247)"><rect x="20" y="20" width="4" height="4"/></g>
      <g fill="rgb(105,77,249)"><rect x="24" y="20" width="4" height="4"/></g>
      <g fill="rgb(197,195,252)"><rect x="28" y="20" width="4" height="4"/></g>
      <g fill="rgb(154,148,247)"><rect x="32" y="20" width="4" height="4"/></g>
      <g fill="rgb(152,131,250)"><rect x="36" y="20" width="4" height="4"/></g>
      <g fill="rgb(151,145,249)"><rect x="40" y="20" width="4" height="4"/></g>
      <g fill="rgb(37,37,143)"><rect x="44" y="20" width="4" height="4"/></g>
      <g fill="rgb(84,63,227)"><rect x="16" y="24" width="4" height="4"/></g>
      <g fill="rgb(153,132,251)"><rect x="20" y="24" width="4" height="4"/></g>
      <g fill="rgb(154,143,249)"><rect x="24" y="24" width="4" height="4"/></g>
      <g fill="rgb(159,147,249)"><rect x="28" y="24" width="4" height="4"/></g>
      <g fill="rgb(93,76,236)"><rect x="32" y="24" width="4" height="4"/></g>
      <g fill="rgb(156,134,251)"><rect x="36" y="24" width="4" height="4"/></g>
      <g fill="rgb(154,137,248)"><rect x="40" y="24" width="4" height="4"/></g>
      <g fill="rgb(149,130,251)"><rect x="44" y="24" width="4" height="4"/></g>
      <g fill="rgb(34,37,124)"><rect x="12" y="28" width="4" height="4"/></g>
      <g fill="rgb(144,124,251)"><rect x="16" y="28" width="4" height="4"/></g>
      <g fill="rgb(150,132,250)"><rect x="20" y="28" width="4" height="4"/></g>
      <g fill="rgb(149,130,250)"><rect x="24" y="28" width="4" height="4"/></g>
      <g fill="rgb(153,137,252)"><rect x="28" y="28" width="4" height="4"/></g>
      <g fill="rgb(154,136,250)"><rect x="32" y="28" width="4" height="4"/></g>
      <g fill="rgb(154,138,250)"><rect x="36" y="28" width="4" height="4"/></g>
      <g fill="rgb(157,141,249)"><rect x="40" y="28" width="4" height="4"/></g>
      <g fill="rgb(82,62,230)"><rect x="44" y="28" width="4" height="4"/></g>
      <g fill="rgb(29,34,113)"><rect x="12" y="32" width="4" height="4"/></g>
      <g fill="rgb(21,32,104)"><rect x="16" y="32" width="4" height="4"/></g>
      <g fill="rgb(146,127,251)"><rect x="20" y="32" width="4" height="4"/></g>
      <g fill="rgb(157,145,248)"><rect x="24" y="32" width="4" height="4"/></g>
      <g fill="rgb(20,31,101)"><rect x="28" y="32" width="4" height="4"/></g>
      <g fill="rgb(152,138,249)"><rect x="32" y="32" width="4" height="4"/></g>
      <g fill="rgb(154,141,248)"><rect x="36" y="32" width="4" height="4"/></g>
      <g fill="rgb(78,62,218)"><rect x="40" y="32" width="4" height="4"/></g>
      <g fill="rgb(124,107,250)"><rect x="44" y="32" width="4" height="4"/></g>
      <g fill="rgb(38,41,148)"><rect x="48" y="32" width="4" height="4"/></g>
      <g fill="rgb(147,129,252)"><rect x="16" y="36" width="4" height="4"/></g>
      <g fill="rgb(147,125,251)"><rect x="20" y="36" width="4" height="4"/></g>
      <g fill="rgb(147,127,251)"><rect x="24" y="36" width="4" height="4"/></g>
      <g fill="rgb(149,131,251)"><rect x="28" y="36" width="4" height="4"/></g>
      <g fill="rgb(120,104,251)"><rect x="32" y="36" width="4" height="4"/></g>
      <g fill="rgb(121,109,252)"><rect x="36" y="36" width="4" height="4"/></g>
      <g fill="rgb(109,90,247)"><rect x="40" y="36" width="4" height="4"/></g>
      <g fill="rgb(113,92,249)"><rect x="44" y="36" width="4" height="4"/></g>
      <g fill="rgb(97,88,247)"><rect x="20" y="40" width="4" height="4"/></g>
      <g fill="rgb(96,85,243)"><rect x="24" y="40" width="4" height="4"/></g>
      <g fill="rgb(71,58,216)"><rect x="28" y="40" width="4" height="4"/></g>
      <g fill="rgb(90,71,238)"><rect x="32" y="40" width="4" height="4"/></g>
      <g fill="rgb(115,103,249)"><rect x="36" y="40" width="4" height="4"/></g>
      <g fill="rgb(80,61,228)"><rect x="40" y="40" width="4" height="4"/></g>
      <g fill="rgb(16,18,94)"><rect x="44" y="40" width="4" height="4"/></g>
      <g fill="rgb(69,52,218)"><rect x="24" y="44" width="4" height="4"/></g>
      <g fill="rgb(17,28,102)"><rect x="32" y="44" width="4" height="4"/></g>
      <g fill="rgb(20,31,99)"><rect x="36" y="44" width="4" height="4"/></g>
      <g fill="rgb(160,163,251)"><rect x="20" y="48" width="4" height="4"/></g>
      <g fill="rgb(34,34,140)"><rect x="24" y="48" width="4" height="4"/></g>
      <g fill="rgb(159,159,250)"><rect x="28" y="48" width="4" height="4"/></g>
      <g fill="rgb(26,36,133)"><rect x="32" y="48" width="4" height="4"/></g>
      <g fill="rgb(26,41,132)"><rect x="36" y="48" width="4" height="4"/></g>
      <g fill="rgb(159,165,249)"><rect x="40" y="48" width="4" height="4"/></g>
    </svg>
    <span style="letter-spacing:0.04em;font-weight:500">phren</span>
  </div>
  <nav class="nav">
    <button class="nav-item active" data-tab="projects">Projects</button>
    <button class="nav-item" data-tab="review">Review</button>
    <button class="nav-item" data-tab="search">Search</button>
    <button class="nav-item" data-tab="graph">Graph</button>
    <button class="nav-item" data-tab="tasks">Tasks</button>
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
    <div class="review-toolbar" id="review-filters" style="display:none">
      <select id="review-filter-project">
        <option value="">All projects</option>
      </select>
      <label class="review-flagged-toggle" id="review-flagged-toggle">
        <input type="checkbox" id="highlight-only-btn" />
        <span>Flagged only</span>
      </label>
      <span id="review-filter-count" class="text-muted" style="font-size:var(--text-sm);margin-left:auto"></span>
      <label id="review-select-all" style="display:none;align-items:center;gap:6px;font-size:var(--text-sm);color:var(--muted);cursor:pointer;user-select:none">
        <input type="checkbox" id="review-select-all-cb" style="width:14px;height:14px;cursor:pointer;accent-color:var(--accent)" />
        Select all
      </label>
      <span id="review-sync-status" class="review-sync-dot" title="Sync status">
        <span class="review-sync-indicator" id="review-sync-indicator"></span>
      </span>
    </div>

    <div id="batch-bar" class="batch-bar">
      <span id="batch-count" class="batch-bar-count"></span>
      <button class="btn btn-sm btn-approve" data-batch-action="approve">Approve selected</button>
      <button class="btn btn-sm btn-reject" data-batch-action="reject">Reject selected</button>
      <button class="btn btn-sm" data-batch-action="clear">Clear</button>
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
        <div id="search-project-wrap" style="position:relative">
          <button id="search-project-btn" type="button" onclick="window._phrenToggleProjectDropdown()" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm);cursor:pointer;font-family:var(--font);min-width:120px;text-align:left;white-space:nowrap">All projects</button>
          <div id="search-project-dropdown" style="display:none;position:absolute;top:100%;left:0;z-index:50;margin-top:4px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:0 4px 12px rgba(0,0,0,.15);max-height:240px;overflow-y:auto;min-width:160px"></div>
        </div>
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
      <div id="graph-canvas" aria-label="Knowledge graph"></div>
      <div class="graph-tooltip" id="graph-tooltip"></div>
      <div class="graph-controls">
        <button id="graph-zoom-in" title="Zoom in">+</button>
        <button id="graph-zoom-out" title="Zoom out">-</button>
        <button id="graph-reset" title="Reset view">R</button>
        <button id="graph-reset-layout" title="Re-run layout">L</button>
      </div>
      <div class="graph-filters">
        <div class="graph-filter" id="graph-filter"></div>
        <div class="graph-filter" id="graph-project-filter"></div>
        <div class="graph-filter" id="graph-limit-row" style="align-items:center;gap:8px"></div>
      </div>
      <div id="graph-node-popover" style="display:none;position:absolute;left:0;top:0;z-index:12;max-width:min(440px,calc(100% - 24px));pointer-events:none">
        <div id="graph-node-popover-card" class="card" style="pointer-events:auto;position:relative;box-shadow:var(--shadow-lg);border:1px solid var(--border);background:color-mix(in srgb, var(--surface) 96%, transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)">
          <button id="graph-node-close" type="button" aria-label="Close selected node" title="Close" style="position:absolute;top:10px;right:10px;width:38px;height:38px;border-radius:999px;border:1px solid var(--border);background:var(--surface-raised);color:var(--ink);cursor:pointer;font-size:20px;line-height:1;display:grid;place-items:center">×</button>
          <div id="graph-node-content" style="padding:18px 18px 16px 18px"></div>
        </div>
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
        <div class="reader-empty">Select a hook config to view its contents.<br/><span style="font-size:var(--text-sm);color:var(--muted);margin-top:8px;display:inline-block">Per-project hooks can also be configured in Settings &gt; [project name].</span></div>
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
      <div class="task-empty-state"><svg viewBox="0 0 48 48" width="48" height="48" style="display:block;margin:0 auto 12px"><ellipse cx="24" cy="24" rx="16" ry="15" fill="#7B68AE" opacity="0.25"/><ellipse cx="24" cy="24" rx="12" ry="11.5" fill="#7B68AE" opacity="0.4"/><circle cx="19" cy="22" r="1.5" fill="#2D2255"/><circle cx="29" cy="22" r="1.5" fill="#2D2255"/><path d="M21 28c1 1.2 2.5 1.5 3.5 1.3 1-.2 2-1 2.5-1.3" stroke="#2D2255" stroke-width="1" fill="none" stroke-linecap="round"/></svg><div style="font-size:var(--text-md);font-weight:600;color:var(--ink)">Loading tasks...</div></div>
    </div>
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
      <section id="settings-project-info-section" class="settings-section" style="display:none;border-top:3px solid color-mix(in srgb, var(--accent) 45%, var(--border))">
        <div class="settings-section-header">Project Info</div>
        <div class="settings-section-body">
          <div id="settings-project-info" style="color:var(--muted)"></div>
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
${renderWebUiScript(authToken || "")}
</script>
<script${nonceAttr}>
${renderGraphScript()}
</script>
<script${nonceAttr}>
${renderGraphHostScript()}
</script>
<script${nonceAttr}>
${renderSharedWebUiHelpers(authToken || "")}
</script>
<script${nonceAttr}>
${renderSkillUiEnhancementScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderProjectReferenceEnhancementScript(h(authToken || ""))}
</script>
<script${nonceAttr}>
${renderTasksAndSettingsScript(authToken || "")}
</script>
<script${nonceAttr}>
${renderSearchScript(authToken || "")}
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
