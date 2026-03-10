import { REVIEW_UI_STYLES, renderReviewUiScript } from "./memory-ui-assets.js";
import { readSyncSnapshot } from "./memory-ui-data.js";

function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSkillUiEnhancementScript(authToken: string): string {
  return `(function() {
    var _skillAuthToken = '${authToken}';
    var _skillCurrent = null;
    var _skillEditing = false;

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function authUrl(base) {
      return base + (base.indexOf('?') === -1 ? '?' : '&') + '_auth=' + encodeURIComponent(_skillAuthToken);
    }
    function authBody(body) {
      return body + (_skillAuthToken ? '&_auth=' + encodeURIComponent(_skillAuthToken) : '');
    }
    function fetchCsrfToken(cb) {
      var url = '/api/csrf-token' + (_skillAuthToken ? '?_auth=' + encodeURIComponent(_skillAuthToken) : '');
      fetch(url).then(function(r) { return r.json(); }).then(function(d) { cb(d.token || null); }).catch(function() { cb(null); });
    }
    function renderSkillReader(content) {
      var reader = document.getElementById('skills-reader');
      if (!_skillCurrent || !reader) return;
      var statusBadge = '<span class="badge ' + (_skillCurrent.enabled ? 'badge-on' : 'badge-off') + '" id="skill-enabled-badge">' + (_skillCurrent.enabled ? 'enabled' : 'disabled') + '</span>';
      var toggleLabel = _skillCurrent.enabled ? 'Disable' : 'Enable';
      reader.innerHTML =
        '<div class="reader-toolbar">' +
          '<span class="reader-title">' + esc(_skillCurrent.name) + '</span>' +
          '<span class="reader-path">' + esc(_skillCurrent.path) + '</span>' +
          statusBadge +
          '<span id="skill-status"></span>' +
          '<button class="btn btn-sm" onclick="cortexToggleSkill()">' + toggleLabel + '</button>' +
          '<button class="btn btn-sm" onclick="cortexEditSkill()">Edit</button>' +
        '</div>' +
        '<div class="reader-content"><pre id="skill-pre">' + esc(content) + '</pre></div>';
    }
    function loadSkills(selectPath) {
      fetch(authUrl('/api/skills')).then(function(r) { return r.json(); }).then(function(data) {
        var list = document.getElementById('skills-list');
        if (!list) return;
        if (!data.length) {
          list.innerHTML = '<div style="padding:40px 20px;color:var(--muted);text-align:center">No skills installed</div>';
          return;
        }
        var bySource = {};
        data.forEach(function(s) { (bySource[s.source] = bySource[s.source] || []).push(s); });
        var html = '';
        Object.keys(bySource).sort().forEach(function(src) {
          html += '<div class="split-group-label">' + esc(src) + '</div>';
          bySource[src].forEach(function(s) {
            html += '<div class="split-item" data-path="' + esc(s.path) + '" data-name="' + esc(s.name) + '" data-source="' + esc(s.source) + '" data-enabled="' + (s.enabled ? 'true' : 'false') + '" onclick="cortexSelectSkillFromEl(this)">' +
              '<span>' + esc(s.name) + '</span>' +
              '<span class="badge ' + (s.enabled ? 'badge-on' : 'badge-off') + '">' + (s.enabled ? 'enabled' : 'disabled') + '</span>' +
            '</div>';
          });
        });
        list.innerHTML = html;
        if (selectPath) {
          var current = list.querySelector('.split-item[data-path="' + CSS.escape(selectPath) + '"]');
          if (current) current.click();
        }
      });
    }
    window.cortexSelectSkillFromEl = function(el) {
      if (!el) return;
      window.cortexSelectSkill(
        el.getAttribute('data-path') || '',
        el.getAttribute('data-name') || '',
        el.getAttribute('data-source') || '',
        el.getAttribute('data-enabled') === 'true',
        el
      );
    };
    window.cortexSelectSkill = function(filePath, name, source, enabled, el) {
      if (_skillEditing && !confirm('Discard unsaved changes?')) return;
      _skillEditing = false;
      _skillCurrent = { path: filePath, name: name, source: source, enabled: enabled };
      document.querySelectorAll('#skills-list .split-item').forEach(function(i) { i.classList.remove('selected'); });
      if (el) el.classList.add('selected');
      var reader = document.getElementById('skills-reader');
      if (reader) reader.innerHTML = '<div class="reader-empty">Loading...</div>';
      fetch(authUrl('/api/skill-content?path=' + encodeURIComponent(filePath))).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) {
          if (reader) reader.innerHTML = '<div class="reader-empty">' + esc(data.error || 'Error loading file') + '</div>';
          return;
        }
        renderSkillReader(data.content);
      });
    };
    window.cortexEditSkill = function() {
      var pre = document.getElementById('skill-pre');
      if (!pre || !_skillCurrent) return;
      _skillEditing = true;
      var content = pre.textContent || '';
      var toolbar = document.querySelector('#skills-reader .reader-toolbar');
      if (!toolbar) return;
      Array.from(toolbar.querySelectorAll('.btn')).forEach(function(btn) { btn.remove(); });
      toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-primary" onclick="cortexSaveSkill()">Save</button><button class="btn btn-sm" onclick="cortexCancelSkillEdit()">Cancel</button>');
      var ta = document.createElement('textarea');
      ta.id = 'skill-textarea';
      ta.value = content;
      pre.replaceWith(ta);
      ta.focus();
    };
    window.cortexCancelSkillEdit = function() {
      _skillEditing = false;
      if (_skillCurrent) window.cortexSelectSkill(_skillCurrent.path, _skillCurrent.name, _skillCurrent.source, _skillCurrent.enabled);
    };
    window.cortexSaveSkill = function() {
      var ta = document.getElementById('skill-textarea');
      if (!ta || !_skillCurrent) return;
      fetchCsrfToken(function(csrfToken) {
        var csrfPart = csrfToken ? '&_csrf=' + encodeURIComponent(csrfToken) : '';
        fetch('/api/skill-save', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authBody('path=' + encodeURIComponent(_skillCurrent.path) + '&content=' + encodeURIComponent(ta.value)) + csrfPart,
        }).then(function(r) { return r.json(); }).then(function(data) {
          var status = document.getElementById('skill-status');
          if (status) {
            status.textContent = data.ok ? 'Saved' : (data.error || 'Save failed');
            status.className = data.ok ? 'text-success' : 'text-danger';
          }
          if (data.ok) {
            _skillEditing = false;
            renderSkillReader(ta.value);
          }
        });
      });
    };
    window.cortexToggleSkill = function() {
      if (!_skillCurrent) return;
      fetchCsrfToken(function(csrfToken) {
        var csrfPart = csrfToken ? '&_csrf=' + encodeURIComponent(csrfToken) : '';
        var nextEnabled = !_skillCurrent.enabled;
        fetch('/api/skill-toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authBody('project=' + encodeURIComponent(_skillCurrent.source) + '&name=' + encodeURIComponent(_skillCurrent.name) + '&enabled=' + encodeURIComponent(String(nextEnabled))) + csrfPart,
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (!data.ok) return;
          _skillCurrent.enabled = nextEnabled;
          loadSkills(_skillCurrent.path);
          window.cortexSelectSkill(_skillCurrent.path, _skillCurrent.name, _skillCurrent.source, _skillCurrent.enabled);
        });
      });
    };
    var baseSwitchTab = window.switchTab;
    if (typeof baseSwitchTab === 'function') {
      window.switchTab = function(tab) {
        baseSwitchTab(tab);
        if (tab === 'skills') setTimeout(function() { loadSkills(_skillCurrent && _skillCurrent.path); }, 0);
      };
    }
  })();`;
}

export function renderReviewUiPage(cortexPath: string, authToken?: string): string {
  const sync = readSyncSnapshot(cortexPath) as {
    autoSaveStatus?: string;
    lastPullAt?: string;
    lastPullStatus?: string;
    lastPushAt?: string;
    lastPushStatus?: string;
    unsyncedCommits?: number;
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.bunny.net" />
  <link href="https://fonts.bunny.net/css?family=inter:400,500,600,700&display=swap" rel="stylesheet" />
  <title>Cortex Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
  <style>
${REVIEW_UI_STYLES}
  </style>
</head>
<body>

<div class="header">
  <div class="header-brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
      <path d="M2 12h20"/>
    </svg>
    Cortex
  </div>
  <nav class="nav">
    <button class="nav-item active" onclick="switchTab('projects')">Projects</button>
    <button class="nav-item" onclick="switchTab('review')">Review</button>
    <button class="nav-item" onclick="switchTab('graph')">Graph</button>
    <button class="nav-item" onclick="switchTab('skills')">Skills</button>
    <button class="nav-item" onclick="switchTab('hooks')">Hooks</button>
  </nav>
  <span class="status-led status-led-ok" id="sync-led" title="Synced"></span>
  <button id="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode" style="margin-left:auto;background:none;border:none;cursor:pointer;padding:8px;border-radius:6px;color:var(--muted);font-size:var(--text-md);line-height:1;transition:color .15s" aria-label="Toggle dark mode">☀️</button>
  <button onclick="openCmdPal()" title="Search projects (⌘K)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 12px;border-radius:6px;color:var(--muted);font-size:var(--text-sm);font-family:var(--font);transition:color .15s,border-color .15s" onmouseover="this.style.color='var(--ink)';this.style.borderColor='var(--muted)'" onmouseout="this.style.color='var(--muted)';this.style.borderColor='var(--border)'">⌘K</button>
</div>

<div class="main">
  <!-- ── Projects Tab ──────────────────────────────────────── -->
  <div id="tab-projects" class="tab-content active">
    <input type="text" id="projects-search" placeholder="Search projects..." oninput="filterProjects(this.value)" class="projects-search" />
    <div class="projects-grid" id="projects-grid">
      <div style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center">Loading projects...</div>
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
        <dd>Memories flagged by governance for human review. Items accumulate here when <code>cortex maintain govern</code> is run.</dd>
        <dt>What does Approve do?</dt>
        <dd>Keeps the memory and marks it as reviewed. It stays in your project findings.</dd>
        <dt>What does Reject do?</dt>
        <dd>Permanently removes the memory from your project.</dd>
        <dt>Is this automatic?</dt>
        <dd>No. Agents do not auto-approve. You review each item manually.</dd>
        <dt>How do items get here?</dt>
        <dd><code>cortex maintain govern</code> flags stale or low-confidence memories for review.</dd>
        <dt>How to clear the queue faster?</dt>
        <dd>Run <code>cortex maintain prune</code> to auto-remove expired items without manual review.</dd>
      </dl>
    </details>

    <p style="font-size:var(--text-sm);color:var(--muted);margin-bottom:12px;letter-spacing:-0.01em">Memories flagged for review. Approve to keep, reject to discard.</p>

    <div class="review-filters" id="review-filters" style="display:none">
      <select id="review-filter-project" onchange="filterReviewCards()">
        <option value="">All projects</option>
      </select>
      <select id="review-filter-machine" onchange="filterReviewCards()">
        <option value="">All machines</option>
      </select>
      <select id="review-filter-model" onchange="filterReviewCards()">
        <option value="">All models</option>
      </select>
      <span id="review-filter-count" class="text-muted" style="font-size:var(--text-sm);margin-left:8px"></span>
    </div>

    <div id="review-kbd-hints" style="font-size:var(--text-xs);color:var(--muted);margin-bottom:12px;display:none;gap:16px;flex-wrap:wrap">
      <span><kbd>j</kbd>/<kbd>k</kbd> navigate</span>
      <span><kbd>a</kbd> approve</span>
      <span><kbd>r</kbd> reject</span>
      <span><kbd>e</kbd> edit</span>
    </div>

    <label class="review-select-all" id="review-select-all" style="display:none">
      <input type="checkbox" onchange="toggleSelectAll(this.checked)" />
      Select all
    </label>

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

  <!-- ── Graph Tab ─────────────────────────────────────────── -->
  <div id="tab-graph" class="tab-content">
    <div class="graph-container">
      <canvas id="graph-canvas"></canvas>
      <div class="graph-tooltip" id="graph-tooltip"></div>
      <div class="graph-controls">
        <button onclick="graphZoom(1.2)" title="Zoom in">+</button>
        <button onclick="graphZoom(0.8)" title="Zoom out">-</button>
        <button onclick="graphReset()" title="Reset view">R</button>
      </div>
      <div class="graph-filters">
        <div class="graph-filter" id="graph-filter"></div>
        <div class="graph-filter" id="graph-project-filter"></div>
        <div class="graph-filter" id="graph-limit-row" style="align-items:center;gap:8px"></div>
      </div>
      <div class="graph-legend">
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#7c3aed"></span> Project</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#3b82f6"></span> Decision</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#ef4444"></span> Pitfall</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#10b981"></span> Pattern</span>
      </div>
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
</div>

<div class="batch-bar" id="batch-bar">
  <span class="batch-bar-count" id="batch-count">0 selected</span>
  <button class="btn btn-sm btn-approve" onclick="batchAction('approve')">Approve All</button>
  <button class="btn btn-sm btn-reject" onclick="batchAction('reject')">Reject All</button>
  <button class="btn btn-sm" onclick="clearBatchSelection()">Cancel</button>
</div>

<div class="toast-container" id="toast-container"></div>

<div class="cmdpal-overlay" id="cmdpal" onclick="closeCmdPal(event)">
  <div class="cmdpal-box" onclick="event.stopPropagation()">
    <input class="cmdpal-input" id="cmdpal-input" placeholder="Search projects..." oninput="cmdpalSearch(this.value)" onkeydown="cmdpalKey(event)" autocomplete="off" />
    <div class="cmdpal-results" id="cmdpal-results"></div>
  </div>
</div>

<script>
${renderReviewUiScript(h(authToken || ""))}
</script>
<script>
${renderSkillUiEnhancementScript(h(authToken || ""))}
</script>
</body>
</html>`;
}

export function renderPageForTests(cortexPath: string, _csrfToken?: string, authToken?: string): string {
  return renderReviewUiPage(cortexPath, authToken);
}
