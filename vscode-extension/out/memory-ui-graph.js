/**
 * Canvas2D knowledge graph renderer for the review-ui.
 *
 * Returns raw JavaScript (no <script> tags) that expects these DOM elements
 * to exist in the host page:
 *   - <canvas id="graph-canvas"> inside .graph-container
 *   - <div id="graph-tooltip">
 *   - <div class="graph-controls"> with zoom/reset buttons
 *   - <div id="graph-filter">, <div id="graph-project-filter">, <div id="graph-limit-row">
 *   - <div class="graph-legend">
 *   - <div id="graph-detail-panel"> with graph-detail-meta and graph-detail-body
 *
 * Self-contained: defines its own esc() helper and accepts data via
 * window.cortexGraph.mount(data) — no external dependencies.
 */
export function renderGraphScript() {
    return `
/* ── Knowledge Graph (Canvas2D + Barnes-Hut) ─────────────────────────── */
(function() {
  'use strict';

  /* ── internal helpers ────────────────────────────────────────────────── */
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── colour & size maps ─────────────────────────────────────────────── */
  /* Fixed colors for non-finding node types */
  var COLORS = {
    project: '#7c3aed',
    'task-active': '#10b981', 'task-queue': '#eab308',
    entity: '#06b6d4', reference: '#14b8a6',
    other: '#f4a261'
  };
  var RADII = {
    project: 18,
    'task-active': 7, 'task-queue': 7,
    entity: 10, reference: 6,
    other: 8
  };

  /* ── topic color generation ──────────────────────────────────────────── */
  /* Hash a topic slug to a stable hue in a palette that avoids reserved hues */
  var _topicColorCache = {};
  function topicSlugToColor(slug) {
    if (_topicColorCache[slug]) return _topicColorCache[slug];
    /* djb2-style hash */
    var h = 5381;
    for (var i = 0; i < slug.length; i++) {
      h = ((h << 5) + h) ^ slug.charCodeAt(i);
      h = h >>> 0;
    }
    /* Spread hues across full spectrum, skip reserved purple (270-290) used for project */
    var hue = (h % 300 + 30) % 360; /* shift away from 0/360 */
    if (hue >= 265 && hue <= 295) hue = (hue + 40) % 360; /* skip project purple band */
    var color = 'hsl(' + hue + ',65%,50%)';
    _topicColorCache[slug] = color;
    return color;
  }

  function topicGroupColor(group) {
    /* group is 'topic:<slug>' for findings */
    if (typeof group === 'string' && group.indexOf('topic:') === 0) {
      return topicSlugToColor(group.slice(6));
    }
    return COLORS[group] || COLORS.other;
  }

  /* ── state ──────────────────────────────────────────────────────────── */
  var allNodes = [], allLinks = [], allScores = {}, allTopics = [];
  var visibleNodes = [], visibleLinks = [];
  var scale = 1, panX = 0, panY = 0;
  var W = 0, H = 0;
  var selectedNode = null;
  var searchQuery = '';
  var filterTypes = { project: true, finding: true, task: true, entity: true, reference: true };
  var filterProject = 'all';
  var filterHealth = 'all';
  var nodeLimit = 500;
  var dragging = null, dragOffX = 0, dragOffY = 0;
  var panning = false, panStartX = 0, panStartY = 0;
  var alpha = 1.0;
  var animFrame = null;
  var canvas, ctx, tooltip;
  var pulseT = 0;
  var _tooltipNode = null, _tooltipTimer = null;
  var _prevVisibleCount = 0;
  var focusedNodeIndex = -1;
  var liveRegion = null;

  /* ── helpers ────────────────────────────────────────────────────────── */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function nodeRadius(n) {
    if (n.group === 'entity') return Math.min(6 + (n.refCount || 0), 16);
    if (typeof n.group === 'string' && n.group.indexOf('topic:') === 0) return RADII.other;
    return RADII[n.group] || RADII.other;
  }

  function nodeColor(n) { return topicGroupColor(n.group); }

  /* ── precomputed score lookups ─────────────────────────────────────── */
  var _scoreLookup = {};  // project -> best score entry (precomputed)

  function buildScoreLookup() {
    _scoreLookup = {};
    if (!allScores) return;
    var keys = Object.keys(allScores);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var slashIdx = key.indexOf('/');
      if (slashIdx === -1) continue;
      var proj = key.substring(0, slashIdx);
      var s = allScores[key];
      var existing = _scoreLookup[proj];
      if (!existing || (s.impressions || 0) > (existing.impressions || 0)) {
        _scoreLookup[proj] = s;
      }
    }
  }

  function bestScoreForNode(node) {
    if (!node.project) return null;
    return _scoreLookup[node.project] || null;
  }

  /* ── quality / decay (unified thresholds) ────────────────────────── */
  function computeQualityFromEntry(entry) {
    if (!entry) return { multiplier: 1.0, daysSince: -1 };
    var now = Date.now();
    var lastUsed = entry.lastUsedAt ? new Date(entry.lastUsedAt).getTime() : 0;
    var daysSince = lastUsed ? (now - lastUsed) / 86400000 : 999;

    var recencyBoost = 0;
    if (daysSince <= 7) recencyBoost = 0.15;
    else if (daysSince <= 30) recencyBoost = 0;
    else recencyBoost = Math.max(-0.3, -0.1 * Math.floor((daysSince - 30) / 30));

    var impressions = entry.impressions || 0;
    var frequencyBoost = Math.min(0.2, Math.log(impressions + 1) / Math.LN2 * 0.05);

    var helpful = entry.helpful || 0;
    var reprompt = entry.repromptPenalty || 0;
    var regression = entry.regressionPenalty || 0;
    var feedbackScore = helpful * 0.15 - (reprompt + regression * 2) * 0.2;

    return { multiplier: clamp(1 + feedbackScore + recencyBoost + frequencyBoost, 0.2, 1.5), daysSince: daysSince };
  }

  function qualityMultiplier(node) {
    return computeQualityFromEntry(bestScoreForNode(node)).multiplier;
  }

  /* ── relevance score (drives gravity toward center) ──────────────── */
  // Combines frequency (refCount/impressions) + recency (quality multiplier)
  // Returns 0.1 (stale/rarely-used → drifts to edges) to 1.0 (active/important → pulls to center)
  function nodeRelevance(node) {
    // Project nodes always anchor at center
    if (node.group === 'project') return 1.0;

    // Frequency component: refCount or link degree (log scale, capped)
    var refs = node.refCount || 0;
    var freqScore = Math.min(1.0, Math.log(refs + 1) / Math.log(20)); // 0 refs → 0, 20+ refs → 1.0

    // Recency/quality component from score data
    var qualScore = 0.5; // default when no score data
    var entry = bestScoreForNode(node);
    if (entry) {
      var q = computeQualityFromEntry(entry);
      qualScore = clamp((q.multiplier - 0.2) / 1.3, 0, 1); // normalize 0.2-1.5 → 0-1
    }

    // Blend: 40% frequency, 60% recency/quality
    var raw = freqScore * 0.4 + qualScore * 0.6;
    return clamp(raw, 0.1, 1.0);
  }

  // Unified health ring thresholds: matches the quality multiplier thresholds
  // multiplier >= 0.8 -> healthy (green), 0.5-0.8 -> stale (yellow), <0.5 -> decaying (red)
  function healthRingColor(node) {
    var entry = bestScoreForNode(node);
    if (!entry || !entry.lastUsedAt) return null;
    var q = computeQualityFromEntry(entry);
    if (q.multiplier >= 0.8) return '#10b981';
    if (q.multiplier >= 0.5) return '#f59e0b';
    return '#ef4444';
  }


  function healthStatusLabel(node) {
    var entry = bestScoreForNode(node);
    if (!entry || !entry.lastUsedAt) return null;
    var q = computeQualityFromEntry(entry);
    if (q.multiplier >= 0.8) return 'H';
    if (q.multiplier >= 0.5) return 'S';
    return 'D';
  }

  function healthStatusText(node) {
    var entry = bestScoreForNode(node);
    if (!entry || !entry.lastUsedAt) return 'unknown';
    var q = computeQualityFromEntry(entry);
    if (q.multiplier >= 0.8) return 'healthy';
    if (q.multiplier >= 0.5) return 'stale';
    return 'decaying';
  }

  function healthRingDash(node) {
    var entry = bestScoreForNode(node);
    if (!entry || !entry.lastUsedAt) return null;
    var q = computeQualityFromEntry(entry);
    if (q.multiplier >= 0.8) return [];
    if (q.multiplier >= 0.5) return [6, 3];
    return [2, 3];
  }

  function announce(text) {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    setTimeout(function() { liveRegion.textContent = text; }, 50);
  }

  function announceNode(node) {
    if (!node) { announce('No node selected'); return; }
    var parts = [node.label || node.id, node.group || 'node'];
    var health = healthStatusText(node);
    if (health !== 'unknown') parts.push(health + ' health');
    announce('Selected: ' + parts.join(', '));
  }

  function announceFilterChange() {
    announce('Showing ' + visibleNodes.length + ' of ' + allNodes.length + ' nodes');
  }

  function announceGraphSummary() {
    var counts = {};
    for (var i = 0; i < allNodes.length; i++) {
      var g = allNodes[i].group || 'other';
      counts[g] = (counts[g] || 0) + 1;
    }
    var parts = [];
    if (counts.project) parts.push(counts.project + ' projects');
    var fc = 0;
    var cKeys = Object.keys(counts);
    for (var f = 0; f < cKeys.length; f++) {
      if (cKeys[f].indexOf('topic:') === 0) fc += counts[cKeys[f]];
    }
    if (fc) parts.push(fc + ' findings');
    if (counts.entity) parts.push(counts.entity + ' entities');
    var tc = (counts['task-active']||0) + (counts['task-queue']||0);
    if (tc) parts.push(tc + ' tasks');
    announce('Graph with ' + parts.join(', '));
  }

  function panToNode(node) {
    if (!node) return;
    panX = W / 2 - node.x * scale;
    panY = H / 2 - node.y * scale;
  }

  /* ── Barnes-Hut Quadtree ────────────────────────────────────────────── */
  var QT_CAPACITY = 1;
  function QTNode(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.body = null; this.totalMass = 0; this.cx = 0; this.cy = 0;
    this.nw = null; this.ne = null; this.sw = null; this.se = null;
    this.divided = false;
  }
  QTNode.prototype.contains = function(px, py) {
    return px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h;
  };
  QTNode.prototype.subdivide = function() {
    var hw = this.w / 2, hh = this.h / 2;
    this.nw = new QTNode(this.x, this.y, hw, hh);
    this.ne = new QTNode(this.x + hw, this.y, hw, hh);
    this.sw = new QTNode(this.x, this.y + hh, hw, hh);
    this.se = new QTNode(this.x + hw, this.y + hh, hw, hh);
    this.divided = true;
  };
  QTNode.prototype.insert = function(node) {
    if (!this.contains(node.x, node.y)) return false;
    // Min-cell guard: stop subdividing when cell is too small (prevents infinite recursion
    // from duplicate/near-duplicate positions)
    if (this.w < 0.01 || this.h < 0.01) {
      this.totalMass++;
      this.cx = (this.cx * (this.totalMass - 1) + node.x) / this.totalMass;
      this.cy = (this.cy * (this.totalMass - 1) + node.y) / this.totalMass;
      return true;
    }
    if (!this.body && !this.divided) {
      this.body = node;
      this.totalMass = 1;
      this.cx = node.x;
      this.cy = node.y;
      return true;
    }
    if (!this.divided) {
      // Jitter duplicate positions to prevent infinite subdivision
      if (this.body && this.body.x === node.x && this.body.y === node.y) {
        node.x += (Math.random() - 0.5) * 0.1;
        node.y += (Math.random() - 0.5) * 0.1;
      }
      this.subdivide();
      if (this.body) {
        var old = this.body;
        this.body = null;
        this.nw.insert(old);
        this.ne.insert(old);
        this.sw.insert(old);
        this.se.insert(old);
      }
    }
    var inserted = this.nw.insert(node) || this.ne.insert(node) || this.sw.insert(node) || this.se.insert(node);
    if (inserted) {
      this.totalMass++;
      this.cx = (this.cx * (this.totalMass - 1) + node.x) / this.totalMass;
      this.cy = (this.cy * (this.totalMass - 1) + node.y) / this.totalMass;
    }
    return inserted;
  };
  QTNode.prototype.computeForce = function(node, theta, repulsion, fx, fy) {
    if (this.totalMass === 0) return { fx: fx, fy: fy };
    var dx = this.cx - node.x;
    var dy = this.cy - node.y;
    var dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
    if (!this.divided || (this.w / dist < theta)) {
      var force = -repulsion * this.totalMass / (dist * dist);
      fx += force * dx / dist;
      fy += force * dy / dist;
      return { fx: fx, fy: fy };
    }
    var r;
    if (this.nw) { r = this.nw.computeForce(node, theta, repulsion, fx, fy); fx = r.fx; fy = r.fy; }
    if (this.ne) { r = this.ne.computeForce(node, theta, repulsion, fx, fy); fx = r.fx; fy = r.fy; }
    if (this.sw) { r = this.sw.computeForce(node, theta, repulsion, fx, fy); fx = r.fx; fy = r.fy; }
    if (this.se) { r = this.se.computeForce(node, theta, repulsion, fx, fy); fx = r.fx; fy = r.fy; }
    return { fx: fx, fy: fy };
  };

  /* ── force simulation ───────────────────────────────────────────────── */
  var THETA = 0.7, REPULSION = 8000, SPRING_K = 0.02, REST_LEN = 120;
  var GRAVITY = 0.006, ALPHA_DECAY = 0.04, MIN_ALPHA = 0.005, DAMPING = 0.35;

  var SMALL_GRAPH_THRESHOLD = 100;

  function simulate() {
    if (alpha < MIN_ALPHA) return;

    var nodes = visibleNodes;
    var links = visibleLinks;
    var n = nodes.length;
    if (n === 0) return;

    if (n < SMALL_GRAPH_THRESHOLD) {
      /* direct N^2 repulsion for small graphs (cheaper than quadtree overhead) */
      for (var i = 0; i < n; i++) {
        var nd = nodes[i];
        if (nd === dragging) continue;
        var fx = 0, fy = 0;
        for (var j = 0; j < n; j++) {
          if (i === j) continue;
          var dx = nodes[j].x - nd.x;
          var dy = nodes[j].y - nd.y;
          var dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
          var force = -REPULSION / (dist * dist);
          fx += force * dx / dist;
          fy += force * dy / dist;
        }
        nd.vx = (nd.vx || 0) + fx * alpha;
        nd.vy = (nd.vy || 0) + fy * alpha;
      }
    } else {
      /* build quadtree for Barnes-Hut */
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < n; i++) {
        if (nodes[i].x < minX) minX = nodes[i].x;
        if (nodes[i].y < minY) minY = nodes[i].y;
        if (nodes[i].x > maxX) maxX = nodes[i].x;
        if (nodes[i].y > maxY) maxY = nodes[i].y;
      }
      var pad = 100;
      var qt = new QTNode(minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2);
      for (var i = 0; i < n; i++) qt.insert(nodes[i]);

      /* repulsion via quadtree */
      for (var i = 0; i < n; i++) {
        var nd = nodes[i];
        if (nd === dragging) continue;
        var r = qt.computeForce(nd, THETA, REPULSION, 0, 0);
        nd.vx = (nd.vx || 0) + r.fx * alpha;
        nd.vy = (nd.vy || 0) + r.fy * alpha;
      }
    }

    /* spring forces */
    for (var i = 0; i < links.length; i++) {
      var lk = links[i];
      var s = lk._source, t = lk._target;
      if (!s || !t) continue;
      var dx = t.x - s.x, dy = t.y - s.y;
      var dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
      var force = SPRING_K * (dist - REST_LEN) * alpha;
      var fx = force * dx / dist, fy = force * dy / dist;
      if (s !== dragging) { s.vx += fx; s.vy += fy; }
      if (t !== dragging) { t.vx -= fx; t.vy -= fy; }
    }

    /* relevance-based center gravity: relevant nodes pull to center, stale drift out */
    var cx = W / 2 / scale - panX / scale;
    var cy = H / 2 / scale - panY / scale;
    /* scale gravity down for larger graphs so clusters spread */
    var gravScale = n > 50 ? 50 / n : 1;
    for (var i = 0; i < n; i++) {
      var nd = nodes[i];
      if (nd === dragging) continue;
      var rel = nodeRelevance(nd);
      // relevance modulates gravity: high relevance → 3x base, low → 0.3x base
      // this creates a natural center-to-edge gradient by importance
      var grav = GRAVITY * (0.3 + rel * 2.7) * gravScale;
      nd.vx += (cx - nd.x) * grav * alpha;
      nd.vy += (cy - nd.y) * grav * alpha;
    }

    /* integrate */
    for (var i = 0; i < n; i++) {
      var nd = nodes[i];
      if (nd === dragging) continue;
      nd.vx *= DAMPING;
      nd.vy *= DAMPING;
      nd.x += nd.vx;
      nd.y += nd.vy;
    }

    alpha *= (1 - ALPHA_DECAY);
    if (alpha < MIN_ALPHA) alpha = 0;
  }

  /* ── filtering ──────────────────────────────────────────────────────── */
  var TASK_GROUPS = { 'task-active': 1, 'task-queue': 1 };

  function isFindingGroup(group) {
    return typeof group === 'string' && group.indexOf('topic:') === 0;
  }

  function typeMatches(group) {
    if (group === 'project') return !!filterTypes.project;
    if (isFindingGroup(group)) {
      /* master finding toggle must be on */
      if (!filterTypes.finding) return false;
      /* if there's a per-topic filter, check it */
      if (group in filterTypes) return !!filterTypes[group];
      return true;
    }
    if (TASK_GROUPS[group]) return !!filterTypes.task;
    if (group === 'entity') return !!filterTypes.entity;
    if (group === 'reference') return !!filterTypes.reference;
    return true;
  }

  function applyFilters() {
    // Clear stale selection when filters change — the selected node may no longer be visible
    if (selectedNode) {
      selectedNode = null;
      var metaEl = document.getElementById('graph-detail-meta');
      var bodyEl = document.getElementById('graph-detail-body');
      if (metaEl) metaEl.innerHTML = 'Click a bubble to inspect it.';
      if (bodyEl) bodyEl.innerHTML = '<p class="text-muted" style="margin:0">Use the graph filters, then click a project or finding bubble to pin its details here.</p>';
    }
    var nodeMap = {};
    var filtered = [];
    for (var i = 0; i < allNodes.length; i++) {
      var n = allNodes[i];
      if (!typeMatches(n.group)) continue;
      if (filterProject !== 'all' && n.project !== filterProject) continue;
      if (filterHealth !== 'all') {
        var mult = qualityMultiplier(n);
        if (filterHealth === 'healthy' && mult < 0.8) continue;
        if (filterHealth === 'stale' && (mult < 0.5 || mult >= 0.8)) continue;
        if (filterHealth === 'decaying' && mult >= 0.5) continue;
      }
      filtered.push(n);
    }
    /* apply limit */
    filtered.sort(function(a, b) { return (b.refCount || 0) - (a.refCount || 0); });
    visibleNodes = filtered.slice(0, nodeLimit);
    for (var i = 0; i < visibleNodes.length; i++) nodeMap[visibleNodes[i].id] = visibleNodes[i];

    visibleLinks = [];
    for (var i = 0; i < allLinks.length; i++) {
      var lk = allLinks[i];
      var s = nodeMap[lk.source];
      var t = nodeMap[lk.target];
      if (s && t) {
        lk._source = s;
        lk._target = t;
        visibleLinks.push(lk);
      }
    }

    updateLegend();
    /* only restart simulation if node count changed significantly */
    var oldCount = _prevVisibleCount || 0;
    _prevVisibleCount = visibleNodes.length;
    if (oldCount === 0 || Math.abs(visibleNodes.length - oldCount) > oldCount * 0.1) {
      alpha = 1.0;
    }
  }

  /* ── legend ─────────────────────────────────────────────────────────── */
  function updateLegend() {
    var legendEl = document.querySelector('.graph-legend');
    if (!legendEl) return;
    var seenGroups = {};
    for (var i = 0; i < visibleNodes.length; i++) seenGroups[visibleNodes[i].group] = 1;
    var html = '';
    /* Fixed node types first */
    var fixedOrder = ['project', 'task-active', 'task-queue', 'entity', 'reference'];
    var fixedLabels = { project: 'Project', 'task-active': 'Active Task', 'task-queue': 'Queued Task', entity: 'Entity', reference: 'Reference' };
    for (var i = 0; i < fixedOrder.length; i++) {
      var g = fixedOrder[i];
      if (!seenGroups[g]) continue;
      html += '<span class="graph-legend-item"><span class="graph-legend-dot" style="background:' + topicGroupColor(g) + '"></span> ' + esc(fixedLabels[g] || g) + '</span>';
    }
    /* Dynamic topic groups */
    var seenTopics = {};
    for (var i = 0; i < visibleNodes.length; i++) {
      var nd = visibleNodes[i];
      if (typeof nd.group === 'string' && nd.group.indexOf('topic:') === 0) {
        var slug = nd.group.slice(6);
        if (!seenTopics[slug]) {
          seenTopics[slug] = nd.topicLabel || slug;
        }
      }
    }
    /* Sort topics by label for stable order */
    var topicSlugs = Object.keys(seenTopics).sort(function(a, b) { return seenTopics[a].localeCompare(seenTopics[b]); });
    for (var i = 0; i < topicSlugs.length; i++) {
      var slug = topicSlugs[i];
      html += '<span class="graph-legend-item"><span class="graph-legend-dot" style="background:' + topicGroupColor('topic:' + slug) + '"></span> ' + esc(seenTopics[slug]) + '</span>';
    }
    legendEl.innerHTML = html;
  }

  /* ── rendering ──────────────────────────────────────────────────────── */
  function render() {
    if (!canvas || !ctx) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* theme-aware background */
    var isDarkBg = document.documentElement.getAttribute('data-theme') === 'dark';
    ctx.fillStyle = isDarkBg ? '#0b0f1a' : '#f8f9fb';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    pulseT += 0.016;

    var nodes = visibleNodes;
    var links = visibleLinks;

    /* 1. edges */
    ctx.lineWidth = Math.max(0.5, Math.min(0.8 / scale, 3));
    if (searchQuery) {
      var _sq = searchQuery.toLowerCase();
      for (var i = 0; i < links.length; i++) {
        var lk = links[i];
        if (!lk._source || !lk._target) continue;
        var sMatch = ((lk._source.label || '').toLowerCase().indexOf(_sq) !== -1 || (lk._source.fullLabel || '').toLowerCase().indexOf(_sq) !== -1);
        var tMatch = ((lk._target.label || '').toLowerCase().indexOf(_sq) !== -1 || (lk._target.fullLabel || '').toLowerCase().indexOf(_sq) !== -1);
        ctx.beginPath();
        ctx.strokeStyle = (sMatch || tMatch) ? 'rgba(150,150,150,0.18)' : 'rgba(150,150,150,0.04)';
        ctx.moveTo(lk._source.x, lk._source.y);
        ctx.lineTo(lk._target.x, lk._target.y);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(150,150,150,0.18)';
      for (var i = 0; i < links.length; i++) {
        var lk = links[i];
        if (!lk._source || !lk._target) continue;
        ctx.moveTo(lk._source.x, lk._source.y);
        ctx.lineTo(lk._target.x, lk._target.y);
      }
      ctx.stroke();
    }

    /* 2. health rings with dash patterns + text labels (WCAG 1.4.1) */
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var rc = healthRingColor(nd);
      if (!rc) continue;
      var rr = nodeRadius(nd) + 3;
      var dash = healthRingDash(nd);
      ctx.beginPath();
      ctx.strokeStyle = rc;
      ctx.lineWidth = 2 / scale;
      if (dash && dash.length) { ctx.setLineDash(dash.map(function(d) { return d / scale; })); }
      else { ctx.setLineDash([]); }
      ctx.arc(nd.x, nd.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 3. nodes (batch by fill colour, apply opacity) */
    var fillBuckets = {};
    for (var i = 0; i < nodes.length; i++) {
      var c = nodeColor(nodes[i]);
      if (!fillBuckets[c]) fillBuckets[c] = [];
      fillBuckets[c].push(nodes[i]);
    }
    var fillColors = Object.keys(fillBuckets);
    for (var ci = 0; ci < fillColors.length; ci++) {
      var col = fillColors[ci];
      var bucket = fillBuckets[col];
      for (var i = 0; i < bucket.length; i++) {
        var nd = bucket[i];
        var mult = qualityMultiplier(nd);
        var opacity = 0.3 + (mult - 0.2) * (0.7 / 1.3);
        opacity = clamp(opacity, 0.3, 1.0);
        /* dim non-matching nodes when search is active */
        if (searchQuery) {
          var sq = searchQuery.toLowerCase();
          var sl = (nd.label || '').toLowerCase();
          var sf = (nd.fullLabel || '').toLowerCase();
          if (sl.indexOf(sq) === -1 && sf.indexOf(sq) === -1) opacity = 0.1;
        }
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nodeRadius(nd), 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1.0;

    /* 3b. health status text labels on top of nodes (WCAG 1.4.1) */
    if (scale >= 0.4) {
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        var hlbl = healthStatusLabel(nd);
        if (!hlbl) continue;
        var hfs = Math.max(7, Math.round(8 / scale));
        ctx.font = '600 ' + hfs + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.9;
        ctx.fillText(hlbl, nd.x, nd.y);
      }
      ctx.globalAlpha = 1.0;
    }

    /* 4. pulse rings for high-helpful nodes */
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var sc = matchScore(nd);
      if (!sc || (sc.helpful || 0) < 3) continue;
      var pr = nodeRadius(nd) + 1 * Math.sin(pulseT * Math.PI);
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, pr + 2, 0, Math.PI * 2);
      ctx.strokeStyle = nodeColor(nd);
      ctx.lineWidth = 1.5 / scale;
      ctx.globalAlpha = 0.4;
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    /* 5. labels (semantic zoom with text backgrounds) */
    if (scale >= 0.2) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      var labelFg = isDark ? '#e0e0e0' : '#111827';
      var labelBg = isDark ? 'rgba(11,15,26,0.85)' : 'rgba(248,249,251,0.9)';
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        var r = nodeRadius(nd);
        var show = false;
        var fontSize = Math.max(10, Math.round(11 / scale));
        if (nd.group === 'project') {
          show = true;
          ctx.font = 'bold ' + Math.max(11, Math.round(13 / scale)) + 'px sans-serif';
        } else if (scale >= 0.6) {
          show = true;
          ctx.font = '500 ' + fontSize + 'px sans-serif';
        } else if (scale >= 0.35 && nd.group === 'entity' && (nd.refCount || 0) > 2) {
          show = true;
          ctx.font = '500 ' + fontSize + 'px sans-serif';
        }
        if (show) {
          var lbl = nd.label || '';
          if (lbl.length > 28) lbl = lbl.slice(0, 26) + '..';
          var labelPad = r + 6;
          var lx = nd.x, ly = nd.y + labelPad;
          var tw = ctx.measureText(lbl).width;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = labelBg;
          ctx.fillRect(lx - tw / 2 - 4, ly - 2, tw + 8, fontSize + 4);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = labelFg;
          ctx.fillText(lbl, lx, ly);
          ctx.globalAlpha = 1.0;
        }
      }
    }

    /* 6. selection highlight */
    if (selectedNode) {
      ctx.beginPath();
      ctx.arc(selectedNode.x, selectedNode.y, nodeRadius(selectedNode) + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5 / scale;
      ctx.stroke();
    }

    /* 6b. keyboard focus ring (distinct from selection) */
    if (focusedNodeIndex >= 0 && focusedNodeIndex < visibleNodes.length) {
      var fNode = visibleNodes[focusedNodeIndex];
      if (fNode !== selectedNode) {
        ctx.beginPath();
        ctx.arc(fNode.x, fNode.y, nodeRadius(fNode) + 6, 0, Math.PI * 2);
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = 2 / scale;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    /* 7. search highlights */
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2 / scale;
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        var lbl = (nd.label || '').toLowerCase();
        var full = (nd.fullLabel || '').toLowerCase();
        if (lbl.indexOf(q) !== -1 || full.indexOf(q) !== -1) {
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nodeRadius(nd) + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  /* ── score lookup helper (uses precomputed map) ──────────────────── */
  function matchScore(node) {
    return bestScoreForNode(node);
  }

  /* ── hit testing ────────────────────────────────────────────────────── */
  function hitTest(mx, my) {
    var gx = (mx - panX) / scale;
    var gy = (my - panY) / scale;
    var closest = null, closestDist = Infinity;
    for (var i = 0; i < visibleNodes.length; i++) {
      var nd = visibleNodes[i];
      var dx = nd.x - gx, dy = nd.y - gy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var r = Math.max(nodeRadius(nd) + 4, 14);
      if (dist < r && dist < closestDist) {
        closest = nd;
        closestDist = dist;
      }
    }
    return closest;
  }

  /* ── detail panel ───────────────────────────────────────────────────── */
  function renderGraphDetails(node) {
    selectedNode = node;
    var metaEl = document.getElementById('graph-detail-meta');
    var bodyEl = document.getElementById('graph-detail-body');
    if (!metaEl || !bodyEl) return;

    if (!node) {
      metaEl.innerHTML = 'Click a bubble to inspect it.';
      bodyEl.innerHTML = '<p class="text-muted" style="margin:0">Use the graph filters, then click a project or finding bubble to pin its details here.</p>';
      render();
      return;
    }

    var mult = qualityMultiplier(node);
    var barWidth = Math.round(clamp(mult, 0, 1.5) / 1.5 * 100);
    var barColor = mult >= 1.0 ? '#10b981' : mult >= 0.7 ? '#eab308' : mult >= 0.5 ? '#f59e0b' : '#ef4444';
    var qualityBar = '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">' +
      '<span style="font-size:12px;color:#9ca3af">Quality</span>' +
      '<div style="width:100px;height:4px;background:#374151;border-radius:2px;overflow:hidden">' +
      '<div style="width:' + barWidth + 'px;height:4px;background:' + barColor + ';border-radius:2px"></div></div>' +
      '<span style="font-size:11px;color:#9ca3af">' + Math.round(mult * 100) + '%</span></div>';

    var sc = matchScore(node);
    var healthText = '';
    if (sc && sc.lastUsedAt) {
      var days = Math.round((Date.now() - new Date(sc.lastUsedAt).getTime()) / 86400000);
      if (days <= 7) healthText = '<span style="color:#10b981;font-size:12px">Healthy (used ' + days + 'd ago)</span>';
      else if (days <= 30) healthText = '<span style="color:#9ca3af;font-size:12px">OK (' + days + 'd ago)</span>';
      else if (days <= 90) healthText = '<span style="color:#f59e0b;font-size:12px">Stale (' + days + 'd ago)</span>';
      else healthText = '<span style="color:#ef4444;font-size:12px">Decaying (' + days + 'd ago)</span>';
    }

    var badge = function(text, bg) {
      return '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:' + bg + ';color:#fff">' + esc(text) + '</span>';
    };

    var html = '';

    if (node.group === 'project') {
      metaEl.innerHTML = esc(node.label) + ' ' + badge('project', COLORS.project);
      var fileCount = 0, findingCount = 0, taskCount = 0, entityCount = 0;
      for (var i = 0; i < allLinks.length; i++) {
        var lk = allLinks[i];
        var other = null;
        if (lk.source === node.id) other = findNodeById(lk.target);
        else if (lk.target === node.id) other = findNodeById(lk.source);
        if (!other) continue;
        if (isFindingGroup(other.group)) findingCount++;
        else if (TASK_GROUPS[other.group]) taskCount++;
        else if (other.group === 'entity') entityCount++;
        fileCount++;
      }
      html += '<div>' + esc(node.fullLabel || node.label) + '</div>';
      html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:13px;color:#9ca3af">';
      html += '<span>Connections: ' + fileCount + '</span>';
      html += '<span>Findings: ' + findingCount + '</span>';
      html += '<span>Tasks: ' + taskCount + '</span>';
      html += '<span>Entities: ' + entityCount + '</span>';
      html += '</div>';
      html += qualityBar;

    } else if (isFindingGroup(node.group)) {
      var findingTopicLabel = node.topicLabel || (typeof node.group === 'string' && node.group.indexOf('topic:') === 0 ? node.group.slice(6) : node.group);
      metaEl.innerHTML = 'Finding ' + badge(findingTopicLabel, topicGroupColor(node.group)) +
        (node.project ? ' ' + badge(node.project, COLORS.project) : '');
      html += '<div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6">' + esc(node.fullLabel || node.label) + '</div>';
      html += qualityBar;
      if (healthText) html += '<div style="margin-top:4px">' + healthText + '</div>';

    } else if (TASK_GROUPS[node.group]) {
      var secColor = node.group === 'task-active' ? '#10b981' : '#eab308';
      var secLabel = node.section || (node.group === 'task-active' ? 'Active' : 'Queue');
      metaEl.innerHTML = 'Task ' + badge(secLabel, secColor) +
        (node.priority ? ' ' + badge(node.priority, '#6b7280') : '') +
        (node.project ? ' ' + badge(node.project, COLORS.project) : '');
      html += '<div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6">' + esc(node.fullLabel || node.label) + '</div>';
      html += qualityBar;

    } else if (node.group === 'entity') {
      metaEl.innerHTML = esc(node.label) + ' ' + badge(node.entityType || 'entity', COLORS.entity);
      html += '<div style="font-size:13px;color:#9ca3af">References: ' + (node.refCount || 0) + '</div>';
      /* connected projects */
      var projs = {};
      for (var i = 0; i < allLinks.length; i++) {
        var lk = allLinks[i];
        var other = null;
        if (lk.source === node.id) other = findNodeById(lk.target);
        else if (lk.target === node.id) other = findNodeById(lk.source);
        if (other && other.group === 'project') projs[other.label] = 1;
      }
      var projNames = Object.keys(projs);
      if (projNames.length > 0) {
        html += '<div style="margin-top:8px;font-size:12px;color:#9ca3af">Projects: ' + projNames.map(function(p) { return esc(p); }).join(', ') + '</div>';
      }
      if (node.refDocs && node.refDocs.length > 0) {
        html += '<div style="margin-top:6px;font-size:12px;color:#9ca3af">Docs: ' + node.refDocs.map(function(d) { return esc(d); }).join(', ') + '</div>';
      }
      html += qualityBar;

    } else if (node.group === 'reference') {
      metaEl.innerHTML = esc(node.label) + ' ' + badge('reference', COLORS.reference) +
        (node.project ? ' ' + badge(node.project, COLORS.project) : '');
      html += '<div style="font-size:13px">' + esc(node.fullLabel || node.label) + '</div>';
      html += qualityBar;

    } else {
      metaEl.innerHTML = esc(node.label) + ' ' + badge(node.group, COLORS[node.group] || COLORS.other);
      html += '<div style="font-size:13px">' + esc(node.fullLabel || node.label) + '</div>';
      html += qualityBar;
    }

    bodyEl.innerHTML = html;
    announceNode(node);
    render();
  }

  function findNodeById(id) {
    for (var i = 0; i < allNodes.length; i++) {
      if (allNodes[i].id === id) return allNodes[i];
    }
    return null;
  }

  /* ── interaction ────────────────────────────────────────────────────── */
  function setupInteraction() {
    canvas.addEventListener('mousedown', function(e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var hit = hitTest(mx, my);
      if (hit) {
        dragging = hit;
        dragOffX = (mx - panX) / scale - hit.x;
        dragOffY = (my - panY) / scale - hit.y;
        renderGraphDetails(hit);
      } else {
        panning = true;
        panStartX = mx - panX;
        panStartY = my - panY;
      }
    });

    canvas.addEventListener('mousemove', function(e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      if (dragging) {
        dragging.x = (mx - panX) / scale - dragOffX;
        dragging.y = (my - panY) / scale - dragOffY;
        dragging.vx = 0;
        dragging.vy = 0;
        render();
      } else if (panning) {
        panX = mx - panStartX;
        panY = my - panStartY;
        render();
      } else {
        /* tooltip with 200ms hover delay, showing full label */
        var hit = hitTest(mx, my);
        if (hit && tooltip) {
          if (hit !== _tooltipNode) {
            _tooltipNode = hit;
            clearTimeout(_tooltipTimer);
            tooltip.style.display = 'none';
            _tooltipTimer = setTimeout(function() {
              if (_tooltipNode === hit) {
                tooltip.style.display = 'block';
                tooltip.innerHTML = esc(hit.fullLabel || hit.label || hit.id);
              }
            }, 200);
          }
          tooltip.style.left = (mx + 12) + 'px';
          tooltip.style.top = (my - 8) + 'px';
        } else if (tooltip) {
          _tooltipNode = null;
          clearTimeout(_tooltipTimer);
          tooltip.style.display = 'none';
        }
      }
    });

    canvas.addEventListener('mouseup', function() {
      dragging = null;
      panning = false;
    });

    canvas.addEventListener('mouseleave', function() {
      dragging = null;
      panning = false;
      if (tooltip) tooltip.style.display = 'none';
    });

    canvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left;
      var my = e.clientY - rect.top;
      var factor = e.deltaY < 0 ? 1.1 : 0.9;
      var newScale = scale * factor;
      newScale = clamp(newScale, 0.05, 10);
      /* zoom toward cursor */
      panX = mx - (mx - panX) * (newScale / scale);
      panY = my - (my - panY) * (newScale / scale);
      scale = newScale;
      render();
    }, { passive: false });

    /* ── keyboard navigation (a11y) ──────────────────────────────────── */
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Knowledge graph. Use Tab to cycle nodes, Enter to select, Arrow keys to pan, +/- to zoom, Home to reset, Escape to deselect.');

    canvas.addEventListener('keydown', function(e) {
      var PAN_STEP = 40;
      var handled = true;

      switch (e.key) {
        case 'Tab':
          e.preventDefault();
          if (visibleNodes.length === 0) break;
          if (e.shiftKey) {
            focusedNodeIndex = focusedNodeIndex <= 0 ? visibleNodes.length - 1 : focusedNodeIndex - 1;
          } else {
            focusedNodeIndex = (focusedNodeIndex + 1) % visibleNodes.length;
          }
          var fn = visibleNodes[focusedNodeIndex];
          panToNode(fn);
          announceNode(fn);
          render();
          break;
        case 'Enter':
          if (focusedNodeIndex >= 0 && focusedNodeIndex < visibleNodes.length) {
            var sn = visibleNodes[focusedNodeIndex];
            renderGraphDetails(sn);
            announceNode(sn);
            /* move focus to detail panel */
            var dp = document.getElementById('graph-detail-panel');
            if (dp) dp.focus();
          }
          break;
        case 'Escape':
          if (selectedNode) {
            var prevFocus = focusedNodeIndex;
            renderGraphDetails(null);
            focusedNodeIndex = prevFocus;
            announceNode(null);
            canvas.focus();
          } else {
            focusedNodeIndex = -1;
            render();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          panX += PAN_STEP;
          render();
          break;
        case 'ArrowRight':
          e.preventDefault();
          panX -= PAN_STEP;
          render();
          break;
        case 'ArrowUp':
          e.preventDefault();
          panY += PAN_STEP;
          render();
          break;
        case 'ArrowDown':
          e.preventDefault();
          panY -= PAN_STEP;
          render();
          break;
        case '+':
        case '=':
          scale = clamp(scale * 1.15, 0.05, 10);
          render();
          break;
        case '-':
        case '_':
          scale = clamp(scale * 0.85, 0.05, 10);
          render();
          break;
        case 'Home':
          scale = 1;
          panX = 0;
          panY = 0;
          focusedNodeIndex = -1;
          render();
          announce('View reset');
          break;
        default:
          handled = false;
      }
      if (handled) e.stopPropagation();
    });
  }

  /* ── filter bar construction ────────────────────────────────────────── */
  function buildFilterBar() {
    var filterEl = document.getElementById('graph-filter');
    var projectFilterEl = document.getElementById('graph-project-filter');
    var limitRow = document.getElementById('graph-limit-row');
    if (!filterEl) return;

    /* Build dynamic topic list from allTopics metadata if available, else from node data */
    var topicsInData = {};
    for (var i = 0; i < allNodes.length; i++) {
      var nd = allNodes[i];
      if (typeof nd.group === 'string' && nd.group.indexOf('topic:') === 0) {
        var slug = nd.group.slice(6);
        if (!topicsInData[slug]) {
          topicsInData[slug] = nd.topicLabel || slug.charAt(0).toUpperCase() + slug.slice(1);
        }
      }
    }
    /* Override labels with metadata from data.topics if present */
    if (allTopics && allTopics.length > 0) {
      for (var i = 0; i < allTopics.length; i++) {
        var t = allTopics[i];
        if (topicsInData[t.slug] !== undefined) topicsInData[t.slug] = t.label;
      }
    }
    var topicSlugsInData = Object.keys(topicsInData).sort(function(a, b) { return topicsInData[a].localeCompare(topicsInData[b]); });

    /* type filter (multi-select toggles with color dots) */
    var types = [
      { key: 'project', label: 'Projects', color: COLORS.project },
      { key: 'finding', label: 'Findings', color: COLORS.other },
      { key: 'task', label: 'Tasks', color: COLORS['task-active'] },
      { key: 'entity', label: 'Entities', color: COLORS.entity },
      { key: 'reference', label: 'Refs', color: COLORS.reference }
    ];
    var typeHtml = '<span style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-right:4px">Type</span>';
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var isActive = !!filterTypes[t.key];
      var pillBg = isActive ? t.color + '22' : 'transparent';
      var pillBorder = isActive ? t.color + '55' : 'var(--border)';
      var style = 'display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;border:1px solid ' + pillBorder + ';font-size:12px;font-weight:500;cursor:pointer;user-select:none;background:' + pillBg + ';transition:all .15s;' + (isActive ? 'opacity:1' : 'opacity:0.45');
      typeHtml += '<span style="' + style + '" data-filter-type="' + t.key + '">';
      typeHtml += '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + t.color + '"></span>';
      typeHtml += esc(t.label) + '</span>';
    }

    /* per-topic subtoggle pills (only shown when Findings master toggle is on) */
    if (filterTypes.finding && topicSlugsInData.length > 0) {
      typeHtml += '<span style="display:inline-block;width:1px;height:16px;background:var(--border);margin:0 4px;vertical-align:middle"></span>';
      for (var i = 0; i < topicSlugsInData.length; i++) {
        var slug = topicSlugsInData[i];
        var topicKey = 'topic:' + slug;
        var color = topicGroupColor(topicKey);
        /* Default to active if no explicit setting yet */
        var isTopicActive = (topicKey in filterTypes) ? !!filterTypes[topicKey] : true;
        var tPillBg = isTopicActive ? color + '22' : 'transparent';
        var tPillBorder = isTopicActive ? color + '55' : 'var(--border)';
        var tStyle = 'display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;border:1px solid ' + tPillBorder + ';font-size:11px;font-weight:500;cursor:pointer;user-select:none;background:' + tPillBg + ';transition:all .15s;' + (isTopicActive ? 'opacity:1' : 'opacity:0.4');
        typeHtml += '<span style="' + tStyle + '" data-filter-type="' + topicKey + '">';
        typeHtml += '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + '"></span>';
        typeHtml += esc(topicsInData[slug]) + '</span>';
      }
    }

    /* separator + health filter */
    typeHtml += '<span style="display:inline-block;width:1px;height:20px;background:var(--border);margin:0 6px"></span>';
    typeHtml += '<select data-health-filter style="padding:5px 10px;border-radius:6px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px;cursor:pointer">';
    typeHtml += '<option value="all"' + (filterHealth === 'all' ? ' selected' : '') + '>All health</option>';
    typeHtml += '<option value="healthy"' + (filterHealth === 'healthy' ? ' selected' : '') + '>Healthy (&ge;0.8)</option>';
    typeHtml += '<option value="stale"' + (filterHealth === 'stale' ? ' selected' : '') + '>Stale (0.5-0.8)</option>';
    typeHtml += '<option value="decaying"' + (filterHealth === 'decaying' ? ' selected' : '') + '>Decaying (&lt;0.5)</option>';
    typeHtml += '</select>';

    /* separator + search input */
    typeHtml += '<span style="display:inline-block;width:1px;height:20px;background:var(--border);margin:0 6px"></span>';
    typeHtml += '<input type="text" data-search-filter placeholder="Search nodes..." style="padding:5px 12px;border-radius:6px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px;width:160px" />';

    filterEl.innerHTML = typeHtml;

    /* wire up type/topic filter clicks via addEventListener */
    var typeEls = filterEl.querySelectorAll('[data-filter-type]');
    for (var ti = 0; ti < typeEls.length; ti++) {
      (function(el) {
        el.addEventListener('click', function() {
          window.graphFilterBy(el.getAttribute('data-filter-type'));
        });
      })(typeEls[ti]);
    }

    /* wire up health filter */
    var healthSelect = filterEl.querySelector('[data-health-filter]');
    if (healthSelect) {
      healthSelect.addEventListener('change', function() { window.graphHealthFilter(healthSelect.value); });
    }

    /* wire up search input */
    var searchInput = filterEl.querySelector('[data-search-filter]');
    if (searchInput) {
      searchInput.addEventListener('input', function() { window.graphSearchFilter(searchInput.value); });
    }

    /* project filter */
    if (projectFilterEl) {
      var projects = {};
      for (var i = 0; i < allNodes.length; i++) {
        if (allNodes[i].project) projects[allNodes[i].project] = 1;
      }
      var projHtml = '<span style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-right:4px">Project</span>';
      projHtml += '<button class="' + (filterProject === 'all' ? 'btn btn-sm active' : 'btn btn-sm') + '" style="padding:4px 12px" data-project-filter="all">All</button>';
      var projNames = Object.keys(projects).sort();
      for (var i = 0; i < projNames.length; i++) {
        var p = projNames[i];
        var cls = p === filterProject ? 'btn btn-sm active' : 'btn btn-sm';
        projHtml += '<button class="' + cls + '" style="padding:4px 12px" data-project-filter="' + esc(p) + '">' + esc(p) + '</button>';
      }
      projectFilterEl.innerHTML = projHtml;

      /* wire up project filter clicks */
      var projBtns = projectFilterEl.querySelectorAll('[data-project-filter]');
      for (var pi = 0; pi < projBtns.length; pi++) {
        (function(btn) {
          btn.addEventListener('click', function() {
            window.graphProjectFilter(btn.getAttribute('data-project-filter'));
          });
        })(projBtns[pi]);
      }
    }

    /* node limit */
    if (limitRow) {
      limitRow.innerHTML = '<span style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px">Limit</span>' +
        '<input type="number" data-limit-input min="10" max="10000" value="' + nodeLimit + '" style="width:72px;padding:5px 8px;border-radius:6px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px" />' +
        '<span style="font-size:11px;color:var(--muted)">' + visibleNodes.length + ' of ' + allNodes.length + ' nodes</span>';

      /* wire up limit input */
      var limitInput = limitRow.querySelector('[data-limit-input]');
      if (limitInput) {
        limitInput.addEventListener('change', function() { window.applyGraphLimit(parseInt(limitInput.value, 10)); });
      }
    }
  }

  /* ── sizing ─────────────────────────────────────────────────────────── */
  function resize() {
    var container = canvas.parentElement;
    if (!container) return;
    var oldW = W, oldH = H;
    W = container.clientWidth;
    H = container.clientHeight || 500;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    /* preserve viewport center on resize */
    if (oldW > 0 && oldH > 0) {
      var oldCX = (oldW / 2 - panX) / scale;
      var oldCY = (oldH / 2 - panY) / scale;
      panX = W / 2 - oldCX * scale;
      panY = H / 2 - oldCY * scale;
    }
    render();
  }

  /* ── animation loop (capped at 60fps) ───────────────────────────────── */
  var lastTickTime = 0;
  var TICK_INTERVAL = 1000 / 60; /* ~16.67ms */
  function tick(timestamp) {
    if (timestamp - lastTickTime < TICK_INTERVAL) {
      if (alpha > 0 || dragging) {
        animFrame = requestAnimationFrame(tick);
      } else {
        animFrame = null;
      }
      return;
    }
    lastTickTime = timestamp;
    simulate();
    render();
    if (alpha > 0 || dragging) {
      animFrame = requestAnimationFrame(tick);
    } else {
      animFrame = null;
    }
  }

  function startSimulation() {
    alpha = 1.0;
    if (!animFrame) {
      animFrame = requestAnimationFrame(tick);
    }
  }

  /* ── initial layout ─────────────────────────────────────────────────── */
  function initPositions() {
    var n = visibleNodes.length;
    var maxRadius = Math.max(120, Math.sqrt(n) * 40);
    for (var i = 0; i < n; i++) {
      var nd = visibleNodes[i];
      var angle = (2 * Math.PI * i) / n;
      var jitter = 0.85 + Math.random() * 0.3;
      // Relevance-based starting distance: high relevance starts near center
      var rel = nodeRelevance(nd);
      var r = maxRadius * (0.2 + (1 - rel) * 0.8) * jitter;
      nd.x = W / 2 + r * Math.cos(angle);
      nd.y = H / 2 + r * Math.sin(angle);
      nd.vx = 0;
      nd.vy = 0;
    }
  }

  /* ── public API ─────────────────────────────────────────────────────── */
  window.graphZoom = function(factor) {
    scale *= factor;
    scale = clamp(scale, 0.05, 10);
    render();
  };

  window.graphReset = function() {
    scale = 1;
    panX = 0;
    panY = 0;
    render();
  };

  window.graphFilterBy = function(type) {
    filterTypes[type] = !filterTypes[type];
    applyFilters();
    buildFilterBar();
    initPositions();
    startSimulation();
    announceFilterChange();
  };

  window.graphProjectFilter = function(proj) {
    filterProject = proj;
    applyFilters();
    buildFilterBar();
    initPositions();
    startSimulation();
    announceFilterChange();
  };

  window.graphHealthFilter = function(val) {
    filterHealth = val;
    applyFilters();
    initPositions();
    startSimulation();
    announceFilterChange();
  };

  window.graphSearchFilter = function(q) {
    searchQuery = q;
    applyFilters();
    render();
  };

  window.graphClearSelection = function() {
    renderGraphDetails(null);
  };

  window.applyGraphLimit = function(n) {
    if (typeof n !== 'number' || isNaN(n)) return;
    nodeLimit = clamp(n, 10, 10000);
    applyFilters();
    initPositions();
    startSimulation();
  };

  /* ── mount (called by host loadGraph with pre-fetched data) ─────────── */
  window.cortexGraph = {
    mount: function(data) {
      canvas = document.getElementById('graph-canvas');
      tooltip = document.getElementById('graph-tooltip');
      if (!canvas) {
        console.error('[cortexGraph] #graph-canvas not found');
        return;
      }
      ctx = canvas.getContext('2d');
      if (!ctx) return;

      resize();
      window.addEventListener('resize', resize);

      allNodes = data.nodes || [];
      allLinks = data.links || [];
      allScores = data.scores || {};
      /* topics: populated by new graph API; absent in VS Code extension (backward compat) */
      allTopics = data.topics || [];
      buildScoreLookup();

      /* create ARIA live region for screen reader announcements */
      liveRegion = document.createElement('div');
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', 'polite');
      liveRegion.setAttribute('aria-atomic', 'true');
      liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
      document.body.appendChild(liveRegion);

      /* make detail panel focusable for keyboard flow */
      var detailPanel = document.getElementById('graph-detail-panel');
      if (detailPanel && !detailPanel.hasAttribute('tabindex')) {
        detailPanel.setAttribute('tabindex', '-1');
        detailPanel.setAttribute('role', 'region');
        detailPanel.setAttribute('aria-label', 'Node details');
      }

      applyFilters();
      buildFilterBar();
      initPositions();
      setupInteraction();
      startSimulation();
      announceGraphSummary();
    }
  };
})();
`;
}
