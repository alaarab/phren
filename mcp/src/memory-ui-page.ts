import { WEB_UI_STYLES, renderWebUiScript } from "./memory-ui-assets.js";
import { renderGraphScript } from "./memory-ui-graph.js";
import { readSyncSnapshot } from "./memory-ui-data.js";

const PROJECT_REFERENCE_UI_STYLES = `
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

function renderProjectReferenceEnhancementScript(authToken: string): string {
  return `(function() {
    var _referenceAuthToken = '${authToken}';
    var _referenceState = {
      project: '',
      topicsData: null,
      referenceData: null,
      selectedType: '',
      selectedKey: '',
      editor: null
    };

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function authUrl(base) {
      return base + (base.indexOf('?') === -1 ? '?' : '&') + '_auth=' + encodeURIComponent(_referenceAuthToken);
    }
    function authBody(body) {
      return body + (_referenceAuthToken ? '&_auth=' + encodeURIComponent(_referenceAuthToken) : '');
    }
    function fetchCsrfToken(cb) {
      var url = '/api/csrf-token' + (_referenceAuthToken ? '?_auth=' + encodeURIComponent(_referenceAuthToken) : '');
      fetch(url).then(function(r) { return r.json(); }).then(function(d) { cb(d.token || null); }).catch(function() { cb(null); });
    }
    function currentProject() {
      var selected = document.querySelector('.project-card.selected');
      return selected ? (selected.getAttribute('data-project') || '') : '';
    }
    function findTopic(slug) {
      var topics = (_referenceState.topicsData && _referenceState.topicsData.topics) || [];
      return topics.find(function(topic) { return topic.slug === slug; }) || null;
    }
    function findTopicDoc(slug) {
      var docs = (_referenceState.referenceData && _referenceState.referenceData.topicDocs) || [];
      return docs.find(function(doc) { return doc.slug === slug; }) || null;
    }
    function setStatus(message, type) {
      var el = document.getElementById('reference-status');
      if (!el) return;
      el.textContent = message || '';
      el.className = 'reference-status' + (type ? ' ' + type : '');
      if (message) setTimeout(function() {
        var live = document.getElementById('reference-status');
        if (live) { live.textContent = ''; live.className = 'reference-status'; }
      }, 3000);
    }
    function loadJson(url) {
      return fetch(authUrl(url)).then(function(r) { return r.json(); });
    }
    function readerToolbar(title, pathLabel, actionsHtml) {
      return '<div class="reader-toolbar">' +
        '<span class="reader-title">' + esc(title) + '</span>' +
        '<span class="reader-path">' + esc(pathLabel || '') + '</span>' +
        '<span id="reference-status" class="reference-status"></span>' +
        (actionsHtml || '') +
      '</div>';
    }
    function renderReferenceHome() {
      var reader = document.getElementById('reference-reader');
      if (!reader) return;
      var topicsData = _referenceState.topicsData || { source: 'default', topics: [], suggestions: [] };
      var banner = topicsData.source === 'default'
        ? '<div class="reference-banner">This project is using starter topics. Customize them so archived findings match the project domain instead of generic web-dev buckets.</div>'
        : '';
      reader.innerHTML = readerToolbar('Reference Topics', _referenceState.project, '<button class="btn btn-sm" onclick="cortexReferenceAddTopic()">Add topic</button><button class="btn btn-sm" onclick="cortexReferenceReclassify()">Reclassify archived findings</button>') +
        '<div class="topic-empty">' +
          banner +
          '<p>Select a topic doc or a reference file from the sidebar. Topic definitions live in <code>topic-config.json</code> and archive docs live under <code>reference/topics/</code>.</p>' +
        '</div>';
    }
    function renderTopicEditor(mode, topic, suggestion) {
      var reader = document.getElementById('reference-reader');
      if (!reader) return;
      var source = topic || suggestion || { slug: '', label: '', description: '', keywords: [] };
      var title = mode === 'edit' ? 'Edit topic' : 'Add topic';
      reader.innerHTML = readerToolbar(title, _referenceState.project, '<button class="btn btn-sm" onclick="cortexReferenceCancelEditor()">Cancel</button>') +
        '<div class="reader-content">' +
          '<form class="topic-editor" onsubmit="cortexReferenceSaveTopic(event)">' +
            '<label>Label<input id="topic-label-input" value="' + esc(source.label || '') + '" placeholder="Rendering" /></label>' +
            '<label>Slug<input id="topic-slug-input" value="' + esc(source.slug || '') + '" placeholder="rendering" /></label>' +
            '<label>Description<textarea id="topic-description-input" placeholder="What belongs in this topic?">' + esc(source.description || '') + '</textarea></label>' +
            '<label>Keywords<input id="topic-keywords-input" value="' + esc((source.keywords || []).join(', ')) + '" placeholder="shader, frame, gpu, lighting" /></label>' +
            '<div class="topic-editor-actions">' +
              '<button class="btn btn-primary" type="submit">Save</button>' +
              '<button class="btn btn-sm" type="button" onclick="cortexReferenceCancelEditor()">Cancel</button>' +
            '</div>' +
          '</form>' +
        '</div>';
    }
    function renderTopicSummary(slug) {
      var topic = findTopic(slug);
      var doc = findTopicDoc(slug);
      var reader = document.getElementById('reference-reader');
      if (!topic || !reader) return;
      var actions = '<button class="btn btn-sm" onclick="cortexReferenceAddTopic()">Add topic</button>' +
        '<button class="btn btn-sm" onclick="cortexReferenceReclassify()">Reclassify archived findings</button>' +
        '<button class="btn btn-sm" onclick="cortexReferenceEditTopic(\\'' + esc(topic.slug) + '\\')">Edit</button>';
      if (topic.slug !== 'general') actions += '<button class="btn btn-sm" onclick="cortexReferenceDeleteTopic(\\'' + esc(topic.slug) + '\\')">Delete</button>';
      if (!doc || !doc.exists) {
        reader.innerHTML = readerToolbar(topic.label, 'reference/topics/' + topic.slug + '.md', actions) +
          '<div class="topic-empty">' +
            '<p>No archived entries have landed here yet. Saving the topic created the bucket, but it stays empty until findings are archived or legacy topic docs are reclassified.</p>' +
            (topic.description ? '<p>' + esc(topic.description) + '</p>' : '') +
            ((topic.keywords || []).length ? '<div class="topic-keywords">' + topic.keywords.map(function(keyword) { return '<span class="topic-keyword">' + esc(keyword) + '</span>'; }).join('') + '</div>' : '') +
          '</div>';
        return;
      }
      reader.innerHTML = readerToolbar(topic.label, doc.file, actions) + '<div class="reader-content"><div class="reader-empty">Loading...</div></div>';
      loadJson('/api/project-reference-content?project=' + encodeURIComponent(_referenceState.project) + '&file=' + encodeURIComponent(doc.file)).then(function(data) {
        var liveReader = document.getElementById('reference-reader');
        if (!liveReader) return;
        if (!data.ok) {
          liveReader.innerHTML = readerToolbar(topic.label, doc.file, actions) + '<div class="reader-empty">' + esc(data.error || 'File not found') + '</div>';
          return;
        }
        liveReader.innerHTML = readerToolbar(topic.label, doc.file, actions) + '<div class="reader-content"><pre>' + esc(data.content) + '</pre></div>';
      });
    }
    function renderReferenceFile(file) {
      var reader = document.getElementById('reference-reader');
      if (!reader) return;
      var actions = '<button class="btn btn-sm" onclick="cortexReferenceAddTopic()">Add topic</button><button class="btn btn-sm" onclick="cortexReferenceReclassify()">Reclassify archived findings</button>';
      reader.innerHTML = readerToolbar(file.title || file.file, file.file, actions) + '<div class="reader-content"><div class="reader-empty">Loading...</div></div>';
      loadJson('/api/project-reference-content?project=' + encodeURIComponent(_referenceState.project) + '&file=' + encodeURIComponent(file.file)).then(function(data) {
        var liveReader = document.getElementById('reference-reader');
        if (!liveReader) return;
        if (!data.ok) {
          liveReader.innerHTML = readerToolbar(file.title || file.file, file.file, actions) + '<div class="reader-empty">' + esc(data.error || 'File not found') + '</div>';
          return;
        }
        liveReader.innerHTML = readerToolbar(file.title || file.file, file.file, actions) + '<div class="reader-content"><pre>' + esc(data.content) + '</pre></div>';
      });
    }
    function renderReferenceSidebar() {
      var container = document.getElementById('project-content');
      if (!container || !_referenceState.topicsData || !_referenceState.referenceData) return;
      var topicsData = _referenceState.topicsData;
      var referenceData = _referenceState.referenceData;
      var topicRows = (topicsData.topics || []).map(function(topic) {
        var doc = findTopicDoc(topic.slug);
        var selected = _referenceState.selectedType === 'topic' && _referenceState.selectedKey === topic.slug ? ' selected' : '';
        var meta = (doc && doc.exists ? doc.entryCount + ' entries' : 'empty bucket') + (topicsData.source === 'default' ? ' · starter' : '');
        return '<div class="split-item' + selected + '" onclick="cortexReferenceSelectTopic(\\'' + esc(topic.slug) + '\\')">' +
          '<div class="reference-item-main"><span class="reference-item-title">' + esc(topic.label) + '</span><span class="reference-item-meta">' + esc(meta) + '</span></div>' +
        '</div>';
      }).join('');
      var suggestionRows = (topicsData.suggestions || []).length
        ? topicsData.suggestions.map(function(suggestion) {
            return '<div class="split-item">' +
              '<div class="reference-item-main"><span class="reference-item-title">' + esc(suggestion.label) + '</span><span class="reference-item-meta">' + esc(suggestion.reason) + '</span></div>' +
              '<button class="btn btn-sm reference-item-action" onclick="event.stopPropagation(); cortexReferenceUseSuggestion(\\'' + esc(suggestion.slug) + '\\')">Use</button>' +
            '</div>';
          }).join('')
        : '<div class="reference-sidebar-note">No topic suggestions right now.</div>';
      var legacyByFile = {};
      (topicsData.legacyDocs || []).forEach(function(doc) { legacyByFile[doc.file] = doc; });
      var otherRows = (referenceData.otherDocs || []).length
        ? referenceData.otherDocs.map(function(file) {
            var selected = _referenceState.selectedType === 'file' && _referenceState.selectedKey === file.file ? ' selected' : '';
            var legacy = legacyByFile[file.file];
            var suffix = legacy ? (legacy.eligible ? ' · legacy topic doc' : ' · legacy skip: ' + legacy.reason) : '';
            return '<div class="split-item' + selected + '" onclick="cortexReferenceSelectFile(\\'' + esc(file.file) + '\\')">' +
              '<div class="reference-item-main"><span class="reference-item-title">' + esc(file.title || file.file) + '</span><span class="reference-item-meta">' + esc(file.file + suffix) + '</span></div>' +
            '</div>';
          }).join('')
        : '<div class="reference-sidebar-note">No other reference docs.</div>';
      var banner = topicsData.source === 'default'
        ? '<div class="reference-banner">Starter topics are active for this project. Add project-owned topics to make archives match the actual domain.</div>'
        : '';
      container.innerHTML = banner +
        '<div class="split-view project-reference-shell">' +
          '<div class="split-sidebar">' +
            '<div class="reference-sidebar-toolbar"><button class="btn btn-sm" onclick="cortexReferenceAddTopic()">Add topic</button><button class="btn btn-sm" onclick="cortexReferenceReclassify()">Reclassify</button></div>' +
            '<div class="split-group-label">Topics</div>' +
            topicRows +
            '<div class="split-group-label">Suggested Topics</div>' +
            suggestionRows +
            '<div class="split-group-label">Other Reference Docs</div>' +
            otherRows +
          '</div>' +
          '<div class="split-reader" id="reference-reader"></div>' +
        '</div>';
      if (_referenceState.editor) {
        renderTopicEditor(_referenceState.editor.mode, _referenceState.editor.topic, _referenceState.editor.suggestion);
        return;
      }
      if (_referenceState.selectedType === 'file') {
        var selectedFile = (referenceData.otherDocs || []).find(function(file) { return file.file === _referenceState.selectedKey; });
        if (selectedFile) {
          renderReferenceFile(selectedFile);
          return;
        }
      }
      if (_referenceState.selectedType === 'topic' && findTopic(_referenceState.selectedKey)) {
        renderTopicSummary(_referenceState.selectedKey);
        return;
      }
      renderReferenceHome();
    }
    function loadReferenceState(nextType, nextKey) {
      var project = currentProject();
      if (!project) return;
      _referenceState.project = project;
      loadJson('/api/project-topics?project=' + encodeURIComponent(project)).then(function(topicsData) {
        if (!topicsData.ok) throw new Error(topicsData.error || 'Failed to load topics');
        return Promise.all([topicsData, loadJson('/api/project-reference-list?project=' + encodeURIComponent(project))]);
      }).then(function(results) {
        var topicsData = results[0];
        var referenceData = results[1];
        if (!referenceData.ok) throw new Error(referenceData.error || 'Failed to load reference docs');
        _referenceState.topicsData = topicsData;
        _referenceState.referenceData = referenceData;
        if (nextType) _referenceState.selectedType = nextType;
        if (nextKey !== undefined) _referenceState.selectedKey = nextKey;
        renderReferenceSidebar();
      }).catch(function(err) {
        var container = document.getElementById('project-content');
        if (container) container.innerHTML = '<div class="project-detail-empty">' + esc(err && err.message ? err.message : 'Failed to load reference data') + '</div>';
      });
    }
    function saveTopics(nextTopics, onDone) {
      fetchCsrfToken(function(csrfToken) {
        var body = 'project=' + encodeURIComponent(_referenceState.project) + '&topics=' + encodeURIComponent(JSON.stringify(nextTopics));
        if (csrfToken) body += '&_csrf=' + encodeURIComponent(csrfToken);
        fetch('/api/project-topics/save', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authBody(body)
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (!data.ok) {
            setStatus(data.error || 'Save failed', 'err');
            return;
          }
          _referenceState.topicsData = data;
          _referenceState.editor = null;
          loadReferenceState('topic', onDone || _referenceState.selectedKey || 'general');
          setStatus('Saved', 'ok');
        }).catch(function() { setStatus('Save failed', 'err'); });
      });
    }
    function collectEditorTopic() {
      var label = document.getElementById('topic-label-input');
      var slug = document.getElementById('topic-slug-input');
      var description = document.getElementById('topic-description-input');
      var keywords = document.getElementById('topic-keywords-input');
      return {
        slug: slug ? slug.value : '',
        label: label ? label.value : '',
        description: description ? description.value : '',
        keywords: keywords ? keywords.value.split(',').map(function(item) { return item.trim(); }).filter(Boolean) : []
      };
    }
    window.cortexLoadProjectReference = function() {
      _referenceState.editor = null;
      loadReferenceState(_referenceState.selectedType || 'topic', _referenceState.selectedKey || 'general');
    };
    window.cortexReferenceSelectTopic = function(slug) {
      _referenceState.editor = null;
      _referenceState.selectedType = 'topic';
      _referenceState.selectedKey = slug;
      renderReferenceSidebar();
    };
    window.cortexReferenceSelectFile = function(file) {
      _referenceState.editor = null;
      _referenceState.selectedType = 'file';
      _referenceState.selectedKey = file;
      renderReferenceSidebar();
    };
    window.cortexReferenceAddTopic = function() {
      _referenceState.editor = { mode: 'add', topic: null, suggestion: null };
      _referenceState.selectedType = '';
      _referenceState.selectedKey = '';
      renderReferenceSidebar();
    };
    window.cortexReferenceEditTopic = function(slug) {
      var topic = findTopic(slug);
      if (!topic) return;
      _referenceState.editor = { mode: 'edit', topic: topic, suggestion: null };
      renderReferenceSidebar();
    };
    window.cortexReferenceCancelEditor = function() {
      _referenceState.editor = null;
      renderReferenceSidebar();
    };
    window.cortexReferenceSaveTopic = function(e) {
      e.preventDefault();
      if (!_referenceState.topicsData) return;
      var topic = collectEditorTopic();
      var topics = (_referenceState.topicsData.topics || []).slice();
      if (_referenceState.editor && _referenceState.editor.mode === 'edit' && _referenceState.editor.topic) {
        topics = topics.map(function(item) { return item.slug === _referenceState.editor.topic.slug ? topic : item; });
      } else {
        topics.push(topic);
      }
      saveTopics(topics, topic.slug || 'general');
    };
    window.cortexReferenceDeleteTopic = function(slug) {
      if (slug === 'general' || !_referenceState.topicsData) return;
      var topics = (_referenceState.topicsData.topics || []).filter(function(topic) { return topic.slug !== slug; });
      saveTopics(topics, 'general');
    };
    window.cortexReferenceUseSuggestion = function(slug) {
      if (!_referenceState.topicsData) return;
      var suggestion = (_referenceState.topicsData.suggestions || []).find(function(item) { return item.slug === slug; });
      if (!suggestion) return;
      var topics = (_referenceState.topicsData.topics || []).slice();
      topics.push({
        slug: suggestion.slug,
        label: suggestion.label,
        description: suggestion.description,
        keywords: suggestion.keywords || []
      });
      saveTopics(topics, suggestion.slug);
    };
    window.cortexReferenceReclassify = function() {
      fetchCsrfToken(function(csrfToken) {
        var body = 'project=' + encodeURIComponent(_referenceState.project);
        if (csrfToken) body += '&_csrf=' + encodeURIComponent(csrfToken);
        fetch('/api/project-topics/reclassify', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authBody(body)
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (!data.ok) {
            setStatus(data.error || 'Reclassify failed', 'err');
            return;
          }
          loadReferenceState(_referenceState.selectedType || 'topic', _referenceState.selectedKey || 'general');
          setStatus('Moved ' + (data.movedEntries || 0) + ' entries; skipped ' + ((data.skipped || []).length) + ' docs', 'ok');
        }).catch(function() { setStatus('Reclassify failed', 'err'); });
      });
    };
  })();`;
}

function renderReviewQueueEditSyncScript(): string {
  return `(function() {
    function normalizeQueueText(raw) {
      return String(raw == null ? '' : raw)
        .replace(/\\r\\n?/g, '\\n')
        .replace(/\\0/g, ' ')
        .replace(/<!--[\\s\\S]*?-->/g, ' ')
        .replace(/\\\\[nrt]/g, ' ')
        .replace(/\\\\\"/g, '"')
        .replace(/\\\\\\\\/g, '\\\\')
        .replace(/\\n+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    }

    function rebuildEditedQueueLine(line, newText) {
      var dateMatch = String(line || '').match(/^- \\[(\\d{4}-\\d{2}-\\d{2})\\]/);
      var confidenceMatch = String(line || '').match(/\\[confidence\\s+([01](?:\\.\\d+)?)\\]/i);
      var normalizedText = normalizeQueueText(newText);
      var date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
      var confidencePart = confidenceMatch
        ? ' [confidence ' + Number(confidenceMatch[1]).toFixed(2) + ']'
        : '';
      return {
        text: normalizedText,
        line: '- [' + date + '] ' + normalizedText + confidencePart
      };
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function syncEditedCard(card, project, nextLine, nextText) {
      if (!card || !project || !nextLine) return;
      card.setAttribute('data-key', project + '\\\\x00' + nextLine);
      card.setAttribute('data-project', project);
      var approveBtn = card.querySelector('.btn-approve');
      if (approveBtn) {
        approveBtn.setAttribute('data-project', project);
        approveBtn.setAttribute('data-line', nextLine);
      }
      var rejectBtn = card.querySelector('.btn-reject');
      if (rejectBtn) {
        rejectBtn.setAttribute('data-project', project);
        rejectBtn.setAttribute('data-line', nextLine);
      }
      var editForm = card.querySelector('.review-card-edit form');
      if (editForm) {
        editForm.setAttribute('data-project', project);
        editForm.setAttribute('data-line', nextLine);
      }
      var editTextarea = card.querySelector('textarea[name="new_text"]');
      if (editTextarea) editTextarea.value = nextText;
    }

    function maybeSyncEditedCard(card, project, line, newText, attemptsLeft) {
      if (!card || !project) return;
      var rebuilt = rebuildEditedQueueLine(line, newText);
      var textEl = card.querySelector('.review-card-text');
      var editSection = card.querySelector('.review-card-edit');
      if (editSection && editSection.style.display === 'none') {
        if (textEl) textEl.innerHTML = escapeHtml(rebuilt.text);
        syncEditedCard(card, project, rebuilt.line, rebuilt.text);
        return;
      }
      if (attemptsLeft > 0) {
        setTimeout(function() {
          maybeSyncEditedCard(card, project, line, newText, attemptsLeft - 1);
        }, 150);
      }
    }

    document.addEventListener('submit', function(event) {
      var form = event.target;
      if (!form || typeof form.getAttribute !== 'function' || typeof form.querySelector !== 'function') return;
      if (!form.closest || !form.closest('.review-card-edit')) return;
      var project = form.getAttribute('data-project') || '';
      var line = form.getAttribute('data-line') || '';
      var textarea = form.querySelector('textarea[name="new_text"]');
      var newText = textarea ? textarea.value : '';
      var card = form.closest('.review-card');
      setTimeout(function() {
        maybeSyncEditedCard(card, project, line, newText, 20);
      }, 0);
    }, true);
  })();`;
}

function renderTasksAndSettingsScript(authToken: string): string {
  return `(function() {
    var _tsAuthToken = '${authToken}';
    var _allTasks = [];

    function tsAuthUrl(base) {
      return base + (base.indexOf('?') === -1 ? '?' : '&') + '_auth=' + encodeURIComponent(_tsAuthToken);
    }

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function priorityBadge(p) {
      if (!p) return '';
      var colors = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
      var color = colors[p] || '#6b7280';
      return '<span style="display:inline-block;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:600;background:' + color + '22;color:' + color + ';margin-left:6px">' + esc(p) + '</span>';
    }

    function loadTasks() {
      var url = _tsAuthToken ? tsAuthUrl('/api/tasks') : '/api/tasks';
      fetch(url).then(function(r) { return r.json(); }).then(function(data) {
        _allTasks = data.tasks || [];
        populateTaskProjectFilter();
        filterTasks();
      }).catch(function(err) {
        document.getElementById('tasks-list').innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center">Failed to load tasks: ' + esc(String(err)) + '</div>';
      });
    }

    function populateTaskProjectFilter() {
      var projects = Array.from(new Set(_allTasks.map(function(t) { return t.project; }))).sort();
      var sel = document.getElementById('tasks-filter-project');
      if (!sel) return;
      var html = '<option value="">All projects</option>';
      projects.forEach(function(p) { html += '<option value="' + esc(p) + '">' + esc(p) + '</option>'; });
      sel.innerHTML = html;
    }

    window.filterTasks = function() {
      var projectFilter = (document.getElementById('tasks-filter-project') || {}).value || '';
      var sectionFilter = (document.getElementById('tasks-filter-section') || {}).value || '';
      var tasks = _allTasks.filter(function(t) {
        if (projectFilter && t.project !== projectFilter) return false;
        if (sectionFilter && t.section !== sectionFilter) return false;
        if (!sectionFilter && t.section !== 'Active' && t.section !== 'Queue') return false;
        return true;
      });

      var countEl = document.getElementById('tasks-count');
      if (countEl) countEl.textContent = tasks.length + ' task' + (tasks.length !== 1 ? 's' : '');

      var container = document.getElementById('tasks-list');
      if (!container) return;
      if (!tasks.length) {
        container.innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center">No tasks found.</div>';
        return;
      }

      // Group by project
      var byProject = {};
      tasks.forEach(function(t) {
        (byProject[t.project] = byProject[t.project] || { Active: [], Queue: [] })[t.section].push(t);
      });

      var html = '';
      Object.keys(byProject).sort().forEach(function(proj) {
        var group = byProject[proj];
        html += '<div class="card" style="margin-bottom:16px">';
        html += '<div class="card-header"><h2>' + esc(proj) + '</h2></div>';
        html += '<div class="card-body" style="padding:0">';

        ['Active', 'Queue'].forEach(function(section) {
          var items = group[section];
          if (!items || !items.length) return;
          html += '<div style="padding:8px 16px 4px;font-size:var(--text-xs);font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">' + esc(section) + '</div>';
          html += '<ul style="margin:0;padding:0 0 8px;list-style:none">';
          items.forEach(function(t) {
            html += '<li style="padding:8px 16px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:8px;min-width:0">';
            if (t.pinned) html += '<span title="Pinned" style="color:var(--accent);font-size:12px;flex-shrink:0">&#9650;</span>';
            html += '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--text-base)">' + esc(t.line) + '</span>';
            html += priorityBadge(t.priority);
            if (t.githubIssue && t.githubUrl) {
              html += '<a href="' + esc(t.githubUrl) + '" target="_blank" rel="noopener noreferrer" style="font-size:var(--text-xs);color:var(--accent);flex-shrink:0;text-decoration:none">#' + esc(String(t.githubIssue)) + '</a>';
            }
            html += '</li>';
          });
          html += '</ul>';
        });

        html += '</div></div>';
      });
      container.innerHTML = html;
    };

    function loadSettings() {
      var url = _tsAuthToken ? tsAuthUrl('/api/settings') : '/api/settings';
      fetch(url).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) return;
        var proactEl = document.getElementById('settings-proactivity');
        if (proactEl) {
          proactEl.innerHTML =
            '<div><strong>Findings</strong><div class="text-muted">' + esc(data.proactivityFindings || data.proactivity || 'high') + '</div></div>' +
            '<div><strong>Tasks</strong><div class="text-muted">' + esc(data.proactivityTask || data.proactivity || 'high') + '</div></div>' +
            '<div><strong>Default</strong><div class="text-muted">' + esc(data.proactivity || 'high') + '</div></div>';
        }
        var tmEl = document.getElementById('settings-task-mode');
        if (tmEl) {
          var modeDescriptions = { off: 'Tasks are disabled', manual: 'Tasks are added only when explicitly requested', suggest: 'Claude suggests tasks but waits for confirmation', auto: 'Claude adds tasks automatically' };
          var mode = data.taskMode || 'auto';
          tmEl.innerHTML = '<strong>' + esc(mode) + '</strong> &mdash; <span class="text-muted">' + esc(modeDescriptions[mode] || mode) + '</span>';
        }
        var hooksEl = document.getElementById('settings-hooks');
        if (hooksEl && data.hookTools) {
          var globalEnabled = data.hooksEnabled;
          var html = '<div style="margin-bottom:8px"><strong>Global hooks: </strong><span class="badge ' + (globalEnabled ? 'badge-on' : 'badge-off') + '">' + (globalEnabled ? 'enabled' : 'disabled') + '</span></div>';
          html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
          data.hookTools.forEach(function(tool) {
            html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--text-sm)">';
            html += '<span>' + esc(tool.tool) + '</span>';
            html += '<span class="badge ' + (tool.enabled ? 'badge-on' : 'badge-off') + '">' + (tool.enabled ? 'on' : 'off') + '</span>';
            html += '</div>';
          });
          html += '</div>';
          hooksEl.innerHTML = html;
        }
        var mcpEl = document.getElementById('settings-mcp');
        if (mcpEl) {
          mcpEl.innerHTML = '<strong>MCP server: </strong><span class="badge ' + (data.mcpEnabled ? 'badge-on' : 'badge-off') + '">' + (data.mcpEnabled ? 'enabled' : 'disabled') + '</span>';
        }
      }).catch(function(err) {
        var el = document.getElementById('settings-proactivity');
        if (el) el.innerHTML = '<div style="color:var(--muted)">Failed to load settings: ' + esc(String(err)) + '</div>';
      });
    }

    // Hook into switchTab to lazy-load
    var _origSwitchTab = window.switchTab;
    var _tasksLoaded = false;
    var _settingsLoaded = false;
    window.switchTab = function(tab) {
      if (typeof _origSwitchTab === 'function') _origSwitchTab(tab);
      if (tab === 'tasks' && !_tasksLoaded) { _tasksLoaded = true; loadTasks(); }
      if (tab === 'settings' && !_settingsLoaded) { _settingsLoaded = true; loadSettings(); }
    };
  })();`;
}

export function renderWebUiPage(cortexPath: string, authToken?: string): string {
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
${WEB_UI_STYLES}
${PROJECT_REFERENCE_UI_STYLES}
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
    <button class="nav-item" onclick="switchTab('tasks')">Tasks</button>
    <button class="nav-item" onclick="switchTab('skills')">Skills</button>
    <button class="nav-item" onclick="switchTab('hooks')">Hooks</button>
    <button class="nav-item" onclick="switchTab('settings')">Settings</button>
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

  <!-- ── Tasks Tab ─────────────────────────────────────────── -->
  <div id="tab-tasks" class="tab-content">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <select id="tasks-filter-project" onchange="filterTasks()" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm)">
        <option value="">All projects</option>
      </select>
      <select id="tasks-filter-section" onchange="filterTasks()" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:6px 10px;background:var(--surface);color:var(--ink);font-size:var(--text-sm)">
        <option value="">Active + Queue</option>
        <option value="Active">Active only</option>
        <option value="Queue">Queue only</option>
      </select>
      <span id="tasks-count" class="text-muted" style="font-size:var(--text-sm);margin-left:auto"></span>
    </div>
    <div id="tasks-list">
      <div style="padding:40px;color:var(--muted);text-align:center">Loading tasks...</div>
    </div>
  </div>

  <!-- ── Settings Tab ───────────────────────────────────────── -->
  <div id="tab-settings" class="tab-content">
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><h2>Proactivity</h2></div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px" id="settings-proactivity">
          <div style="color:var(--muted)">Loading...</div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><h2>Task Mode</h2></div>
      <div class="card-body">
        <div id="settings-task-mode" style="color:var(--muted)">Loading...</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><h2>Hooks</h2></div>
      <div class="card-body">
        <div id="settings-hooks" style="color:var(--muted)">Loading...</div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>MCP</h2></div>
      <div class="card-body">
        <div id="settings-mcp" style="color:var(--muted)">Loading...</div>
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
${renderWebUiScript(h(authToken || ""))}
</script>
<script>
${renderGraphScript()}
</script>
<script>
${renderReviewQueueEditSyncScript()}
</script>
<script>
${renderSkillUiEnhancementScript(h(authToken || ""))}
</script>
<script>
${renderProjectReferenceEnhancementScript(h(authToken || ""))}
</script>
<script>
${renderTasksAndSettingsScript(h(authToken || ""))}
</script>
</body>
</html>`;
}

export function renderPageForTests(cortexPath: string, _csrfToken?: string, authToken?: string): string {
  return renderWebUiPage(cortexPath, authToken);
}
