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
 * Host page must provide: esc(str), _authToken
 */

export function renderGraphScript(): string {
  return `
/* ── Knowledge Graph (Canvas2D + Barnes-Hut) ─────────────────────────── */
(function() {
  'use strict';

  /* ── colour & size maps ─────────────────────────────────────────────── */
  var COLORS = {
    project: '#7c3aed',
    decision: '#3b82f6', pitfall: '#ef4444', pattern: '#10b981',
    tradeoff: '#f59e0b', architecture: '#8b5cf6', bug: '#dc2626',
    'task-active': '#10b981', 'task-queue': '#eab308',
    entity: '#06b6d4', reference: '#14b8a6',
    other: '#f4a261'
  };
  var RADII = {
    project: 18, decision: 8, pitfall: 8, pattern: 8,
    tradeoff: 8, architecture: 8, bug: 8,
    'task-active': 7, 'task-queue': 7,
    entity: 10, reference: 6,
    other: 8
  };

  /* ── state ──────────────────────────────────────────────────────────── */
  var allNodes = [], allLinks = [], allScores = {};
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

  /* ── helpers ────────────────────────────────────────────────────────── */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function nodeRadius(n) {
    if (n.group === 'entity') return Math.min(6 + (n.refCount || 0), 16);
    return RADII[n.group] || RADII.other;
  }

  function nodeColor(n) { return COLORS[n.group] || COLORS.other; }

  /* ── quality / decay ────────────────────────────────────────────────── */
  function qualityMultiplier(node) {
    if (!allScores || !node.project) return 1.0;
    var best = null;
    var prefix = node.project + '/';
    var keys = Object.keys(allScores);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0) {
        var s = allScores[keys[i]];
        if (!best || (s.impressions || 0) > (best.impressions || 0)) best = s;
      }
    }
    if (!best) return 1.0;

    var now = Date.now();
    var lastUsed = best.lastUsedAt ? new Date(best.lastUsedAt).getTime() : 0;
    var daysSince = lastUsed ? (now - lastUsed) / 86400000 : 999;

    var recencyBoost = 0;
    if (daysSince <= 7) recencyBoost = 0.15;
    else if (daysSince <= 30) recencyBoost = 0;
    else recencyBoost = Math.max(-0.3, -0.1 * Math.floor((daysSince - 30) / 30));

    var impressions = best.impressions || 0;
    var frequencyBoost = Math.min(0.2, Math.log(impressions + 1) / Math.LN2 * 0.05);

    var helpful = best.helpful || 0;
    var reprompt = best.repromptPenalty || 0;
    var regression = best.regressionPenalty || 0;
    var feedbackScore = helpful * 0.15 - (reprompt + regression * 2) * 0.2;

    return clamp(1 + feedbackScore + recencyBoost + frequencyBoost, 0.2, 1.5);
  }

  function healthRingColor(node) {
    if (!allScores || !node.project) return null;
    var prefix = node.project + '/';
    var best = null;
    var keys = Object.keys(allScores);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0) {
        var s = allScores[keys[i]];
        if (!best || (s.impressions || 0) > (best.impressions || 0)) best = s;
      }
    }
    if (!best || !best.lastUsedAt) return null;
    var days = (Date.now() - new Date(best.lastUsedAt).getTime()) / 86400000;
    if (days <= 7) return '#10b981';
    if (days <= 30) return null;
    if (days <= 90) return '#f59e0b';
    return '#ef4444';
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
    if (!this.body && !this.divided) {
      this.body = node;
      this.totalMass = 1;
      this.cx = node.x;
      this.cy = node.y;
      return true;
    }
    if (!this.divided) {
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
  var THETA = 0.7, REPULSION = 3000, SPRING_K = 0.03, REST_LEN = 55;
  var GRAVITY = 0.012, ALPHA_DECAY = 0.06, MIN_ALPHA = 0.005, DAMPING = 0.4;

  function simulate() {
    if (alpha < MIN_ALPHA) return;

    var nodes = visibleNodes;
    var links = visibleLinks;
    var n = nodes.length;
    if (n === 0) return;

    /* build quadtree */
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

    /* center gravity (stronger for project hubs to anchor clusters) */
    var cx = W / 2 / scale - panX / scale;
    var cy = H / 2 / scale - panY / scale;
    for (var i = 0; i < n; i++) {
      var nd = nodes[i];
      if (nd === dragging) continue;
      var grav = nd.group === 'project' ? GRAVITY * 2.5 : GRAVITY;
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
  var FINDING_GROUPS = { decision: 1, pitfall: 1, pattern: 1, tradeoff: 1, architecture: 1, bug: 1 };
  var TASK_GROUPS = { 'task-active': 1, 'task-queue': 1 };

  function typeMatches(group) {
    if (group === 'project') return !!filterTypes.project;
    if (FINDING_GROUPS[group]) return !!filterTypes.finding;
    if (TASK_GROUPS[group]) return !!filterTypes.task;
    if (group === 'entity') return !!filterTypes.entity;
    if (group === 'reference') return !!filterTypes.reference;
    return true;
  }

  function applyFilters() {
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
      if (searchQuery) {
        var q = searchQuery.toLowerCase();
        var label = (n.label || '').toLowerCase();
        var full = (n.fullLabel || '').toLowerCase();
        if (label.indexOf(q) === -1 && full.indexOf(q) === -1) continue;
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
    alpha = 1.0;
  }

  /* ── legend ─────────────────────────────────────────────────────────── */
  function updateLegend() {
    var legendEl = document.querySelector('.graph-legend');
    if (!legendEl) return;
    var seen = {};
    for (var i = 0; i < visibleNodes.length; i++) seen[visibleNodes[i].group] = 1;
    var html = '';
    var order = ['project', 'decision', 'pitfall', 'pattern', 'tradeoff', 'architecture', 'bug', 'task-active', 'task-queue', 'entity', 'reference'];
    for (var i = 0; i < order.length; i++) {
      var g = order[i];
      if (!seen[g]) continue;
      var label = g.charAt(0).toUpperCase() + g.slice(1);
      label = label.replace('-', ' ');
      html += '<span class="graph-legend-item"><span class="graph-legend-dot" style="background:' + (COLORS[g] || COLORS.other) + '"></span> ' + esc(label) + '</span>';
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
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    pulseT += 0.016;

    var nodes = visibleNodes;
    var links = visibleLinks;

    /* 1. edges */
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(150,150,150,0.18)';
    ctx.lineWidth = 0.8 / scale;
    for (var i = 0; i < links.length; i++) {
      var lk = links[i];
      if (!lk._source || !lk._target) continue;
      ctx.moveTo(lk._source.x, lk._source.y);
      ctx.lineTo(lk._target.x, lk._target.y);
    }
    ctx.stroke();

    /* 2. health rings (batch by colour) */
    var ringBuckets = { '#10b981': [], '#f59e0b': [], '#ef4444': [] };
    for (var i = 0; i < nodes.length; i++) {
      var rc = healthRingColor(nodes[i]);
      if (rc && ringBuckets[rc]) ringBuckets[rc].push(nodes[i]);
    }
    var ringColors = Object.keys(ringBuckets);
    for (var ci = 0; ci < ringColors.length; ci++) {
      var col = ringColors[ci];
      var bucket = ringBuckets[col];
      if (bucket.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2 / scale;
      for (var i = 0; i < bucket.length; i++) {
        var nd = bucket[i];
        var rr = nodeRadius(nd) + 3;
        ctx.moveTo(nd.x + rr, nd.y);
        ctx.arc(nd.x, nd.y, rr, 0, Math.PI * 2);
      }
      ctx.stroke();
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
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nodeRadius(nd), 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1.0;

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
    if (scale >= 0.25) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      var labelFg = isDark ? '#e0e0e0' : '#111827';
      var labelBg = isDark ? 'rgba(11,15,26,0.8)' : 'rgba(248,249,251,0.85)';
      for (var i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        var r = nodeRadius(nd);
        var show = false;
        var fontSize = Math.max(9, Math.round(10 / scale));
        if (nd.group === 'project') {
          show = true;
          ctx.font = 'bold ' + Math.max(9, Math.round(11 / scale)) + 'px sans-serif';
        } else if (scale >= 0.9) {
          show = true;
          ctx.font = '500 ' + fontSize + 'px sans-serif';
        } else if (scale >= 0.6 && nd.group === 'entity' && (nd.refCount || 0) > 2) {
          show = true;
          ctx.font = '500 ' + fontSize + 'px sans-serif';
        }
        if (show) {
          var lbl = nd.label || '';
          if (lbl.length > 24) lbl = lbl.slice(0, 22) + '..';
          var lx = nd.x, ly = nd.y + r + 3;
          var tw = ctx.measureText(lbl).width;
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = labelBg;
          ctx.fillRect(lx - tw / 2 - 2, ly - 1, tw + 4, fontSize + 2);
          ctx.globalAlpha = 0.9;
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

  /* ── score lookup helper ────────────────────────────────────────────── */
  function matchScore(node) {
    if (!allScores || !node.project) return null;
    var prefix = node.project + '/';
    var best = null;
    var keys = Object.keys(allScores);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0) {
        var s = allScores[keys[i]];
        if (!best || (s.impressions || 0) > (best.impressions || 0)) best = s;
      }
    }
    return best;
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
      var r = nodeRadius(nd) + 4;
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
        if (FINDING_GROUPS[other.group]) findingCount++;
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

    } else if (FINDING_GROUPS[node.group]) {
      metaEl.innerHTML = 'Finding ' + badge(node.group, COLORS[node.group] || COLORS.other) +
        (node.project ? ' ' + badge(node.project, COLORS.project) : '');
      html += '<div style="white-space:pre-wrap;font-size:13px;line-height:1.6">' + esc(node.fullLabel || node.label) + '</div>';
      html += qualityBar;
      if (healthText) html += '<div style="margin-top:4px">' + healthText + '</div>';

    } else if (TASK_GROUPS[node.group]) {
      var secColor = node.group === 'task-active' ? '#10b981' : '#eab308';
      var secLabel = node.section || (node.group === 'task-active' ? 'Active' : 'Queue');
      metaEl.innerHTML = 'Task ' + badge(secLabel, secColor) +
        (node.priority ? ' ' + badge(node.priority, '#6b7280') : '') +
        (node.project ? ' ' + badge(node.project, COLORS.project) : '');
      html += '<div style="white-space:pre-wrap;font-size:13px;line-height:1.6">' + esc(node.fullLabel || node.label) + '</div>';
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
        /* tooltip */
        var hit = hitTest(mx, my);
        if (hit && tooltip) {
          tooltip.style.display = 'block';
          tooltip.style.left = (mx + 12) + 'px';
          tooltip.style.top = (my - 8) + 'px';
          tooltip.innerHTML = esc(hit.label || hit.id);
        } else if (tooltip) {
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
  }

  /* ── filter bar construction ────────────────────────────────────────── */
  function buildFilterBar() {
    var filterEl = document.getElementById('graph-filter');
    var projectFilterEl = document.getElementById('graph-project-filter');
    var limitRow = document.getElementById('graph-limit-row');
    if (!filterEl) return;

    /* type filter (multi-select toggles with color dots) */
    var types = [
      { key: 'project', label: 'Projects', color: '#7c3aed' },
      { key: 'finding', label: 'Findings', color: '#f4a261' },
      { key: 'task', label: 'Tasks', color: '#10b981' },
      { key: 'entity', label: 'Entities', color: '#06b6d4' },
      { key: 'reference', label: 'Refs', color: '#14b8a6' }
    ];
    var typeHtml = '';
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      var isActive = !!filterTypes[t.key];
      var style = 'display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:999px;border:1px solid var(--border);font-size:11px;cursor:pointer;user-select:none;' + (isActive ? 'opacity:1' : 'opacity:0.4');
      typeHtml += '<span style="' + style + '" onclick="graphFilterBy(\\'' + t.key + '\\')">';
      typeHtml += '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + t.color + '"></span>';
      typeHtml += esc(t.label) + '</span> ';
    }

    /* health filter */
    typeHtml += ' <select onchange="graphHealthFilter(this.value)" style="margin-left:8px;padding:3px 8px;border-radius:4px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px">';
    typeHtml += '<option value="all"' + (filterHealth === 'all' ? ' selected' : '') + '>All health</option>';
    typeHtml += '<option value="healthy"' + (filterHealth === 'healthy' ? ' selected' : '') + '>Healthy (&ge;0.8)</option>';
    typeHtml += '<option value="stale"' + (filterHealth === 'stale' ? ' selected' : '') + '>Stale (0.5-0.8)</option>';
    typeHtml += '<option value="decaying"' + (filterHealth === 'decaying' ? ' selected' : '') + '>Decaying (&lt;0.5)</option>';
    typeHtml += '</select>';

    /* search input */
    typeHtml += ' <input type="text" placeholder="Search nodes..." style="margin-left:8px;padding:3px 8px;border-radius:4px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px;width:140px" oninput="graphSearchFilter(this.value)" />';

    filterEl.innerHTML = typeHtml;

    /* project filter */
    if (projectFilterEl) {
      var projects = {};
      for (var i = 0; i < allNodes.length; i++) {
        if (allNodes[i].project) projects[allNodes[i].project] = 1;
      }
      var projHtml = '<button class="' + (filterProject === 'all' ? 'btn btn-sm active' : 'btn btn-sm') + '" onclick="graphProjectFilter(\\'all\\')">All</button>';
      var projNames = Object.keys(projects).sort();
      for (var i = 0; i < projNames.length; i++) {
        var p = projNames[i];
        var cls = p === filterProject ? 'btn btn-sm active' : 'btn btn-sm';
        projHtml += '<button class="' + cls + '" onclick="graphProjectFilter(\\'' + esc(p).replace(/'/g, "\\\\'") + '\\')">' + esc(p) + '</button>';
      }
      projectFilterEl.innerHTML = projHtml;
    }

    /* node limit */
    if (limitRow) {
      limitRow.innerHTML = '<label style="font-size:12px;color:var(--muted)">Max nodes</label>' +
        '<input type="number" min="10" max="10000" value="' + nodeLimit + '" style="width:70px;padding:3px 6px;border-radius:4px;background:var(--surface);color:var(--ink);border:1px solid var(--border);font-size:12px" onchange="applyGraphLimit(parseInt(this.value,10))" />';
    }
  }

  /* ── sizing ─────────────────────────────────────────────────────────── */
  function resize() {
    var container = canvas.parentElement;
    if (!container) return;
    W = container.clientWidth;
    H = container.clientHeight || 500;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    render();
  }

  /* ── animation loop ─────────────────────────────────────────────────── */
  function tick() {
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
    var radius = Math.max(80, Math.sqrt(n) * 18);
    for (var i = 0; i < n; i++) {
      var angle = (2 * Math.PI * i) / n;
      visibleNodes[i].x = W / 2 + radius * Math.cos(angle);
      visibleNodes[i].y = H / 2 + radius * Math.sin(angle);
      visibleNodes[i].vx = 0;
      visibleNodes[i].vy = 0;
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
  };

  window.graphProjectFilter = function(proj) {
    filterProject = proj;
    applyFilters();
    buildFilterBar();
    initPositions();
    startSimulation();
  };

  window.graphHealthFilter = function(val) {
    filterHealth = val;
    applyFilters();
    initPositions();
    startSimulation();
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

  /* ── initGraph (called when graph tab is first shown) ───────────────── */
  window.initGraph = function() {
    canvas = document.getElementById('graph-canvas');
    tooltip = document.getElementById('graph-tooltip');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    if (!ctx) return;

    resize();
    window.addEventListener('resize', resize);

    fetch('/api/graph?_auth=' + _authToken)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        allNodes = data.nodes || [];
        allLinks = data.links || [];
        allScores = data.scores || {};

        applyFilters();
        buildFilterBar();
        initPositions();
        setupInteraction();
        startSimulation();
      })
      .catch(function(err) {
        console.error('Graph load failed:', err);
      });
  };
})();
`;
}
