/**
 * Returns a <script> block with shared browser helpers used across all UI IIFEs:
 *   window._phrenEsc(s)          — HTML-escape a value
 *   window._phrenAuthToken       — the current auth token
 *   window._phrenAuthUrl(base)   — append _auth param to a URL
 *   window._phrenAuthBody(body)  — append _auth param to a form body
 *   window._phrenFetchCsrfToken(cb) — fetch the CSRF token and call cb(token)
 */
export function renderSharedWebUiHelpers(authToken: string): string {
  const safeToken = JSON.stringify(authToken).slice(1, -1); // escape for JS string literal
  return `(function() {
  window._phrenAuthToken = '${safeToken}';
  window._phrenEsc = function(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  };
  window._phrenAuthUrl = function(base) {
    var tok = window._phrenAuthToken;
    return base + (base.indexOf('?') === -1 ? '?' : '&') + '_auth=' + encodeURIComponent(tok);
  };
  window._phrenAuthBody = function(body) {
    var tok = window._phrenAuthToken;
    return body + (tok ? '&_auth=' + encodeURIComponent(tok) : '');
  };
  window._phrenFetchCsrfToken = function(cb) {
    var tok = window._phrenAuthToken;
    var url = '/api/csrf-token' + (tok ? '?_auth=' + encodeURIComponent(tok) : '');
    fetch(url).then(function(r) { return r.json(); }).then(function(d) { cb(d.token || null); }).catch(function() { cb(null); });
  };
})();`;
}

export function renderSkillUiEnhancementScript(_authToken: string): string {
  return `(function() {
    var _skillCurrent = null;
    var _skillEditing = false;
    var esc = window._phrenEsc;
    var authUrl = window._phrenAuthUrl;
    var authBody = window._phrenAuthBody;
    var fetchCsrfToken = window._phrenFetchCsrfToken;

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
          '<button class="btn btn-sm" data-action="phrenToggleSkill">' + toggleLabel + '</button>' +
          '<button class="btn btn-sm" data-action="phrenEditSkill">Edit</button>' +
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
            html += '<div class="split-item" data-path="' + esc(s.path) + '" data-name="' + esc(s.name) + '" data-source="' + esc(s.source) + '" data-enabled="' + (s.enabled ? 'true' : 'false') + '" data-action="phrenSelectSkillFromEl">' +
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
    window.phrenSelectSkillFromEl = function(el) {
      if (!el) return;
      window.phrenSelectSkill(
        el.getAttribute('data-path') || '',
        el.getAttribute('data-name') || '',
        el.getAttribute('data-source') || '',
        el.getAttribute('data-enabled') === 'true',
        el
      );
    };
    window.phrenSelectSkill = function(filePath, name, source, enabled, el) {
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
    window.phrenEditSkill = function() {
      var pre = document.getElementById('skill-pre');
      if (!pre || !_skillCurrent) return;
      _skillEditing = true;
      var content = pre.textContent || '';
      var toolbar = document.querySelector('#skills-reader .reader-toolbar');
      if (!toolbar) return;
      Array.from(toolbar.querySelectorAll('.btn')).forEach(function(btn) { btn.remove(); });
      toolbar.insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-primary" data-action="phrenSaveSkill">Save</button><button class="btn btn-sm" data-action="phrenCancelSkillEdit">Cancel</button>');
      var ta = document.createElement('textarea');
      ta.id = 'skill-textarea';
      ta.value = content;
      pre.replaceWith(ta);
      ta.focus();
    };
    window.phrenCancelSkillEdit = function() {
      _skillEditing = false;
      if (_skillCurrent) window.phrenSelectSkill(_skillCurrent.path, _skillCurrent.name, _skillCurrent.source, _skillCurrent.enabled);
    };
    window.phrenSaveSkill = function() {
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
    window.phrenToggleSkill = function() {
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
          window.phrenSelectSkill(_skillCurrent.path, _skillCurrent.name, _skillCurrent.source, _skillCurrent.enabled);
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
    // Event delegation for dynamically generated skill UI buttons
    document.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var actionEl = target.closest('[data-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-action');
      if (action === 'phrenToggleSkill') { phrenToggleSkill(); }
      else if (action === 'phrenEditSkill') { phrenEditSkill(); }
      else if (action === 'phrenSaveSkill') { phrenSaveSkill(); }
      else if (action === 'phrenCancelSkillEdit') { phrenCancelSkillEdit(); }
      else if (action === 'phrenSelectSkillFromEl') { phrenSelectSkillFromEl(actionEl); }
    });
  })();`;
}

export function renderProjectReferenceEnhancementScript(_authToken: string): string {
  return `(function() {
    var _referenceState = {
      project: '',
      topicsData: null,
      referenceData: null,
      selectedType: '',
      selectedKey: '',
      editor: null
    };
    var esc = window._phrenEsc;
    var authUrl = window._phrenAuthUrl;
    var authBody = window._phrenAuthBody;
    var fetchCsrfToken = window._phrenFetchCsrfToken;

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
      reader.innerHTML = readerToolbar('Reference Topics', _referenceState.project, '<button class="btn btn-sm" data-ref-action="addTopic">Add topic</button><button class="btn btn-sm" data-ref-action="reclassify">Reclassify archived findings</button>') +
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
      reader.innerHTML = readerToolbar(title, _referenceState.project, '<button class="btn btn-sm" data-ref-action="cancelEditor">Cancel</button>') +
        '<div class="reader-content">' +
          '<form class="topic-editor" id="topic-editor-form">' +
            '<label>Label<input id="topic-label-input" value="' + esc(source.label || '') + '" placeholder="Rendering" /></label>' +
            '<label>Slug<input id="topic-slug-input" value="' + esc(source.slug || '') + '" placeholder="rendering" /></label>' +
            '<label>Description<textarea id="topic-description-input" placeholder="What belongs in this topic?">' + esc(source.description || '') + '</textarea></label>' +
            '<label>Keywords<input id="topic-keywords-input" value="' + esc((source.keywords || []).join(', ')) + '" placeholder="shader, frame, gpu, lighting" /></label>' +
            '<div class="topic-editor-actions">' +
              '<button class="btn btn-primary" type="submit">Save</button>' +
              '<button class="btn btn-sm" type="button" data-ref-action="cancelEditor">Cancel</button>' +
            '</div>' +
          '</form>' +
        '</div>';
    }
    function renderTopicSummary(slug) {
      var topic = findTopic(slug);
      var doc = findTopicDoc(slug);
      var reader = document.getElementById('reference-reader');
      if (!topic || !reader) return;
      var actions = '<button class="btn btn-sm" data-ref-action="addTopic">Add topic</button>' +
        '<button class="btn btn-sm" data-ref-action="reclassify">Reclassify archived findings</button>' +
        '<button class="btn btn-sm" data-ref-action="editTopic" data-slug="' + esc(topic.slug) + '">Edit</button>';
      if (topic.slug !== 'general') actions += '<button class="btn btn-sm" data-ref-action="deleteTopic" data-slug="' + esc(topic.slug) + '">Delete</button>';
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
      var actions = '<button class="btn btn-sm" data-ref-action="addTopic">Add topic</button><button class="btn btn-sm" data-ref-action="reclassify">Reclassify archived findings</button>';
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
        return '<div class="split-item' + selected + '" data-ref-action="selectTopic" data-slug="' + esc(topic.slug) + '">' +
          '<div class="reference-item-main"><span class="reference-item-title">' + esc(topic.label) + '</span><span class="reference-item-meta">' + esc(meta) + '</span></div>' +
        '</div>';
      }).join('');
      var suggestionRows = (topicsData.suggestions || []).length
        ? topicsData.suggestions.map(function(suggestion) {
            var confidencePct = Math.round((Number(suggestion.confidence || 0)) * 100);
            var meta = suggestion.reason + (confidencePct > 0 ? ' · confidence ' + confidencePct + '%' : '');
            var isPinned = suggestion.source === 'pinned';
            return '<div class="split-item">' +
              '<div class="reference-item-main"><span class="reference-item-title">' + esc(suggestion.label) + '</span><span class="reference-item-meta">' + esc(meta) + '</span></div>' +
              (isPinned
                ? '<button class="btn btn-sm reference-item-action" data-ref-action="unpinSuggestion" data-slug="' + esc(suggestion.slug) + '">Unpin</button>'
                : '<button class="btn btn-sm reference-item-action" data-ref-action="pinSuggestion" data-slug="' + esc(suggestion.slug) + '">Pin</button><button class="btn btn-sm reference-item-action" data-ref-action="useSuggestion" data-slug="' + esc(suggestion.slug) + '">Use</button>') +
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
            return '<div class="split-item' + selected + '" data-ref-action="selectFile" data-file="' + esc(file.file) + '">' +
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
            '<div class="reference-sidebar-toolbar"><button class="btn btn-sm" data-ref-action="addTopic">Add topic</button><button class="btn btn-sm" data-ref-action="reclassify">Reclassify</button></div>' +
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
    window.phrenLoadProjectReference = function() {
      _referenceState.editor = null;
      loadReferenceState(_referenceState.selectedType || 'topic', _referenceState.selectedKey || 'general');
    };
    window.phrenReferenceSelectTopic = function(slug) {
      _referenceState.editor = null;
      _referenceState.selectedType = 'topic';
      _referenceState.selectedKey = slug;
      renderReferenceSidebar();
    };
    window.phrenReferenceSelectFile = function(file) {
      _referenceState.editor = null;
      _referenceState.selectedType = 'file';
      _referenceState.selectedKey = file;
      renderReferenceSidebar();
    };
    window.phrenReferenceAddTopic = function() {
      _referenceState.editor = { mode: 'add', topic: null, suggestion: null };
      _referenceState.selectedType = '';
      _referenceState.selectedKey = '';
      renderReferenceSidebar();
    };
    window.phrenReferenceEditTopic = function(slug) {
      var topic = findTopic(slug);
      if (!topic) return;
      _referenceState.editor = { mode: 'edit', topic: topic, suggestion: null };
      renderReferenceSidebar();
    };
    window.phrenReferenceCancelEditor = function() {
      _referenceState.editor = null;
      renderReferenceSidebar();
    };
    window.phrenReferenceSaveTopic = function(e) {
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
    window.phrenReferenceDeleteTopic = function(slug) {
      if (slug === 'general' || !_referenceState.topicsData) return;
      var topics = (_referenceState.topicsData.topics || []).filter(function(topic) { return topic.slug !== slug; });
      saveTopics(topics, 'general');
    };
    window.phrenReferenceUseSuggestion = function(slug) {
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
    window.phrenReferencePinSuggestion = function(slug) {
      if (!_referenceState.topicsData) return;
      var suggestion = (_referenceState.topicsData.suggestions || []).find(function(item) { return item.slug === slug; });
      if (!suggestion) return;
      fetchCsrfToken(function(csrfToken) {
        var topicPayload = JSON.stringify({
          slug: suggestion.slug,
          label: suggestion.label,
          description: suggestion.description,
          keywords: suggestion.keywords || []
        });
        var body = 'project=' + encodeURIComponent(_referenceState.project) + '&topic=' + encodeURIComponent(topicPayload);
        if (csrfToken) body += '&_csrf=' + encodeURIComponent(csrfToken);
        fetch('/api/project-topics/pin', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authBody(body)
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (!data.ok) {
            setStatus(data.error || 'Pin failed', 'err');
            return;
          }
          _referenceState.topicsData = data;
          loadReferenceState(_referenceState.selectedType || 'topic', _referenceState.selectedKey || 'general');
          setStatus('Pinned', 'ok');
        }).catch(function() { setStatus('Pin failed', 'err'); });
      });
    };
    window.phrenReferenceUnpinSuggestion = function(slug) {
      fetchCsrfToken(function(csrfToken) {
        var body = 'project=' + encodeURIComponent(_referenceState.project) + '&slug=' + encodeURIComponent(slug || '');
        if (csrfToken) body += '&_csrf=' + encodeURIComponent(csrfToken);
        fetch('/api/project-topics/unpin', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: authBody(body)
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (!data.ok) {
            setStatus(data.error || 'Unpin failed', 'err');
            return;
          }
          _referenceState.topicsData = data;
          loadReferenceState(_referenceState.selectedType || 'topic', _referenceState.selectedKey || 'general');
          setStatus('Unpinned', 'ok');
        }).catch(function() { setStatus('Unpin failed', 'err'); });
      });
    };
    window.phrenReferenceReclassify = function() {
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
    // Event delegation for dynamically generated reference UI
    document.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var actionEl = target.closest('[data-ref-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-ref-action');
      if (action === 'addTopic') { phrenReferenceAddTopic(); }
      else if (action === 'reclassify') { phrenReferenceReclassify(); }
      else if (action === 'cancelEditor') { phrenReferenceCancelEditor(); }
      else if (action === 'editTopic') { phrenReferenceEditTopic(actionEl.getAttribute('data-slug')); }
      else if (action === 'deleteTopic') { phrenReferenceDeleteTopic(actionEl.getAttribute('data-slug')); }
      else if (action === 'selectTopic') { phrenReferenceSelectTopic(actionEl.getAttribute('data-slug')); }
      else if (action === 'selectFile') { phrenReferenceSelectFile(actionEl.getAttribute('data-file')); }
      else if (action === 'useSuggestion') { e.stopPropagation(); phrenReferenceUseSuggestion(actionEl.getAttribute('data-slug')); }
      else if (action === 'pinSuggestion') { e.stopPropagation(); phrenReferencePinSuggestion(actionEl.getAttribute('data-slug')); }
      else if (action === 'unpinSuggestion') { e.stopPropagation(); phrenReferenceUnpinSuggestion(actionEl.getAttribute('data-slug')); }
    });
    document.addEventListener('submit', function(e) {
      var form = e.target;
      if (form && form.id === 'topic-editor-form') {
        e.preventDefault();
        phrenReferenceSaveTopic(e);
      }
    });
  })();`;
}

export function renderReviewQueueEditSyncScript(): string {
  return "";
}

export function renderTasksAndSettingsScript(authToken: string): string {
  const safeToken = JSON.stringify(authToken).slice(1, -1);
  return `(function() {
    var _tsAuthToken = '${safeToken}';
    var _allTasks = [];
    var esc = window._phrenEsc;

    function tsAuthUrl(base) {
      return base + (base.indexOf('?') === -1 ? '?' : '&') + '_auth=' + encodeURIComponent(_tsAuthToken);
    }

    function loadJson(url) {
      return fetch(url).then(function(r) { return r.json(); });
    }

    var _taskViewMode = 'list';

    function priorityBadge(p) {
      if (!p) return '';
      var colors = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' };
      var color = colors[p] || '#6b7280';
      return '<span class="task-priority-badge task-priority-' + esc(p) + '">' + esc(p) + '</span>';
    }

    function sessionBadge(sessionId) {
      if (!sessionId) return '';
      var short = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
      return '<span class="task-session-badge" title="Session ' + esc(sessionId) + '">' + esc(short) + '</span>';
    }

    function statusChip(section, checked) {
      if (checked || section === 'Done') return '<span class="task-status-chip task-status-done" title="Done"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Done</span>';
      if (section === 'Active') return '<span class="task-status-chip task-status-active" title="In Progress">In Progress</span>';
      return '<span class="task-status-chip task-status-pending" title="Pending">Pending</span>';
    }

    function projectBadge(proj) {
      return '<span class="task-project-badge">' + esc(proj) + '</span>';
    }

    function pinIndicator(pinned) {
      if (!pinned) return '';
      return '<span class="task-pin-indicator" title="Pinned"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 2.172a2 2 0 0 1 2.828 0l1.172 1.172a2 2 0 0 1 0 2.828L12 8l-1.5 1.5.5 3.5L8 10l-3.5.5.5-3.5L3.5 5.5 2 4l2.172-1.828a2 2 0 0 1 2.828 0L8 3l1.828-.828z"/></svg></span>';
    }

    function githubBadge(issue, url) {
      if (!issue || !url) return '';
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" class="task-github-badge" title="GitHub Issue #' + esc(String(issue)) + '"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>#' + esc(String(issue)) + '</a>';
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

    window.completeTaskFromUi = function(project, item) {
      var csrfUrl = _tsAuthToken ? tsAuthUrl('/api/csrf-token') : '/api/csrf-token';
      fetch(csrfUrl).then(function(r) { return r.json(); }).then(function(csrfData) {
        var body = new URLSearchParams({ project: project, item: item });
        if (csrfData.token) body.set('_csrf', csrfData.token);
        var url = _tsAuthToken ? tsAuthUrl('/api/tasks/complete') : '/api/tasks/complete';
        return fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.ok) { loadTasks(); } else { alert(data.error || 'Failed to complete task'); }
      }).catch(function(err) { alert('Error: ' + String(err)); });
    };

    window.removeTaskFromUi = function(project, item) {
      if (!confirm('Delete this task?')) return;
      var csrfUrl = _tsAuthToken ? tsAuthUrl('/api/csrf-token') : '/api/csrf-token';
      fetch(csrfUrl).then(function(r) { return r.json(); }).then(function(csrfData) {
        var body = new URLSearchParams({ project: project, item: item });
        if (csrfData.token) body.set('_csrf', csrfData.token);
        var url = _tsAuthToken ? tsAuthUrl('/api/tasks/remove') : '/api/tasks/remove';
        return fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.ok) { loadTasks(); } else { alert(data.error || 'Failed to remove task'); }
      }).catch(function(err) { alert('Error: ' + String(err)); });
    };

    window.addTaskFromUi = function(project) {
      var input = document.getElementById('task-add-input-' + project);
      if (!input || !input.value.trim()) return;
      var item = input.value.trim();
      var csrfUrl = _tsAuthToken ? tsAuthUrl('/api/csrf-token') : '/api/csrf-token';
      fetch(csrfUrl).then(function(r) { return r.json(); }).then(function(csrfData) {
        var body = new URLSearchParams({ project: project, item: item });
        if (csrfData.token) body.set('_csrf', csrfData.token);
        var url = _tsAuthToken ? tsAuthUrl('/api/tasks/add') : '/api/tasks/add';
        return fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.ok) { input.value = ''; loadTasks(); } else { alert(data.error || 'Failed to add task'); }
      }).catch(function(err) { alert('Error: ' + String(err)); });
    };

    window.toggleDoneSection = function(btn) {
      if (!btn) return;
      var list = btn.nextElementSibling;
      var arrow = btn.querySelector('.task-toggle-arrow');
      if (!list) return;
      var isOpen = list.style.display !== 'none';
      list.style.display = isOpen ? 'none' : 'block';
      if (arrow) arrow.textContent = isOpen ? '\u25B6' : '\u25BC';
    };

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
      var showDone = sectionFilter === 'Done';
      var tasks = _allTasks.filter(function(t) {
        if (projectFilter && t.project !== projectFilter) return false;
        if (sectionFilter && t.section !== sectionFilter) return false;
        if (!sectionFilter && t.section === 'Done') return false;
        return true;
      });
      var doneTasks = showDone ? [] : _allTasks.filter(function(t) {
        if (projectFilter && t.project !== projectFilter) return false;
        return t.section === 'Done' || t.checked;
      });

      var activeCount = tasks.filter(function(t) { return t.section !== 'Done' && !t.checked; }).length;
      var countEl = document.getElementById('tasks-count');
      if (countEl) countEl.textContent = activeCount + ' active' + (doneTasks.length ? ', ' + doneTasks.length + ' done' : '');

      var container = document.getElementById('tasks-list');
      if (!container) return;
      if (!tasks.length && !doneTasks.length) {
        container.innerHTML = '<div class="task-empty-state"><svg viewBox="0 0 48 48" width="64" height="64" style="display:block;margin:0 auto 16px"><ellipse cx="24" cy="24" rx="16" ry="15" fill="#7B68AE" opacity="0.25"/><ellipse cx="24" cy="24" rx="12" ry="11.5" fill="#7B68AE" opacity="0.4"/><circle cx="19" cy="22" r="1.5" fill="#2D2255"/><circle cx="29" cy="22" r="1.5" fill="#2D2255"/><path d="M21 28c1 1.2 2.5 1.5 3.5 1.3 1-.2 2-1 2.5-1.3" stroke="#2D2255" stroke-width="1" fill="none" stroke-linecap="round"/></svg><div style="font-size:var(--text-md);font-weight:600;color:var(--ink);margin-bottom:4px">Nothing to do!</div><div style="color:var(--muted);font-size:var(--text-sm)">Add a task to get started.</div></div>';
        return;
      }

      // Group by priority within sections
      var priorityOrder = { high: 0, medium: 1, low: 2 };
      function sortByPriority(a, b) {
        // Unchecked before checked
        var aChecked = a.checked || a.section === 'Done' ? 1 : 0;
        var bChecked = b.checked || b.section === 'Done' ? 1 : 0;
        if (aChecked !== bChecked) return aChecked - bChecked;
        // Pinned first
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        // Then by priority
        var pa = priorityOrder[a.priority] !== undefined ? priorityOrder[a.priority] : 1;
        var pb = priorityOrder[b.priority] !== undefined ? priorityOrder[b.priority] : 1;
        return pa - pb;
      }

      // Separate into priority groups (exclude checked tasks even if not in Done section)
      function isActive(t) { return t.section !== 'Done' && !t.checked; }
      var high = tasks.filter(function(t) { return t.priority === 'high' && isActive(t); }).sort(sortByPriority);
      var medium = tasks.filter(function(t) { return t.priority === 'medium' && isActive(t); }).sort(sortByPriority);
      var low = tasks.filter(function(t) { return t.priority === 'low' && isActive(t); }).sort(sortByPriority);
      var noPriority = tasks.filter(function(t) { return !t.priority && isActive(t); }).sort(sortByPriority);
      var doneVisible = tasks.filter(function(t) { return t.section === 'Done' || t.checked; });

      function renderTaskCard(t) {
        var borderClass = t.priority === 'high' ? ' task-card-high' : t.priority === 'medium' ? ' task-card-medium' : t.priority === 'low' ? ' task-card-low' : '';
        var doneClass = (t.section === 'Done' || t.checked) ? ' task-card-done' : '';
        var html = '<div class="task-card' + borderClass + doneClass + '">';
        html += '<div class="task-card-top">';
        html += statusChip(t.section, t.checked);
        html += projectBadge(t.project);
        html += pinIndicator(t.pinned);
        html += githubBadge(t.githubIssue, t.githubUrl);
        html += priorityBadge(t.priority);
        html += sessionBadge(t.sessionId);
        html += '</div>';
        html += '<div class="task-card-body">';
        html += '<span class="task-card-text">' + esc(t.line) + '</span>';
        if (t.context) html += '<span class="task-card-context">' + esc(t.context) + '</span>';
        html += '</div>';
        html += '<div class="task-card-actions">';
        if (t.section !== 'Done' && !t.checked) {
          html += '<button class="task-done-btn" data-ts-action="completeTask" data-project="' + esc(t.project) + '" data-item="' + esc(t.line) + '" title="Mark done"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Done</button>';
        }
        html += '<button class="task-remove-btn" data-ts-action="removeTask" data-project="' + esc(t.project) + '" data-item="' + esc(t.line) + '" title="Delete task" style="background:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 8px;cursor:pointer;color:var(--muted);font-size:var(--text-xs)"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>';
        html += '</div>';
        html += '</div>';
        return html;
      }

      var html = '';

      // Summary bar
      var allActive = _allTasks.filter(function(t) { return t.section !== 'Done' && !t.checked; });
      var highCount = allActive.filter(function(t) { return t.priority === 'high'; }).length;
      var medCount = allActive.filter(function(t) { return t.priority === 'medium'; }).length;
      var lowCount = allActive.filter(function(t) { return t.priority === 'low'; }).length;
      var projectCounts = {};
      allActive.forEach(function(t) { projectCounts[t.project] = (projectCounts[t.project] || 0) + 1; });
      var topProjects = Object.keys(projectCounts).sort(function(a, b) { return projectCounts[b] - projectCounts[a]; }).slice(0, 3);
      html += '<div class="task-summary-bar">';
      html += '<span class="task-summary-total">' + allActive.length + ' active</span>';
      if (highCount) html += '<span class="task-summary-pill task-summary-high">' + highCount + ' high</span>';
      if (medCount) html += '<span class="task-summary-pill task-summary-medium">' + medCount + ' medium</span>';
      if (lowCount) html += '<span class="task-summary-pill task-summary-low">' + lowCount + ' low</span>';
      if (topProjects.length) {
        html += '<span class="task-summary-projects">';
        topProjects.forEach(function(p) { html += '<span class="task-summary-project">' + esc(p) + ' (' + projectCounts[p] + ')</span>'; });
        html += '</span>';
      }
      html += '<span class="task-view-toggle" style="margin-left:auto">';
      html += '<button class="task-view-btn' + (_taskViewMode === 'list' ? ' active' : '') + '" data-ts-action="setTaskView" data-mode="list" title="List view"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>';
      html += '<button class="task-view-btn' + (_taskViewMode === 'compact' ? ' active' : '') + '" data-ts-action="setTaskView" data-mode="compact" title="Compact view"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="6" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="2" width="6" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="9" width="6" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="9" y="9" width="6" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/></svg></button>';
      html += '</span>';
      html += '</div>';

      // Add task input at top (only when a specific project is selected)
      var projects = projectFilter ? [projectFilter] : [];
      projects.forEach(function(proj) {
        html += '<div class="task-add-bar">';
        html += '<input id="task-add-input-' + esc(proj) + '" type="text" class="task-add-input" placeholder="Add a task to ' + esc(proj) + '\u2026" data-ts-action="addTaskKeydown" data-project="' + esc(proj) + '">';
        html += '<button class="task-add-btn" data-ts-action="addTask" data-project="' + esc(proj) + '"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Add</button>';
        html += '</div>';
      });

      // Priority sections
      function renderSection(title, items, icon) {
        if (!items.length) return '';
        var gridClass = _taskViewMode === 'compact' ? 'task-card-grid task-card-grid-compact' : 'task-card-grid';
        var shtml = '<div class="task-priority-section">';
        shtml += '<div class="task-section-header"><span class="task-section-icon">' + icon + '</span> ' + title + ' <span class="task-section-count">' + items.length + '</span></div>';
        shtml += '<div class="' + gridClass + '">';
        items.forEach(function(t) { shtml += renderTaskCard(t); });
        shtml += '</div></div>';
        return shtml;
      }

      html += renderSection('High Priority', high, '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#ef4444"/></svg>');
      html += renderSection('Medium Priority', medium, '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#f59e0b"/></svg>');
      html += renderSection('Low Priority', low, '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#6b7280"/></svg>');
      if (noPriority.length) {
        html += renderSection('Tasks', noPriority, '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="var(--accent)"/></svg>');
      }

      // Done section (collapsible)
      var allDone = showDone ? doneVisible : doneTasks;
      if (allDone.length) {
        html += '<div class="task-done-section">';
        html += '<button class="task-done-toggle" data-ts-action="toggleDoneSection">';
        html += '<span class="task-toggle-arrow">\u25B6</span> Completed <span class="task-section-count">' + allDone.length + '</span></button>';
        html += '<div class="task-done-list" style="display:none">';
        html += '<div class="task-card-grid">';
        allDone.forEach(function(t) { html += renderTaskCard(t); });
        html += '</div></div></div>';
      }

      container.innerHTML = html;
    };

    function setSettingsStatus(message, type) {
      var el = document.getElementById('settings-status-inline');
      if (!el) return;
      el.textContent = message || '';
      el.className = 'settings-status-inline' + (type ? ' ' + type : '');
    }

    function findingUiToStorage(level) {
      var map = { high: 'aggressive', medium: 'balanced', low: 'conservative', minimal: 'minimal' };
      return map[level] || 'balanced';
    }

    function findingStorageToUi(level) {
      var map = { aggressive: 'high', balanced: 'medium', conservative: 'low', minimal: 'minimal' };
      return map[level] || 'medium';
    }

    function postSettings(endpoint, payload, okMessage) {
      var csrfUrl = _tsAuthToken ? tsAuthUrl('/api/csrf-token') : '/api/csrf-token';
      fetch(csrfUrl).then(function(r) { return r.json(); }).then(function(csrfData) {
        var body = new URLSearchParams(payload || {});
        if (csrfData.token) body.set('_csrf', csrfData.token);
        var url = _tsAuthToken ? tsAuthUrl(endpoint) : endpoint;
        return fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) {
          setSettingsStatus(data.error || 'Settings update failed', 'err');
          return;
        }
        _settingsLoaded = false;
        loadSettings();
        setSettingsStatus(okMessage || 'Settings updated', 'ok');
      }).catch(function(err) {
        setSettingsStatus('Settings update failed: ' + String(err), 'err');
      });
    }

    function getSettingsProject() {
      var sel = document.getElementById('settings-project-select');
      return sel ? sel.value : '';
    }

    function postProjectOverride(project, field, value, clearField) {
      var csrfUrl = _tsAuthToken ? tsAuthUrl('/api/csrf-token') : '/api/csrf-token';
      fetch(csrfUrl).then(function(r) { return r.json(); }).then(function(csrfData) {
        var payload = { project: project, field: field, value: value || '', clear: clearField ? 'true' : 'false' };
        var body = new URLSearchParams(payload);
        if (csrfData.token) body.set('_csrf', csrfData.token);
        var url = _tsAuthToken ? tsAuthUrl('/api/settings/project-overrides') : '/api/settings/project-overrides';
        return fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) {
          setSettingsStatus(data.error || 'Failed to update project override', 'err');
          return;
        }
        _settingsLoaded = false;
        loadSettings();
        setSettingsStatus('Project override updated', 'ok');
      }).catch(function(err) {
        setSettingsStatus('Failed: ' + String(err), 'err');
      });
    }

    function loadSettings() {
      var selectedProject = getSettingsProject();
      var baseUrl = '/api/settings';
      if (selectedProject) baseUrl += '?project=' + encodeURIComponent(selectedProject);
      var url = _tsAuthToken ? tsAuthUrl(baseUrl) : baseUrl;

      // Populate project selector on first load
      var sel = document.getElementById('settings-project-select');
      if (sel && sel.querySelectorAll('option[data-proj]').length === 0) {
        var configUrl = _tsAuthToken ? tsAuthUrl('/api/config') : '/api/config';
        fetch(configUrl).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok && d.projects && d.projects.length && sel) {
            d.projects.forEach(function(p) {
              var opt = document.createElement('option');
              opt.value = p; opt.textContent = p;
              opt.setAttribute('data-proj', '1');
              sel.appendChild(opt);
            });
            if (selectedProject) sel.value = selectedProject;
          }
        }).catch(function() {});
      }

      var scopeNote = document.getElementById('settings-scope-note');
      if (scopeNote) {
        scopeNote.textContent = selectedProject
          ? 'Showing effective config for "' + selectedProject + '". Overrides are saved to that project\\\'s phren.project.yaml.'
          : 'Showing global settings. Select a project to view and edit per-project overrides.';
      }

      // Wire onChange once
      if (sel && !sel.getAttribute('data-onchange-wired')) {
        sel.setAttribute('data-onchange-wired', '1');
        sel.addEventListener('change', function() {
          _settingsLoaded = false;
          loadSettings();
        });
      }

      fetch(url).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) {
          setSettingsStatus(data.error || 'Failed to load settings', 'err');
          return;
        }

        // Use merged config when a project is selected, else global
        var effective = (selectedProject && data.merged) ? data.merged : null;
        var rawOverrides = (selectedProject && data.overrides) ? data.overrides : null;
        var effectiveSensitivity = effective ? effective.findingSensitivity : (data.findingSensitivity || 'balanced');
        var effectiveTaskMode = effective ? effective.taskMode : (data.taskMode || 'auto');
        var effectiveProactivity = data.proactivity || 'high';
        var effectiveRetention = (effective && effective.retentionPolicy) ? effective.retentionPolicy : (data.retentionPolicy || {});
        var effectiveWorkflow = (effective && effective.workflowPolicy) ? effective.workflowPolicy : (data.workflowPolicy || {});

        var isProject = Boolean(selectedProject);

        // Render project info section
        var infoSection = document.getElementById('settings-project-info-section');
        var infoEl = document.getElementById('settings-project-info');
        if (infoSection && infoEl) {
          if (isProject && data.projectInfo) {
            var pi = data.projectInfo;
            infoSection.style.display = '';
            var infoHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;font-size:var(--text-sm)">';
            infoHtml += '<div><strong style="color:var(--ink)">Disk path</strong><div class="text-muted" style="font-family:var(--mono);font-size:var(--text-xs);word-break:break-all">' + esc(pi.diskPath) + '</div></div>';
            infoHtml += '<div><strong style="color:var(--ink)">Ownership</strong><div class="text-muted">' + esc(pi.ownership) + '</div></div>';
            infoHtml += '<div><strong style="color:var(--ink)">Config file</strong><div class="text-muted" style="font-family:var(--mono);font-size:var(--text-xs);word-break:break-all">' + esc(pi.configFile) + '</div>' + (pi.configExists ? '<span style="color:var(--green);font-size:var(--text-xs)">exists</span>' : '<span style="color:var(--muted);font-size:var(--text-xs)">not created</span>') + '</div>';
            infoHtml += '<div><strong style="color:var(--ink)">Findings</strong><div class="text-muted">' + pi.findingCount + ' entries</div></div>';
            infoHtml += '<div><strong style="color:var(--ink)">Tasks</strong><div class="text-muted">' + pi.taskCount + ' in queue</div></div>';
            infoHtml += '</div>';
            var files = [];
            if (pi.hasFindings) files.push('FINDINGS.md');
            if (pi.hasTasks) files.push('tasks.md');
            if (pi.hasSummary) files.push('summary.md');
            if (pi.hasClaudeMd) files.push('CLAUDE.md');
            if (files.length) {
              infoHtml += '<div style="margin-top:10px;font-size:var(--text-xs);color:var(--muted)">Files: ' + files.map(function(f) { return '<span class="badge" style="margin-right:4px">' + esc(f) + '</span>'; }).join('') + '</div>';
            }
            infoEl.innerHTML = infoHtml;
          } else {
            infoSection.style.display = 'none';
            infoEl.innerHTML = '';
          }
        }

        function sourceBadge(isOverride) {
          if (!isProject) return '';
          return isOverride
            ? '<span style="font-size:10px;font-weight:600;color:var(--warning);margin-left:6px;padding:1px 6px;border:1px solid color-mix(in srgb,var(--warning) 40%,transparent);border-radius:var(--radius-sm)">project override</span>'
            : '<span style="font-size:10px;color:var(--text-muted);margin-left:6px;padding:1px 6px;border:1px solid var(--border);border-radius:var(--radius-sm)">global default</span>';
        }

        var findingDescriptions = {
          high: 'Capture findings proactively, including minor observations.',
          medium: 'Capture findings that are likely useful.',
          low: 'Capture findings only when clearly significant.',
          minimal: 'Only capture explicitly flagged findings.'
        };

        var findingsEl = document.getElementById('settings-findings');
        if (findingsEl) {
          var fsUi = findingStorageToUi(effectiveSensitivity);
          var findingsHtml = '';
          var fsSensOverride = rawOverrides && rawOverrides.findingSensitivity != null;
          findingsHtml += '<div class="settings-control">';
          findingsHtml += '<div class="settings-control-header"><span class="settings-control-label">Finding sensitivity</span>' + sourceBadge(fsSensOverride);
          if (isProject && fsSensOverride) {
            findingsHtml += '<button data-ts-action="clearProjectOverride" data-field="findingSensitivity" class="settings-chip" style="font-size:11px;margin-left:auto">Clear override</button>';
          }
          findingsHtml += '</div>';
          findingsHtml += '<div class="settings-chip-row">';
          ['high', 'medium', 'low', 'minimal'].forEach(function(level) {
            var active = level === fsUi ? ' active' : '';
            var action = isProject ? 'setProjectFindingSensitivity' : 'setFindingSensitivity';
            findingsHtml += '<button data-ts-action="' + action + '" data-level="' + esc(level) + '" class="settings-chip' + active + '">' + esc(level) + '</button>';
          });
          findingsHtml += '</div>';
          findingsHtml += '<div class="settings-control-note" id="settings-fs-desc">' + esc(findingDescriptions[fsUi] || '') + '</div>';
          findingsHtml += '</div>';
          if (!isProject) {
            findingsHtml += '<div class="settings-control">';
            findingsHtml += '<div class="settings-control-header"><span class="settings-control-label">Auto-capture</span>';
            findingsHtml += '<button data-ts-action="toggleAutoCapture" data-enabled="' + (data.autoCaptureEnabled ? 'true' : 'false') + '" class="settings-chip' + (data.autoCaptureEnabled ? ' active' : '') + '">' + (data.autoCaptureEnabled ? 'On' : 'Off') + '</button></div>';
            findingsHtml += '<div class="settings-control-note">Turn automatic finding capture on or off.</div>';
            findingsHtml += '</div>';
            findingsHtml += '<div class="settings-control">';
            findingsHtml += '<div class="settings-control-header"><span class="settings-control-label">Consolidation threshold</span><span class="badge">' + esc(String(data.consolidationEntryThreshold || 25)) + ' entries</span></div>';
            findingsHtml += '<div class="settings-control-note">Consolidation is also recommended after 60+ days with at least 10 new entries.</div>';
            findingsHtml += '</div>';
          }
          findingsEl.innerHTML = findingsHtml;
        }

        var behaviorEl = document.getElementById('settings-behavior');
        if (behaviorEl) {
          var taskMode = effectiveTaskMode || 'auto';
          var proactivity = effectiveProactivity;
          var behaviorHtml = '';
          var taskModeOverride = rawOverrides && rawOverrides.taskMode != null;
          behaviorHtml += '<div class="settings-control">';
          behaviorHtml += '<div class="settings-control-header"><span class="settings-control-label">Task mode</span>' + sourceBadge(taskModeOverride);
          if (isProject && taskModeOverride) {
            behaviorHtml += '<button data-ts-action="clearProjectOverride" data-field="taskMode" class="settings-chip" style="font-size:11px;margin-left:auto">Clear override</button>';
          }
          behaviorHtml += '</div>';
          behaviorHtml += '<div class="settings-chip-row">';
          ['auto', 'suggest', 'manual', 'off'].forEach(function(mode) {
            var active = mode === taskMode ? ' active' : '';
            var action = isProject ? 'setProjectTaskMode' : 'setTaskMode';
            behaviorHtml += '<button data-ts-action="' + action + '" data-mode="' + esc(mode) + '" class="settings-chip' + active + '">' + esc(mode) + '</button>';
          });
          behaviorHtml += '</div></div>';
          if (!isProject) {
            behaviorHtml += '<div class="settings-control">';
            behaviorHtml += '<div class="settings-control-header"><span class="settings-control-label">Proactivity level</span></div>';
            behaviorHtml += '<div class="settings-chip-row">';
            ['high', 'medium', 'low'].forEach(function(level) {
              var active = level === proactivity ? ' active' : '';
              behaviorHtml += '<button data-ts-action="setProactivity" data-level="' + esc(level) + '" class="settings-chip' + active + '">' + esc(level) + '</button>';
            });
            behaviorHtml += '</div></div>';
          }
          behaviorEl.innerHTML = behaviorHtml;
        }

        var retentionEl = document.getElementById('settings-retention');
        if (retentionEl) {
          var ret = effectiveRetention;
          var retHtml = '';
          function retRow(label, field, value, note) {
            var isOverride = isProject && rawOverrides && rawOverrides.retentionPolicy && rawOverrides.retentionPolicy[field] !== undefined;
            retHtml += '<div class="settings-control">';
            retHtml += '<div class="settings-control-header"><span class="settings-control-label">' + esc(label) + '</span>' + sourceBadge(isOverride);
            retHtml += '<span class="settings-control-value" style="margin-left:auto">' + esc(String(value != null ? value : '—')) + '</span>';
            if (isProject && isOverride) {
              retHtml += '<button data-ts-action="clearProjectOverride" data-field="' + esc(field) + '" class="settings-chip" style="font-size:11px">Clear</button>';
            }
            retHtml += '</div>';
            if (note) retHtml += '<div class="settings-control-note">' + esc(note) + '</div>';
            if (isProject) {
              retHtml += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
                '<input type="number" id="ret-input-' + esc(field) + '" value="' + esc(String(value != null ? value : '')) + '" style="width:100px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:var(--text-sm);background:var(--surface);color:var(--ink)">' +
                '<button data-ts-action="setProjectRetention" data-field="' + esc(field) + '" class="settings-chip active" style="font-size:11px">Set</button>' +
                '</div>';
            }
            retHtml += '</div>';
          }
          retRow('TTL days', 'ttlDays', ret.ttlDays, 'Memories older than this are eligible for pruning.');
          retRow('Retention days', 'retentionDays', ret.retentionDays, 'Hard cutoff — memories past this age are removed.');
          retRow('Auto-accept threshold', 'autoAcceptThreshold', ret.autoAcceptThreshold, 'Confidence score (0–1) above which memories are auto-accepted.');
          retRow('Min inject confidence', 'minInjectConfidence', ret.minInjectConfidence, 'Minimum confidence score to inject a memory into context.');
          retentionEl.innerHTML = retHtml;
        }

        var workflowEl = document.getElementById('settings-workflow');
        if (workflowEl) {
          var wf = effectiveWorkflow;
          var wfHtml = '';
          var lctOverride = isProject && rawOverrides && rawOverrides.workflowPolicy && rawOverrides.workflowPolicy.lowConfidenceThreshold !== undefined;
          var riskySectionsOverride = isProject && rawOverrides && rawOverrides.workflowPolicy && Array.isArray(rawOverrides.workflowPolicy.riskySections) && rawOverrides.workflowPolicy.riskySections.length > 0;
          wfHtml += '<div class="settings-control">';
          wfHtml += '<div class="settings-control-header"><span class="settings-control-label">Low confidence threshold</span>' + sourceBadge(lctOverride);
          wfHtml += '<span class="settings-control-value" style="margin-left:auto">' + esc(String(wf.lowConfidenceThreshold != null ? wf.lowConfidenceThreshold : '—')) + '</span>';
          if (isProject && lctOverride) {
            wfHtml += '<button data-ts-action="clearProjectOverride" data-field="lowConfidenceThreshold" class="settings-chip" style="font-size:11px">Clear</button>';
          }
          if (isProject) {
            wfHtml += '</div><div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
              '<input type="number" id="wf-input-lowConfidenceThreshold" min="0" max="1" step="0.05" value="' + esc(String(wf.lowConfidenceThreshold != null ? wf.lowConfidenceThreshold : '')) + '" style="width:100px;border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:var(--text-sm);background:var(--surface);color:var(--ink)">' +
              '<button data-ts-action="setProjectWorkflow" data-field="lowConfidenceThreshold" class="settings-chip active" style="font-size:11px">Set</button>' +
              '</div>';
          } else {
            wfHtml += '</div>';
          }
          wfHtml += '<div class="settings-control-note">Memories below this confidence score are flagged for review.</div></div>';
          wfHtml += '<div class="settings-control">';
          wfHtml += '<div class="settings-control-header"><span class="settings-control-label">Risky sections</span>' + sourceBadge(riskySectionsOverride);
          wfHtml += '<span class="settings-control-value" style="margin-left:auto">' + esc(Array.isArray(wf.riskySections) ? wf.riskySections.join(', ') : '—') + '</span></div>';
          wfHtml += '<div class="settings-control-note">Sections that trigger approval gates when memories are written.</div></div>';
          workflowEl.innerHTML = wfHtml;
        }

        var integrationsEl = document.getElementById('settings-integrations');
        if (integrationsEl && !isProject) {
          var tools = Array.isArray(data.hookTools) ? data.hookTools : [];
          var html = '';
          html += '<div class="settings-control-header" style="margin-bottom:10px"><span class="settings-control-label">Global MCP</span>';
          html += '<button data-ts-action="toggleMcpEnabled" data-enabled="' + (data.mcpEnabled ? 'true' : 'false') + '" class="settings-chip' + (data.mcpEnabled ? ' active' : '') + '">' + (data.mcpEnabled ? 'On' : 'Off') + '</button></div>';
          html += '<table class="settings-integrations-table"><thead><tr><th>Tool</th><th>Hooks</th><th>MCP</th><th>Control</th></tr></thead><tbody>';
          tools.forEach(function(tool) {
            var hooksOn = !!tool.enabled;
            var mcpOn = !!data.mcpEnabled;
            html += '<tr>';
            html += '<td><span class="settings-tool">' + esc(tool.tool) + '</span></td>';
            html += '<td><span class="settings-indicator ' + (hooksOn ? 'on' : 'off') + '"></span>' + (hooksOn ? 'enabled' : 'disabled') + '</td>';
            html += '<td><span class="settings-indicator ' + (mcpOn ? 'on' : 'off') + '"></span>' + (mcpOn ? 'enabled' : 'disabled') + '</td>';
            html += '<td><button data-ts-action="toggleIntegrationTool" data-tool="' + esc(tool.tool) + '" class="settings-chip' + (hooksOn ? ' active' : '') + '">' + (hooksOn ? 'Disable' : 'Enable') + '</button></td>';
            html += '</tr>';
          });
          html += '</tbody></table>';
          integrationsEl.innerHTML = html;
        } else if (integrationsEl && isProject) {
          integrationsEl.innerHTML = '<div style="color:var(--muted);font-size:var(--text-sm)">Integration settings are global — switch to Global scope to edit them.</div>';
        }
      }).catch(function(err) {
        setSettingsStatus('Failed to load settings: ' + String(err), 'err');
      });
    }

    // Hook into switchTab to lazy-load
    var _origSwitchTab = window.switchTab;
    var _tasksLoaded = false;
    var _settingsLoaded = false;
    var _sessionsLoaded = false;
    window.switchTab = function(tab) {
      if (typeof _origSwitchTab === 'function') _origSwitchTab(tab);
      if (tab === 'tasks' && !_tasksLoaded) { _tasksLoaded = true; loadTasks(); }
      if (tab === 'settings' && !_settingsLoaded) { _settingsLoaded = true; loadSettings(); }
      if (tab === 'sessions' && !_sessionsLoaded) { _sessionsLoaded = true; loadSessions(); }
    };

    var _sessionsData = [];
    window.loadSessions = function() {
      var projectFilter = document.getElementById('sessions-filter-project');
      var project = projectFilter ? projectFilter.value : '';
      var apiUrl = _tsAuthToken ? tsAuthUrl('/api/sessions') : '/api/sessions';
      if (project) apiUrl += (apiUrl.includes('?') ? '&' : '?') + 'project=' + encodeURIComponent(project);
      loadJson(apiUrl).then(function(data) {
        if (!data.ok) throw new Error(data.error || 'Failed to load sessions');
        _sessionsData = data.sessions || [];
        renderSessionsList(_sessionsData);
        // Populate project filter
        if (projectFilter && projectFilter.options.length <= 1) {
          var projects = {};
          _sessionsData.forEach(function(s) { if (s.project) projects[s.project] = true; });
          Object.keys(projects).sort().forEach(function(p) {
            var opt = document.createElement('option');
            opt.value = p; opt.textContent = p;
            projectFilter.appendChild(opt);
          });
        }
      }).catch(function(err) {
        var list = document.getElementById('sessions-list');
        if (list) list.innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center">' + esc(err.message) + '</div>';
      });
    };

    function renderSessionsList(sessions) {
      var list = document.getElementById('sessions-list');
      var detail = document.getElementById('session-detail');
      var countEl = document.getElementById('sessions-count');
      if (detail) detail.style.display = 'none';
      if (countEl) countEl.textContent = sessions.length + ' session(s)';
      if (!list) return;
      if (sessions.length === 0) {
        list.innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center"><svg viewBox="0 0 32 32" width="32" height="32" style="display:block;margin:0 auto 12px"><ellipse cx="16" cy="16" rx="10" ry="9.5" fill="#7B68AE" opacity="0.4"/><path d="M12 15l1-1 1 1-1 1z" fill="#2D2255"/><path d="M18 15l1-1 1 1-1 1z" fill="#2D2255"/><path d="M15 18.5c0.3-0.3 0.7-0.3 1 0" stroke="#2D2255" stroke-width="0.6" fill="none"/></svg>No sessions found.</div>';
        return;
      }
      list.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">' +
        '<thead><tr style="border-bottom:1px solid var(--border);text-align:left">' +
        '<th style="padding:8px">Session</th><th style="padding:8px">Project</th><th style="padding:8px">Started</th>' +
        '<th style="padding:8px">Ended</th><th style="padding:8px">Duration</th><th style="padding:8px">Findings</th></tr></thead><tbody>' +
        sessions.map(function(s) {
          var id = s.sessionId.slice(0, 8);
          var startDate = (s.startedAt || '').slice(0, 16).replace('T', ' ');
          var endDate = s.endedAt ? (s.endedAt || '').slice(0, 16).replace('T', ' ') : '<span style="color:var(--green)">active</span>';
          var dur = s.durationMins != null ? s.durationMins + 'm' : '—';
          var summarySnip = s.summary ? '<div class="text-muted" style="font-size:var(--text-xs);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.summary.slice(0, 80)) + '</div>' : '';
          return '<tr style="border-bottom:1px solid var(--border);cursor:pointer" data-ts-action="showSessionDetail" data-session-id="' + esc(s.sessionId) + '">' +
            '<td style="padding:8px;font-family:monospace">' + esc(id) + summarySnip + '</td>' +
            '<td style="padding:8px">' + esc(s.project || '—') + '</td>' +
            '<td style="padding:8px">' + esc(startDate) + '</td>' +
            '<td style="padding:8px">' + endDate + '</td>' +
            '<td style="padding:8px">' + esc(dur) + '</td>' +
            '<td style="padding:8px">' + (s.findingsAdded || 0) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    window.showSessionDetail = function(sessionId) {
      var apiUrl = _tsAuthToken ? tsAuthUrl('/api/sessions') : '/api/sessions';
      apiUrl += (apiUrl.includes('?') ? '&' : '?') + 'sessionId=' + encodeURIComponent(sessionId);
      var list = document.getElementById('sessions-list');
      var detail = document.getElementById('session-detail');
      if (list) list.style.display = 'none';
      if (detail) { detail.style.display = 'block'; detail.innerHTML = '<div style="padding:20px;color:var(--muted)">Loading session...</div>'; }
      loadJson(apiUrl).then(function(data) {
        if (!data.ok) throw new Error(data.error || 'Session not found');
        var s = data.session;
        var findings = data.findings || [];
        var tasks = data.tasks || [];
        var date = (s.startedAt || '').slice(0, 16).replace('T', ' ');
        var dur = s.durationMins != null ? s.durationMins + ' min' : '—';
        var html = '<div style="margin-bottom:12px"><button class="btn btn-sm" data-ts-action="backToSessionsList">← Back</button></div>' +
          '<div class="card" style="margin-bottom:16px"><div class="card-body">' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px">' +
          '<div><strong>Session</strong><div class="text-muted" style="font-family:monospace">' + esc(s.sessionId.slice(0, 8)) + '</div></div>' +
          '<div><strong>Project</strong><div class="text-muted">' + esc(s.project || '—') + '</div></div>' +
          '<div><strong>Date</strong><div class="text-muted">' + esc(date) + '</div></div>' +
          '<div><strong>Duration</strong><div class="text-muted">' + esc(dur) + '</div></div>' +
          '<div><strong>Findings</strong><div class="text-muted">' + findings.length + '</div></div>' +
          '<div><strong>Tasks</strong><div class="text-muted">' + tasks.length + '</div></div>' +
          '<div><strong>Status</strong><div class="text-muted">' + esc(s.status) + '</div></div>' +
          '</div>' +
          (s.summary ? '<div style="margin-top:12px;padding:12px;background:var(--bg);border-radius:var(--radius-sm)"><strong>Summary</strong><div style="margin-top:4px">' + esc(s.summary) + '</div></div>' : '') +
          '</div></div>';
        if (findings.length > 0) {
          html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><h3>Findings (' + findings.length + ')</h3></div><div class="card-body"><ul style="margin:0;padding-left:20px">';
          findings.forEach(function(f) { html += '<li style="margin-bottom:4px"><span class="text-muted">[' + esc(f.project) + ']</span> ' + esc(f.text) + '</li>'; });
          html += '</ul></div></div>';
        }
        if (tasks.length > 0) {
          html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><h3>Tasks (' + tasks.length + ')</h3></div><div class="card-body"><ul style="margin:0;padding-left:20px">';
          tasks.forEach(function(t) { html += '<li style="margin-bottom:4px"><span class="text-muted">[' + esc(t.project) + '/' + esc(t.section) + ']</span> ' + esc(t.text) + '</li>'; });
          html += '</ul></div></div>';
        }
        if (detail) detail.innerHTML = html;
      }).catch(function(err) {
        if (detail) detail.innerHTML = '<div style="padding:20px;color:var(--muted)">' + esc(err.message) + '</div>';
      });
    };

    window.backToSessionsList = function() {
      var list = document.getElementById('sessions-list');
      var detail = document.getElementById('session-detail');
      if (list) list.style.display = 'block';
      if (detail) detail.style.display = 'none';
    };

    // Event delegation for dynamically generated tasks/settings/sessions UI
    document.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function') return;
      var actionEl = target.closest('[data-ts-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-ts-action');
      if (action === 'toggleDoneSection') { toggleDoneSection(actionEl); }
      else if (action === 'completeTask') { completeTaskFromUi(actionEl.getAttribute('data-project'), actionEl.getAttribute('data-item')); }
      else if (action === 'removeTask') { removeTaskFromUi(actionEl.getAttribute('data-project'), actionEl.getAttribute('data-item')); }
      else if (action === 'addTask') { addTaskFromUi(actionEl.getAttribute('data-project')); }
      else if (action === 'setTaskView') { _taskViewMode = actionEl.getAttribute('data-mode') || 'list'; filterTasks(); }
      else if (action === 'setFindingSensitivity') { setFindingSensitivity(actionEl.getAttribute('data-level')); }
      else if (action === 'toggleAutoCapture') { setAutoCapture(actionEl.getAttribute('data-enabled') !== 'true'); }
      else if (action === 'setTaskMode') { setTaskMode(actionEl.getAttribute('data-mode')); }
      else if (action === 'setProactivity') { setProactivity(actionEl.getAttribute('data-level')); }
      else if (action === 'toggleMcpEnabled') { setMcpEnabled(actionEl.getAttribute('data-enabled') !== 'true'); }
      else if (action === 'toggleIntegrationTool') { toggleIntegrationTool(actionEl.getAttribute('data-tool')); }
      else if (action === 'showSessionDetail') { showSessionDetail(actionEl.getAttribute('data-session-id')); }
      else if (action === 'backToSessionsList') { backToSessionsList(); }
      else if (action === 'setProjectFindingSensitivity') {
        var proj = getSettingsProject();
        var level = actionEl.getAttribute('data-level');
        postProjectOverride(proj, 'findingSensitivity', findingUiToStorage(level || 'medium'), false);
      }
      else if (action === 'setProjectTaskMode') {
        var proj = getSettingsProject();
        postProjectOverride(proj, 'taskMode', actionEl.getAttribute('data-mode') || 'auto', false);
      }
      else if (action === 'clearProjectOverride') {
        var proj = getSettingsProject();
        postProjectOverride(proj, actionEl.getAttribute('data-field') || '', '', true);
      }
      else if (action === 'setProjectRetention') {
        var proj = getSettingsProject();
        var field = actionEl.getAttribute('data-field') || '';
        var inputEl = document.getElementById('ret-input-' + field);
        var val = inputEl ? inputEl.value : '';
        postProjectOverride(proj, field, val, false);
      }
      else if (action === 'setProjectWorkflow') {
        var proj = getSettingsProject();
        var field = actionEl.getAttribute('data-field') || '';
        var inputEl = document.getElementById('wf-input-' + field);
        var val = inputEl ? inputEl.value : '';
        postProjectOverride(proj, field, val, false);
      }
    });

    // Keydown delegation for add-task inputs (Enter key)
    document.addEventListener('keydown', function(e) {
      var target = e.target;
      if (!target || !target.getAttribute) return;
      if (target.getAttribute('data-ts-action') === 'addTaskKeydown' && e.key === 'Enter') {
        addTaskFromUi(target.getAttribute('data-project'));
      }
    });

    window.setFindingSensitivity = function(level) {
      var descriptions = {
        high: 'Capture findings proactively, including minor observations.',
        medium: 'Capture findings that are likely useful.',
        low: 'Capture findings only when clearly significant.',
        minimal: 'Only capture explicitly flagged findings.'
      };
      postSettings('/api/settings/finding-sensitivity', { value: findingUiToStorage(level || 'medium') }, 'Finding sensitivity updated.');
      var desc = document.getElementById('settings-fs-desc');
      if (desc) desc.textContent = descriptions[level] || level;
    };

    window.setAutoCapture = function(enabled) {
      postSettings('/api/settings/auto-capture', { enabled: String(!!enabled) }, 'Auto-capture updated.');
    };

    window.setTaskMode = function(mode) {
      postSettings('/api/settings/task-mode', { value: String(mode || 'auto') }, 'Task mode updated.');
    };

    window.setProactivity = function(level) {
      postSettings('/api/settings/proactivity', { value: String(level || 'high') }, 'Proactivity updated.');
    };

    window.setMcpEnabled = function(enabled) {
      postSettings('/api/settings/mcp-enabled', { enabled: String(!!enabled) }, 'MCP setting updated.');
    };

    window.toggleIntegrationTool = function(tool) {
      postSettings('/api/hook-toggle', { tool: String(tool || '') }, 'Integration updated.');
    };
  })();`;
}

export function renderSearchScript(authToken: string): string {
  return `(function() {
  var _searchAuthToken = ${JSON.stringify(authToken)};
  var _searchProjectsLoaded = false;

  function searchAuthUrl(path) {
    return window._phrenAuthUrl ? window._phrenAuthUrl(path) : (_searchAuthToken ? path + (path.includes('?') ? '&' : '?') + '_auth=' + encodeURIComponent(_searchAuthToken) : path);
  }

  var esc = window._phrenEsc;

  function relativeDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var now = new Date();
    var diff = now.getTime() - d.getTime();
    var days = Math.floor(diff / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return '1d ago';
    if (days < 7) return days + 'd ago';
    if (days < 30) return Math.floor(days / 7) + 'w ago';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }

  // Multi-select project filter
  var _selectedProjects = [];
  function getSelectedProjects() { return _selectedProjects.slice(); }
  function toggleProjectFilter(name) {
    var idx = _selectedProjects.indexOf(name);
    if (idx === -1) _selectedProjects.push(name);
    else _selectedProjects.splice(idx, 1);
    renderProjectFilterLabel();
    renderProjectFilterChecks();
  }
  function renderProjectFilterLabel() {
    var btn = document.getElementById('search-project-btn');
    if (!btn) return;
    if (!_selectedProjects.length) btn.textContent = 'All projects';
    else if (_selectedProjects.length === 1) btn.textContent = _selectedProjects[0];
    else btn.textContent = _selectedProjects.length + ' projects';
  }
  function renderProjectFilterChecks() {
    var items = document.querySelectorAll('#search-project-dropdown input[type=checkbox]');
    for (var i = 0; i < items.length; i++) {
      items[i].checked = _selectedProjects.indexOf(items[i].value) !== -1;
    }
  }
  window._phrenToggleProjectDropdown = function() {
    var dd = document.getElementById('search-project-dropdown');
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  };
  document.addEventListener('click', function(e) {
    var wrap = document.getElementById('search-project-wrap');
    var dd = document.getElementById('search-project-dropdown');
    if (wrap && dd && !wrap.contains(e.target)) dd.style.display = 'none';
  });

  function parseResults(lines) {
    var cards = [];
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      if (line.startsWith('[') && line.indexOf(']') > 0) {
        if (current) cards.push(current);
        var bracket = line.indexOf(']');
        var source = line.slice(1, bracket);
        var meta = line.slice(bracket + 1).trim();
        current = { source: source, meta: meta, snippets: [] };
      } else if (line === '(keyword fallback)') {
        // skip
      } else if (current) {
        current.snippets.push(line);
      } else {
        cards.push({ source: '', meta: '', snippets: [line] });
      }
    }
    if (current) cards.push(current);
    return cards;
  }
  function renderCards(cards) {
    var html = '';
    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      html += '<div class="card" style="margin-bottom:8px">';
      html += '<div class="card-header" style="padding:10px 14px;display:flex;align-items:center">';
      if (card.source) {
        html += '<span style="font-weight:500;font-size:var(--text-sm)">' + esc(card.source) + '</span>';
      }
      if (card.meta) {
        html += '<span class="text-muted" style="font-size:var(--text-xs);margin-left:8px">' + esc(card.meta) + '</span>';
      }
      html += '</div>';
      if (card.snippets.length) {
        html += '<div class="card-body" style="padding:10px 14px;font-size:var(--text-sm);white-space:pre-wrap;color:var(--ink-secondary)">';
        html += esc(card.snippets.join('\\n'));
        html += '</div>';
      }
      html += '</div>';
    }
    return html;
  }

  function doSearch() {
    var q = document.getElementById('search-query').value.trim();
    if (!q) return;
    var projects = getSelectedProjects();
    var type = document.getElementById('search-type-filter').value;
    var statusEl = document.getElementById('search-status');
    var resultsEl = document.getElementById('search-results');
    statusEl.textContent = 'Searching...';
    resultsEl.innerHTML = '';

    var fetches = [];
    if (projects.length <= 1) {
      var url = '/api/search?q=' + encodeURIComponent(q) + '&limit=20';
      if (projects.length === 1) url += '&project=' + encodeURIComponent(projects[0]);
      if (type) url += '&type=' + encodeURIComponent(type);
      fetches.push(fetch(searchAuthUrl(url)).then(function(r) { return r.json(); }));
    } else {
      for (var pi = 0; pi < projects.length; pi++) {
        (function(proj) {
          var purl = '/api/search?q=' + encodeURIComponent(q) + '&limit=20&project=' + encodeURIComponent(proj);
          if (type) purl += '&type=' + encodeURIComponent(type);
          fetches.push(fetch(searchAuthUrl(purl)).then(function(r) { return r.json(); }));
        })(projects[pi]);
      }
    }

    Promise.all(fetches).then(function(results) {
      var allCards = [];
      var hasError = false;
      for (var ri = 0; ri < results.length; ri++) {
        if (!results[ri].ok) { hasError = true; continue; }
        var parsed = parseResults(results[ri].results || []);
        allCards = allCards.concat(parsed);
      }
      if (!allCards.length) {
        statusEl.textContent = hasError ? 'Search error.' : 'No results.';
        resultsEl.innerHTML = '<div style="padding:40px;color:var(--muted);text-align:center">' + (hasError ? 'Search failed' : 'No results for \\u201c' + esc(q) + '\\u201d') + '</div>';
        return;
      }
      statusEl.textContent = allCards.length + ' result(s)';
      resultsEl.innerHTML = renderCards(allCards);
    }).catch(function(err) {
      statusEl.textContent = '';
      resultsEl.innerHTML = '<div style="padding:24px;color:var(--muted);text-align:center">Search error: ' + esc(String(err)) + '</div>';
    });
  }

  // Populate project filter dropdown
  function loadSearchProjects() {
    if (_searchProjectsLoaded) return;
    _searchProjectsLoaded = true;
    fetch(searchAuthUrl('/api/projects')).then(function(r) { return r.json(); }).then(function(data) {
      if (!data.ok) return;
      var dd = document.getElementById('search-project-dropdown');
      if (!dd) return;
      var html = '';
      (data.projects || []).forEach(function(p) {
        html += '<label class="search-ms-item" style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:var(--text-sm);white-space:nowrap"><input type="checkbox" value="' + esc(p.name) + '" style="accent-color:var(--accent);cursor:pointer" /><span>' + esc(p.name) + '</span></label>';
      });
      dd.innerHTML = html;
      dd.querySelectorAll('input[type=checkbox]').forEach(function(cb) {
        cb.addEventListener('change', function() { toggleProjectFilter(cb.value); });
      });
    }).catch(function() {});
  }

  // Wire up events
  var searchBtn = document.getElementById('search-btn');
  var searchInput = document.getElementById('search-query');
  if (searchBtn) searchBtn.addEventListener('click', doSearch);
  if (searchInput) searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doSearch();
  });

  // Hook into switchTab to lazy-load project filter
  var _searchOrigSwitchTab = window.switchTab;
  window.switchTab = function(tab) {
    if (typeof _searchOrigSwitchTab === 'function') _searchOrigSwitchTab(tab);
    if (tab === 'search') {
      loadSearchProjects();
      setTimeout(function() { var el = document.getElementById('search-query'); if (el) el.focus(); }, 50);
    }
  };
})();`;
}

export function renderGraphPopupScript(): string {
  return `(function() {
  var popup = document.getElementById('graph-popup');
  var popupCard = document.getElementById('graph-popup-card');
  var popupLabel = document.getElementById('graph-popup-label');
  var popupTitle = document.getElementById('graph-popup-title');
  var popupMeta = document.getElementById('graph-popup-meta');
  var popupBody = document.getElementById('graph-popup-body');
  var popupClose = document.getElementById('graph-popup-close');
  var esc = window._phrenEsc || function(s) { return String(s); };
  var authUrl = window._phrenAuthUrl || function(path) { return path; };
  var authBody = window._phrenAuthBody || function(body) { return body; };
  var fetchCsrfToken = window._phrenFetchCsrfToken || function(cb) { cb(null); };
  var currentDetail = null;
  var isEditing = false;

  function showToast(msg, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 2800);
  }

  function typeLabel(kind) {
    if (kind === 'finding') return 'Finding';
    if (kind === 'task') return 'Task';
    if (kind === 'entity') return 'Fragment';
    if (kind === 'reference') return 'Reference';
    return 'Project';
  }

  function popupPoint(point) {
    return point || { x: 28, y: 28 };
  }

  function renderMeta(detail) {
    if (!popupMeta) return;
    var parts = [];
    if (detail.project) parts.push('<span class="graph-pill">' + esc(detail.project) + '</span>');
    if (detail.section) parts.push('<span class="graph-pill">' + esc(detail.section) + '</span>');
    if (detail.priority) parts.push('<span class="graph-pill">' + esc(detail.priority + ' priority') + '</span>');
    if (detail.entityType) parts.push('<span class="graph-pill">' + esc(detail.entityType) + '</span>');
    if (detail.topicLabel) parts.push('<span class="graph-pill">' + esc(detail.topicLabel) + '</span>');
    if (detail.health) parts.push('<span class="graph-pill graph-pill-' + esc(detail.health) + '">' + esc(detail.health) + '</span>');
    popupMeta.innerHTML = parts.join('');
  }

  function statLine(label, value) {
    return '<div class="graph-popup-line"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>';
  }

  function renderDocs(detail) {
    if (!detail.refDocs || !detail.refDocs.length) return '';
    var docs = detail.refDocs.slice(0, 8).map(function(ref) {
      var doc = typeof ref === 'string' ? ref : (ref.doc || '');
      return '<div class="graph-popup-doc">' + esc(doc) + '</div>';
    }).join('');
    return '<div class="graph-popup-section"><h4>Linked docs</h4><div class="graph-popup-docs">' + docs + '</div></div>';
  }

  function renderProject(detail) {
    var counts = detail.connections || {};
    return '' +
      '<div class="graph-popup-summary">' + esc(detail.fullLabel || detail.label || detail.id) + '</div>' +
      '<div class="graph-popup-stats">' +
        statLine('Neighbors', counts.total || 0) +
        statLine('Findings', counts.findings || 0) +
        statLine('Tasks', counts.tasks || 0) +
        statLine('Fragments', counts.entities || 0) +
        statLine('References', counts.references || 0) +
      '</div>';
  }

  function renderFinding(detail) {
    return '' +
      '<div class="graph-popup-summary" id="graph-popup-text">' + esc(detail.fullLabel || detail.label) + '</div>' +
      '<div class="graph-popup-actions">' +
        '<button class="btn btn-sm" data-graph-action="edit">Edit</button>' +
        '<button class="btn btn-sm" data-graph-action="delete" style="border-color:var(--danger);color:var(--danger)">Delete</button>' +
      '</div>' +
      renderDocs(detail);
  }

  function renderTask(detail) {
    var section = detail.section || 'Queue';
    var priority = detail.priority || 'none';
    return '' +
      '<div class="graph-popup-summary" id="graph-popup-text">' + esc(detail.fullLabel || detail.label) + '</div>' +
      '<div class="graph-popup-section"><h4>Status</h4><div class="graph-popup-actions">' +
        '<button class="btn btn-sm' + (section === 'Active' ? ' active' : '') + '" data-graph-action="task-status" data-status="Active">Active</button>' +
        '<button class="btn btn-sm' + (section === 'Queue' ? ' active' : '') + '" data-graph-action="task-status" data-status="Queue">Queue</button>' +
        '<button class="btn btn-sm" data-graph-action="task-status" data-status="Done">Done</button>' +
      '</div></div>' +
      '<div class="graph-popup-section"><h4>Priority</h4><div class="graph-popup-actions">' +
        '<button class="btn btn-sm' + (priority === 'high' ? ' active' : '') + '" data-graph-action="task-priority" data-priority="high">High</button>' +
        '<button class="btn btn-sm' + (priority === 'medium' ? ' active' : '') + '" data-graph-action="task-priority" data-priority="medium">Medium</button>' +
        '<button class="btn btn-sm' + (priority === 'low' ? ' active' : '') + '" data-graph-action="task-priority" data-priority="low">Low</button>' +
      '</div></div>' +
      '<div class="graph-popup-actions">' +
        '<button class="btn btn-sm" data-graph-action="edit">Edit</button>' +
        '<button class="btn btn-sm" data-graph-action="delete" style="border-color:var(--danger);color:var(--danger)">Delete</button>' +
      '</div>';
  }

  function renderEntity(detail) {
    var projects = (detail.connectedProjects || []).map(function(project) {
      return '<span class="graph-pill">' + esc(project) + '</span>';
    }).join('');
    return '' +
      '<div class="graph-popup-summary">' + esc(detail.fullLabel || detail.label) + '</div>' +
      '<div class="graph-popup-stats">' +
        statLine('References', detail.refCount || 0) +
        statLine('Projects', (detail.connectedProjects || []).length) +
        statLine('Neighbors', (detail.connections && detail.connections.total) || 0) +
      '</div>' +
      (projects ? '<div class="graph-popup-section"><h4>Projects</h4><div class="graph-popup-pills">' + projects + '</div></div>' : '') +
      renderDocs(detail);
  }

  function renderReference(detail) {
    return '' +
      '<div class="graph-popup-summary">' + esc(detail.fullLabel || detail.label) + '</div>' +
      '<div class="graph-popup-stats">' +
        statLine('Project', detail.project || 'shared') +
        statLine('Neighbors', (detail.connections && detail.connections.total) || 0) +
      '</div>' +
      renderDocs(detail);
  }

  function renderEditor(detail) {
    return '' +
      '<div class="graph-popup-editor">' +
        '<textarea id="graph-popup-editor-input">' + esc(detail.fullLabel || detail.label) + '</textarea>' +
        '<div class="graph-popup-actions">' +
          '<button class="btn btn-sm btn-primary" data-graph-action="save-edit">Save</button>' +
          '<button class="btn btn-sm" data-graph-action="cancel-edit">Cancel</button>' +
        '</div>' +
      '</div>';
  }

  function renderBody(detail) {
    if (!popupBody) return;
    if (isEditing && (detail.kind === 'finding' || detail.kind === 'task')) {
      popupBody.innerHTML = renderEditor(detail);
      return;
    }
    if (detail.kind === 'project') popupBody.innerHTML = renderProject(detail);
    else if (detail.kind === 'finding') popupBody.innerHTML = renderFinding(detail);
    else if (detail.kind === 'task') popupBody.innerHTML = renderTask(detail);
    else if (detail.kind === 'entity') popupBody.innerHTML = renderEntity(detail);
    else popupBody.innerHTML = renderReference(detail);
  }

  function positionPopup(point) {
    if (!popupCard) return;
    var container = document.querySelector('#tab-graph .graph-container');
    if (!container) return;
    var rect = container.getBoundingClientRect();
    var width = popupCard.offsetWidth || 360;
    var height = popupCard.offsetHeight || 260;
    var safe = popupPoint(point);
    var left = Math.max(14, Math.min(safe.x + 18, rect.width - width - 14));
    var top = Math.max(14, Math.min(safe.y + 18, rect.height - height - 14));
    popupCard.style.left = left + 'px';
    popupCard.style.top = top + 'px';
  }

  function renderPopup(detail, point) {
    if (!popup || !popupLabel || !popupTitle) return;
    currentDetail = detail;
    popupLabel.textContent = typeLabel(detail.kind);
    popupTitle.textContent = detail.label || detail.fullLabel || detail.id;
    renderMeta(detail);
    renderBody(detail);
    popup.classList.add('open');
    requestAnimationFrame(function() { positionPopup(point); });
  }

  function closePopup(skipSelectionClear) {
    currentDetail = null;
    isEditing = false;
    if (popup) popup.classList.remove('open');
    if (!skipSelectionClear && typeof window.graphClearSelection === 'function') window.graphClearSelection();
  }

  function refetchGraph(keepNodeId) {
    if (typeof window.loadGraph !== 'function') return;
    window.loadGraph();
    if (keepNodeId && window.phrenGraph && typeof window.phrenGraph.selectNode === 'function') {
      var attempts = 0;
      var timer = setInterval(function() {
        attempts++;
        if (window.phrenGraph.selectNode(keepNodeId) || attempts > 18) clearInterval(timer);
      }, 120);
    }
  }

  function postForm(url, method, body, onOk) {
    fetchCsrfToken(function(csrfToken) {
      var nextBody = authBody(body);
      if (csrfToken) nextBody += '&_csrf=' + encodeURIComponent(csrfToken);
      fetch(url, {
        method: method,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: nextBody
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (!data.ok) throw new Error(data.error || 'Request failed');
        onOk(data);
      }).catch(function(err) {
        showToast(String((err && err.message) || err || 'Request failed'), 'err');
      });
    });
  }

  function saveFindingEdit(nextText) {
    postForm(authUrl('/api/findings/' + encodeURIComponent(currentDetail.project)), 'PUT',
      'old_text=' + encodeURIComponent(currentDetail.fullLabel || currentDetail.label) + '&new_text=' + encodeURIComponent(nextText),
      function() {
        currentDetail.fullLabel = nextText;
        currentDetail.label = nextText.length > 55 ? nextText.slice(0, 52) + '...' : nextText;
        isEditing = false;
        renderPopup(currentDetail);
        refetchGraph(currentDetail.id);
        showToast('Finding updated', 'ok');
      }
    );
  }

  function saveTaskEdit(nextText) {
    postForm('/api/tasks/update', 'POST',
      'project=' + encodeURIComponent(currentDetail.project) + '&item=' + encodeURIComponent(currentDetail.fullLabel || currentDetail.label) + '&text=' + encodeURIComponent(nextText),
      function() {
        currentDetail.fullLabel = nextText;
        currentDetail.label = nextText.length > 55 ? nextText.slice(0, 52) + '...' : nextText;
        isEditing = false;
        renderPopup(currentDetail);
        refetchGraph(currentDetail.id);
        showToast('Task updated', 'ok');
      }
    );
  }

  function updateTask(payload) {
    var body = 'project=' + encodeURIComponent(currentDetail.project) + '&item=' + encodeURIComponent(currentDetail.fullLabel || currentDetail.label);
    Object.keys(payload).forEach(function(key) {
      body += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(payload[key]);
    });
    postForm('/api/tasks/update', 'POST', body, function() {
      if (payload.section) currentDetail.section = payload.section;
      if (payload.priority) currentDetail.priority = payload.priority;
      renderPopup(currentDetail);
      refetchGraph(payload.section === 'Done' ? null : currentDetail.id);
      if (payload.section === 'Done') closePopup(true);
      showToast('Task updated', 'ok');
    });
  }

  function completeTask() {
    postForm('/api/tasks/complete', 'POST',
      'project=' + encodeURIComponent(currentDetail.project) + '&item=' + encodeURIComponent(currentDetail.fullLabel || currentDetail.label),
      function() {
        closePopup(true);
        refetchGraph(null);
        showToast('Task completed', 'ok');
      }
    );
  }

  function deleteCurrent() {
    if (!currentDetail) return;
    if (currentDetail.kind === 'finding') {
      postForm(authUrl('/api/findings/' + encodeURIComponent(currentDetail.project)), 'DELETE',
        'text=' + encodeURIComponent(currentDetail.fullLabel || currentDetail.label),
        function() {
          closePopup(true);
          refetchGraph(null);
          showToast('Finding deleted', 'ok');
        }
      );
    } else if (currentDetail.kind === 'task') {
      postForm('/api/tasks/remove', 'POST',
        'project=' + encodeURIComponent(currentDetail.project) + '&item=' + encodeURIComponent(currentDetail.fullLabel || currentDetail.label),
        function() {
          closePopup(true);
          refetchGraph(null);
          showToast('Task deleted', 'ok');
        }
      );
    }
  }

  if (popupClose) popupClose.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    closePopup(false);
  });

  if (popupCard) {
    popupCard.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || typeof target.closest !== 'function' || !currentDetail) return;
      var actionEl = target.closest('[data-graph-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-graph-action');
      if (action === 'edit') {
        isEditing = true;
        renderPopup(currentDetail);
      } else if (action === 'cancel-edit') {
        isEditing = false;
        renderPopup(currentDetail);
      } else if (action === 'save-edit') {
        var input = document.getElementById('graph-popup-editor-input');
        var nextText = input ? input.value.trim() : '';
        if (!nextText) {
          showToast('Text cannot be empty', 'err');
          return;
        }
        if (currentDetail.kind === 'finding') saveFindingEdit(nextText);
        else if (currentDetail.kind === 'task') saveTaskEdit(nextText);
      } else if (action === 'delete') {
        deleteCurrent();
      } else if (action === 'task-status') {
        var status = actionEl.getAttribute('data-status') || 'Queue';
        if (status === 'Done') completeTask();
        else updateTask({ section: status });
      } else if (action === 'task-priority') {
        updateTask({ priority: actionEl.getAttribute('data-priority') || 'medium' });
      }
    });
  }

  document.addEventListener('pointerdown', function(e) {
    if (!popup || !popup.classList.contains('open')) return;
    var target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (popupCard && popupCard.contains(target)) return;
    if (target.closest('.graph-filters') || target.closest('.graph-controls')) return;
    closePopup(false);
  });

  if (window.phrenGraph && typeof window.phrenGraph.onNodeSelect === 'function') {
    window.phrenGraph.onNodeSelect(function(detail, point) {
      isEditing = false;
      renderPopup(detail, point);
    });
  }

  if (window.phrenGraph && typeof window.phrenGraph.onSelectionClear === 'function') {
    window.phrenGraph.onSelectionClear(function() {
      currentDetail = null;
      isEditing = false;
      if (popup) popup.classList.remove('open');
    });
  }
})();`;
}

export function renderEventWiringScript(): string {
  return `(function() {
  // --- Navigation tabs ---
  document.querySelectorAll('.nav-item[data-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() { switchTab(btn.getAttribute('data-tab')); });
  });

  // --- Header buttons ---
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', function() { toggleTheme(); });

  var cmdpalOpenBtn = document.getElementById('cmdpal-open-btn');
  if (cmdpalOpenBtn) {
    cmdpalOpenBtn.addEventListener('click', function() { openCmdPal(); });
    cmdpalOpenBtn.addEventListener('mouseover', function() { this.style.color='var(--ink)'; this.style.borderColor='var(--muted)'; });
    cmdpalOpenBtn.addEventListener('mouseout', function() { this.style.color='var(--muted)'; this.style.borderColor='var(--border)'; });
  }

  // --- Projects search ---
  var projectsSearch = document.getElementById('projects-search');
  if (projectsSearch) projectsSearch.addEventListener('input', function() { filterProjects(this.value); });

  // --- Review filters ---
  var reviewFilterProject = document.getElementById('review-filter-project');
  if (reviewFilterProject) reviewFilterProject.addEventListener('change', function() { filterReviewCards(); });

  var highlightBtn = document.getElementById('highlight-only-btn');
  if (highlightBtn) highlightBtn.addEventListener('change', function() { filterReviewCards(); });

  var selectAllCb = document.getElementById('review-select-all-cb');
  if (selectAllCb) selectAllCb.addEventListener('change', function() { toggleSelectAll(this.checked); });

  // Batch bar buttons
  document.addEventListener('click', function(e) {
    var target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    var actionEl = target.closest('[data-batch-action]');
    if (!actionEl) return;
    var action = actionEl.getAttribute('data-batch-action');
    if (action === 'approve') { batchAction('approve'); }
    else if (action === 'reject') { batchAction('reject'); }
    else if (action === 'clear') { clearBatchSelection(); }
  });

  // --- Graph controls ---
  var graphZoomIn = document.getElementById('graph-zoom-in');
  if (graphZoomIn) graphZoomIn.addEventListener('click', function() { graphZoom(1.2); });
  var graphZoomOut = document.getElementById('graph-zoom-out');
  if (graphZoomOut) graphZoomOut.addEventListener('click', function() { graphZoom(0.8); });
  var graphResetBtn = document.getElementById('graph-reset');
  if (graphResetBtn) graphResetBtn.addEventListener('click', function() { graphReset(); });

  // --- Tasks filters ---
  var tasksFilterProject = document.getElementById('tasks-filter-project');
  if (tasksFilterProject) tasksFilterProject.addEventListener('change', function() { filterTasks(); });
  var tasksFilterSection = document.getElementById('tasks-filter-section');
  if (tasksFilterSection) tasksFilterSection.addEventListener('change', function() { filterTasks(); });

  // --- Sessions filter ---
  var sessionsFilterProject = document.getElementById('sessions-filter-project');
  if (sessionsFilterProject) sessionsFilterProject.addEventListener('change', function() { loadSessions(); });

  // --- Mascot click animation ---
  var mascotSvg = document.querySelector('.header-brand svg');
  if (mascotSvg) {
    mascotSvg.addEventListener('click', function() {
      mascotSvg.classList.remove('popped');
      void mascotSvg.offsetWidth;
      mascotSvg.classList.add('popped');
      mascotSvg.addEventListener('animationend', function handler() {
        mascotSvg.classList.remove('popped');
        mascotSvg.removeEventListener('animationend', handler);
      });
    });
  }

  // --- Command palette ---
  var cmdpal = document.getElementById('cmdpal');
  if (cmdpal) cmdpal.addEventListener('click', function(e) { closeCmdPal(e); });
  var cmdpalBox = document.getElementById('cmdpal-box');
  if (cmdpalBox) cmdpalBox.addEventListener('click', function(e) { e.stopPropagation(); });
  var cmdpalInput = document.getElementById('cmdpal-input');
  if (cmdpalInput) {
    cmdpalInput.addEventListener('input', function() { cmdpalSearch(this.value); });
    cmdpalInput.addEventListener('keydown', function(e) { cmdpalKey(e); });
  }
})();`;
}

export function renderGraphHostScript(): string {
  return `(function() {
  var currentNode = null;
  var editMode = null;

  function graphApi() {
    return window.phrenGraph || null;
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function graphData() {
    var api = graphApi();
    return api && api.getData ? api.getData() : { nodes: [], links: [], topics: [], total: 0 };
  }

  function authToken() {
    try {
      return new URL(window.location.href).searchParams.get('_auth') || '';
    } catch {
      return '';
    }
  }

  function authUrl(path) {
    var token = authToken();
    if (!token) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + '_auth=' + encodeURIComponent(token);
  }

  function graphToast(message, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 2600);
  }

  function fetchCsrfToken() {
    return fetch(authUrl('/api/csrf-token')).then(function(r) { return r.json(); }).then(function(data) {
      return data && data.ok ? (data.token || null) : null;
    }).catch(function() { return null; });
  }

  function formBody(fields, csrfToken) {
    var parts = [];
    Object.keys(fields).forEach(function(key) {
      var value = fields[key];
      if (value === undefined || value === null) return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    });
    if (csrfToken) parts.push('_csrf=' + encodeURIComponent(csrfToken));
    return parts.join('&');
  }

  function graphRequest(path, method, fields) {
    return fetchCsrfToken().then(function(csrfToken) {
      return fetch(authUrl(path), {
        method: method,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody(fields || {}, csrfToken)
      }).then(function(r) { return r.json(); });
    });
  }

  function hidePopover() {
    currentNode = null;
    editMode = null;
    var popover = document.getElementById('graph-node-popover');
    if (popover) popover.style.display = 'none';
    if (typeof window.graphClearSelection === 'function') window.graphClearSelection();
  }

  function positionPopover(x, y) {
    var popover = document.getElementById('graph-node-popover');
    var card = document.getElementById('graph-node-popover-card');
    var container = document.querySelector('#tab-graph .graph-container');
    if (!popover || !card || !container) return;
    popover.style.display = 'block';
    popover.style.visibility = 'hidden';
    requestAnimationFrame(function() {
      var containerRect = container.getBoundingClientRect();
      var cardRect = card.getBoundingClientRect();
      var left = Math.min(Math.max(12, x + 18), Math.max(12, containerRect.width - cardRect.width - 12));
      var top = Math.min(Math.max(12, y + 18), Math.max(12, containerRect.height - cardRect.height - 12));
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      popover.style.visibility = 'visible';
    });
  }

  function currentPopoverPoint() {
    var popover = document.getElementById('graph-node-popover');
    return {
      x: popover ? parseFloat(popover.style.left || '24') : 24,
      y: popover ? parseFloat(popover.style.top || '24') : 24
    };
  }

  function neighborIds(nodeId) {
    var data = graphData();
    var ids = [];
    (data.links || []).forEach(function(link) {
      if (link.source === nodeId) ids.push(link.target);
      else if (link.target === nodeId) ids.push(link.source);
    });
    return ids;
  }

  function nodeMap() {
    var data = graphData();
    var map = {};
    (data.nodes || []).forEach(function(node) { map[node.id] = node; });
    return map;
  }

  function projectCounts(node) {
    var map = nodeMap();
    var counts = { finding: 0, task: 0, entity: 0, reference: 0, other: 0 };
    neighborIds(node.id).forEach(function(id) {
      var neighbor = map[id];
      if (!neighbor) return;
      var kind = neighbor.kind || 'other';
      if (counts[kind] === undefined) counts.other++;
      else counts[kind]++;
    });
    return counts;
  }

  function kindLabel(node) {
    if (!node) return '';
    if (node.kind === 'entity') return node.entityType ? 'Fragment · ' + node.entityType : 'Fragment';
    if (node.kind === 'reference') return 'Reference';
    if (node.kind === 'task') return 'Task';
    if (node.kind === 'project') return 'Project';
    if (node.kind === 'finding') return node.topicLabel ? 'Finding · ' + node.topicLabel : 'Finding';
    return node.kind || 'Node';
  }

  function chip(text, accent) {
    var border = accent ? 'var(--accent)' : 'var(--border)';
    var bg = accent ? 'var(--accent-dim)' : 'var(--surface-raised)';
    return '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid ' + border + ';background:' + bg + ';font-size:11px;color:var(--ink)">' + esc(text) + '</span>';
  }

  function scoreLine(node) {
    var score = typeof node.qualityScore === 'number' ? Math.round(node.qualityScore * 100) : null;
    return score ? chip('Quality ' + score, false) : '';
  }

  function docsList(node) {
    var docs = (node.refDocs || []).map(function(ref) { return ref.doc; });
    if (!docs.length) return '';
    return '<div style="display:flex;flex-wrap:wrap;gap:8px">' + docs.slice(0, 12).map(function(doc) { return chip(doc, false); }).join('') + '</div>';
  }

  function renderView(node) {
    var title = node.displayLabel || node.label || node.tooltipLabel || node.id;
    var meta = [kindLabel(node)];
    if (node.projectName) meta.push(node.projectName);
    if (node.kind === 'task' && node.section) meta.push(node.section);
    if (node.kind === 'task' && node.priority) meta.push('Priority ' + node.priority);
    if (node.kind === 'finding' && node.topicLabel) meta.push(node.topicLabel);

    var header = '<div style="display:flex;flex-direction:column;gap:8px;padding-right:44px"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + esc(kindLabel(node)) + '</div><div style="font-size:var(--text-lg);font-weight:600;line-height:1.2">' + esc(title) + '</div><div style="display:flex;flex-wrap:wrap;gap:8px">' + meta.filter(Boolean).map(function(item, index) { return chip(item, index === 0); }).join('') + scoreLine(node) + '</div></div>';

    var body = '';
    var actions = [];

    if (node.kind === 'project') {
      var counts = projectCounts(node);
      body += '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">';
      body += '<div class="card" style="padding:12px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Findings</div><div style="font-size:var(--text-lg);font-weight:600;margin-top:4px">' + counts.finding + '</div></div>';
      body += '<div class="card" style="padding:12px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Tasks</div><div style="font-size:var(--text-lg);font-weight:600;margin-top:4px">' + counts.task + '</div></div>';
      body += '<div class="card" style="padding:12px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Fragments</div><div style="font-size:var(--text-lg);font-weight:600;margin-top:4px">' + counts.entity + '</div></div>';
      body += '<div class="card" style="padding:12px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">References</div><div style="font-size:var(--text-lg);font-weight:600;margin-top:4px">' + counts.reference + '</div></div>';
      body += '</div>';
    } else if (node.kind === 'finding') {
      body += '<div id="graph-node-text" style="white-space:pre-wrap;line-height:1.65;font-size:var(--text-base)">' + esc(node.tooltipLabel || node.fullLabel || title) + '</div>';
      actions.push('<button type="button" class="btn btn-sm" data-graph-action="edit">Edit</button>');
      actions.push('<button type="button" class="btn btn-sm" data-graph-action="delete" style="border-color:var(--danger);color:var(--danger)">Delete</button>');
    } else if (node.kind === 'task') {
      body += '<div id="graph-node-text" style="white-space:pre-wrap;line-height:1.65;font-size:var(--text-base)">' + esc(node.tooltipLabel || node.fullLabel || title) + '</div>';
      body += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">';
      body += chip('Status ' + (node.section || 'Queue'), true);
      if (node.priority) body += chip('Priority ' + node.priority, false);
      body += '</div>';
      actions.push('<button type="button" class="btn btn-sm" data-graph-action="edit">Edit</button>');
      if ((node.section || '').toLowerCase() !== 'done') actions.push('<button type="button" class="btn btn-sm" data-graph-action="complete">Done</button>');
      if ((node.section || '').toLowerCase() !== 'active') actions.push('<button type="button" class="btn btn-sm" data-graph-action="move-active">Move to Active</button>');
      if ((node.section || '').toLowerCase() !== 'queue') actions.push('<button type="button" class="btn btn-sm" data-graph-action="move-queue">Move to Queue</button>');
      actions.push('<button type="button" class="btn btn-sm" data-graph-action="delete" style="border-color:var(--danger);color:var(--danger)">Delete</button>');
    } else if (node.kind === 'entity') {
      if (node.connectedProjects && node.connectedProjects.length) {
        body += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">' + node.connectedProjects.map(function(project) { return chip(project, true); }).join('') + '</div>';
      }
      body += docsList(node) || '<div class="text-muted">No linked references.</div>';
    } else if (node.kind === 'reference') {
      body += '<div style="white-space:pre-wrap;line-height:1.6;font-size:var(--text-base)">' + esc(node.tooltipLabel || title) + '</div>';
      body += docsList(node);
    } else {
      body += '<div style="white-space:pre-wrap;line-height:1.6;font-size:var(--text-base)">' + esc(node.tooltipLabel || title) + '</div>';
    }

    return header
      + '<div style="display:flex;flex-direction:column;gap:14px;margin-top:16px">' + body + '</div>'
      + (actions.length ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:18px">' + actions.join('') + '</div>' : '');
  }

  function renderEdit(node) {
    var title = node.kind === 'task' ? 'Edit task' : 'Edit finding';
    var text = node.tooltipLabel || node.fullLabel || node.displayLabel || '';
    var section = node.section || 'Queue';
    var priority = node.priority || '';
    var sectionControls = '';
    var priorityControls = '';
    if (node.kind === 'task') {
      sectionControls = '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)">Status<select id="graph-task-section" style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--surface);color:var(--ink)"><option value="Queue"' + (section === 'Queue' ? ' selected' : '') + '>Queue</option><option value="Active"' + (section === 'Active' ? ' selected' : '') + '>Active</option><option value="Done"' + (section === 'Done' ? ' selected' : '') + '>Done</option></select></label>';
      priorityControls = '<label style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)">Priority<select id="graph-task-priority" style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--surface);color:var(--ink)"><option value=""' + (!priority ? ' selected' : '') + '>None</option><option value="high"' + (priority === 'high' ? ' selected' : '') + '>High</option><option value="medium"' + (priority === 'medium' ? ' selected' : '') + '>Medium</option><option value="low"' + (priority === 'low' ? ' selected' : '') + '>Low</option></select></label>';
    }
    return '<div style="display:flex;flex-direction:column;gap:8px;padding-right:44px"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + esc(title) + '</div><div style="font-size:var(--text-md);font-weight:600">' + esc(node.projectName || kindLabel(node)) + '</div></div>'
      + '<div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">'
      + '<textarea id="graph-node-editor" style="min-height:180px;width:100%;border:1px solid var(--border);border-radius:12px;padding:12px 14px;background:var(--surface-sunken);color:var(--ink);font:inherit;line-height:1.55;resize:vertical">' + esc(text) + '</textarea>'
      + (node.kind === 'task' ? '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">' + sectionControls + priorityControls + '</div>' : '')
      + '<div style="display:flex;flex-wrap:wrap;gap:8px"><button type="button" class="btn btn-sm" data-graph-action="save-edit">Save</button><button type="button" class="btn btn-sm" data-graph-action="cancel-edit">Cancel</button></div>'
      + '</div>';
  }

  function renderPopover(node, x, y) {
    currentNode = node;
    var content = document.getElementById('graph-node-content');
    if (!content || !node) {
      currentNode = null;
      editMode = null;
      var popover = document.getElementById('graph-node-popover');
      if (popover) popover.style.display = 'none';
      return;
    }
    content.innerHTML = editMode ? renderEdit(node) : renderView(node);
    bindPopoverActions();
    positionPopover(x, y);
  }

  function matchesNode(node, match) {
    if (!node || !match) return false;
    if (match.id && node.id !== match.id) return false;
    if (match.kind && node.kind !== match.kind) return false;
    if (match.projectName && node.projectName !== match.projectName) return false;
    if (match.tooltipLabel && (node.tooltipLabel || node.fullLabel || '') !== match.tooltipLabel) return false;
    if (match.displayLabel && (node.displayLabel || node.label || '') !== match.displayLabel) return false;
    return true;
  }

  function reloadGraph(match) {
    return fetch(authUrl('/api/graph')).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(data) {
      var api = graphApi();
      if (!api || !api.mount) return;
      api.mount(data);
      if (!match) {
        hidePopover();
        return;
      }
      var next = null;
      var dataNodes = api.getData ? api.getData().nodes : [];
      for (var index = 0; index < dataNodes.length; index++) {
        if (matchesNode(dataNodes[index], match)) {
          next = dataNodes[index];
          break;
        }
      }
      if (next && api.focusNode) api.focusNode(next.id);
      else hidePopover();
    });
  }

  function saveFindingEdit() {
    var editor = document.getElementById('graph-node-editor');
    if (!editor || !currentNode) return;
    var nextText = editor.value.trim();
    if (!nextText || nextText === (currentNode.tooltipLabel || currentNode.fullLabel || '').trim()) {
      editMode = null;
      var point = currentPopoverPoint();
      renderPopover(currentNode, point.x, point.y);
      return;
    }
    graphRequest('/api/findings/' + encodeURIComponent(currentNode.projectName), 'PUT', {
      old_text: currentNode.tooltipLabel || currentNode.fullLabel || '',
      new_text: nextText
    }).then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Save failed');
      graphToast('Finding updated', 'ok');
      editMode = null;
      return reloadGraph({ kind: 'finding', projectName: currentNode.projectName, tooltipLabel: nextText });
    }).catch(function(err) {
      graphToast('Update failed: ' + err.message, 'err');
    });
  }

  function saveTaskEdit() {
    var editor = document.getElementById('graph-node-editor');
    var sectionEl = document.getElementById('graph-task-section');
    var priorityEl = document.getElementById('graph-task-priority');
    if (!editor || !currentNode) return;
    var nextText = editor.value.trim();
    if (!nextText) {
      graphToast('Task text cannot be empty', 'err');
      return;
    }
    var updates = { text: nextText };
    if (sectionEl && sectionEl.value) updates.section = sectionEl.value;
    if (priorityEl) updates.priority = priorityEl.value;
    graphRequest('/api/tasks/update', 'POST', {
      project: currentNode.projectName,
      item: currentNode.tooltipLabel || currentNode.fullLabel || currentNode.displayLabel || '',
      text: updates.text,
      section: updates.section || '',
      priority: updates.priority || ''
    }).then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Save failed');
      graphToast('Task updated', 'ok');
      editMode = null;
      var nextSection = updates.section || currentNode.section || 'Queue';
      if (nextSection === 'Done') {
        hidePopover();
        return reloadGraph(null);
      }
      return reloadGraph({ kind: 'task', projectName: currentNode.projectName, tooltipLabel: nextText });
    }).catch(function(err) {
      graphToast('Update failed: ' + err.message, 'err');
    });
  }

  function deleteCurrentNode() {
    if (!currentNode) return;
    if (!confirm('Delete this ' + (currentNode.kind || 'node') + '?')) return;
    if (currentNode.kind === 'finding') {
      graphRequest('/api/findings/' + encodeURIComponent(currentNode.projectName), 'DELETE', {
        text: currentNode.tooltipLabel || currentNode.fullLabel || ''
      }).then(function(result) {
        if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Delete failed');
        graphToast('Finding deleted', 'ok');
        return reloadGraph(null);
      }).catch(function(err) {
        graphToast('Delete failed: ' + err.message, 'err');
      });
      return;
    }
    if (currentNode.kind === 'task') {
      graphRequest('/api/tasks/remove', 'POST', {
        project: currentNode.projectName,
        item: currentNode.tooltipLabel || currentNode.fullLabel || currentNode.displayLabel || ''
      }).then(function(result) {
        if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Delete failed');
        graphToast('Task removed', 'ok');
        return reloadGraph(null);
      }).catch(function(err) {
        graphToast('Delete failed: ' + err.message, 'err');
      });
    }
  }

  function completeCurrentTask() {
    if (!currentNode) return;
    graphRequest('/api/tasks/complete', 'POST', {
      project: currentNode.projectName,
      item: currentNode.tooltipLabel || currentNode.fullLabel || currentNode.displayLabel || ''
    }).then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Update failed');
      graphToast('Task completed', 'ok');
      return reloadGraph(null);
    }).catch(function(err) {
      graphToast('Update failed: ' + err.message, 'err');
    });
  }

  function moveCurrentTask(section) {
    if (!currentNode) return;
    graphRequest('/api/tasks/update', 'POST', {
      project: currentNode.projectName,
      item: currentNode.tooltipLabel || currentNode.fullLabel || currentNode.displayLabel || '',
      section: section
    }).then(function(result) {
      if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Update failed');
      graphToast('Task moved to ' + section, 'ok');
      return reloadGraph({ kind: 'task', projectName: currentNode.projectName, tooltipLabel: currentNode.tooltipLabel || currentNode.fullLabel || currentNode.displayLabel || '' });
    }).catch(function(err) {
      graphToast('Update failed: ' + err.message, 'err');
    });
  }

  function bindPopoverActions() {
    var closeBtn = document.getElementById('graph-node-close');
    if (closeBtn) closeBtn.onclick = hidePopover;

    document.querySelectorAll('[data-graph-action]').forEach(function(button) {
      button.addEventListener('click', function() {
        var action = button.getAttribute('data-graph-action');
        if (action === 'edit') {
          editMode = currentNode && (currentNode.kind === 'finding' || currentNode.kind === 'task') ? currentNode.kind : null;
          var point = currentPopoverPoint();
          renderPopover(currentNode, point.x, point.y);
        } else if (action === 'cancel-edit') {
          editMode = null;
          var point = currentPopoverPoint();
          renderPopover(currentNode, point.x, point.y);
        } else if (action === 'save-edit') {
          if (editMode === 'task') saveTaskEdit();
          else saveFindingEdit();
        } else if (action === 'delete') {
          deleteCurrentNode();
        } else if (action === 'complete') {
          completeCurrentTask();
        } else if (action === 'move-active') {
          moveCurrentTask('Active');
        } else if (action === 'move-queue') {
          moveCurrentTask('Queue');
        }
      });
    });
  }

  function ensureHostBindings() {
    var api = graphApi();
    if (!api || !api.onNodeSelect) return false;
    api.onNodeSelect(function(node, x, y) {
      if (!node) {
        currentNode = null;
        editMode = null;
        var popover = document.getElementById('graph-node-popover');
        if (popover) popover.style.display = 'none';
        return;
      }
      editMode = null;
      renderPopover(node, x, y);
    });
    if (typeof api.onSelectionClear === 'function') {
      api.onSelectionClear(function() {
        currentNode = null;
        editMode = null;
        var popover = document.getElementById('graph-node-popover');
        if (popover) popover.style.display = 'none';
      });
    }
    return true;
  }

  function onOutsidePointer(event) {
    var popover = document.getElementById('graph-node-popover-card');
    if (!currentNode || !popover) return;
    if (popover.contains(event.target)) return;
    hidePopover();
  }

  function onEscape(event) {
    if (event.key !== 'Escape' || !currentNode) return;
    if (editMode) {
      editMode = null;
      var point = currentPopoverPoint();
      renderPopover(currentNode, point.x, point.y);
      return;
    }
    hidePopover();
  }

  document.addEventListener('pointerdown', onOutsidePointer);
  document.addEventListener('keydown', onEscape);

  if (!ensureHostBindings()) {
    var tries = 0;
    var timer = setInterval(function() {
      tries++;
      if (ensureHostBindings() || tries > 40) clearInterval(timer);
    }, 100);
  }
})();`;
}
