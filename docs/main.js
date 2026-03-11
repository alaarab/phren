// --- NAV scroll state ---
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

// --- Hero canvas: subtle network nodes ---
(function() {
  const canvas = document.getElementById('hero-canvas');
  const ctx = canvas.getContext('2d');
  let W, H, nodes, raf;

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  function mkNode() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      r: 1 + Math.random() * 1.5,
      a: 0.08 + Math.random() * 0.12,
    };
  }

  function init() {
    resize();
    const count = Math.floor((W * H) / 10000);
    nodes = Array.from({ length: Math.min(count, 90) }, mkNode);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Draw edges
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = 160;
        if (dist < maxDist) {
          const alpha = (1 - dist / maxDist) * 0.06;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(58,123,174,${alpha})`;
          ctx.lineWidth = 0.6;
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }

    // Draw nodes
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(58,123,174,${n.a})`;
      ctx.fill();

      n.x += n.vx;
      n.y += n.vy;

      if (n.x < -10) n.x = W + 10;
      if (n.x > W + 10) n.x = -10;
      if (n.y < -10) n.y = H + 10;
      if (n.y > H + 10) n.y = -10;
    }

    raf = requestAnimationFrame(draw);
  }

  init();
  draw();

  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    init();
    draw();
  });
})();


// --- Install tabs ---
(function() {
  const tabBtns = document.querySelectorAll('.install-tab-btn');
  const tabPanels = document.querySelectorAll('.install-tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    });
  });
})();

// --- Copy buttons ---
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const cmd = btn.dataset.cmd;
    try {
      await navigator.clipboard.writeText(cmd);
      btn.textContent = 'copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'copy';
        btn.classList.remove('copied');
      }, 1800);
    } catch {
      btn.textContent = 'copy';
    }
  });
});

// --- Scroll reveal ---
(function() {
  const els = document.querySelectorAll('.reveal');
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  els.forEach(el => obs.observe(el));
})();

// --- Token bar animation (triggered when bento card enters view) ---
(function() {
  const card = document.getElementById('token-card');
  if (!card) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        card.classList.add('in-view');
        obs.unobserve(card);
      }
    });
  }, { threshold: 0.3 });
  obs.observe(card);
})();

// --- Typewriter demo terminal ---
(function() {
  const body = document.getElementById('demo-terminal-body');
  if (!body) return;

  const TAB_DEFS = [
    { id: 'Projects',     icon: '◉' },
    { id: 'Task',      icon: '▤' },
    { id: 'Findings',     icon: '✦' },
    { id: 'Review Queue', icon: '◈' },
    { id: 'Skills',       icon: '◆' },
    { id: 'Hooks',        icon: '⚡' },
    { id: 'Health',       icon: '♡' },
  ];

  const SCENES = [
    {
      project: '',
      activeTab: 'Projects',
      rows: [
        { kind: 'project', selected: true,  name: 'web-project-1', summary: '97 findings · 12 queue · synced' },
        { kind: 'project', selected: false, name: 'web-project-2', summary: '14 findings · 3 queue · synced' },
        { kind: 'project', selected: false, name: 'art-project-1', summary: '8 findings · 0 queue · local' },
        { kind: 'project', selected: false, name: 'global',        summary: 'skills · config · shared memory', isGlobal: true },
      ],
      status: 'Press ↵ to open · ←→ switch tabs · / filter',
      nextCmd: 'open web-project-1',
    },
    {
      project: 'web-project-1',
      activeTab: 'Task',
      rows: [
        { kind: 'section', label: 'Active', tone: 'active' },
        { kind: 'task', id: 'b1', tone: 'active', text: 'Eliminate Angular dev-server linker gap', priority: 'high' },
        { kind: 'section', label: 'Queue',  tone: 'queue' },
        { kind: 'task', id: 'b4', tone: 'queue',  text: 'Add OpenTelemetry tracing layer', priority: 'low' },
        { kind: 'section', label: 'Done',   tone: 'done' },
        { kind: 'task', id: 'b7', tone: 'done',   text: 'Fix React hydration mismatch', priority: 'done' },
      ],
      status: 'a add · ↵ mark done · d toggle active/queue',
      nextCmd: 'findings',
    },
    {
      project: 'web-project-1',
      activeTab: 'Findings',
      rows: [
        { kind: 'finding', badge: 'pattern', text: 'Turbo family builds avoid false dist races' },
        { kind: 'finding', badge: 'pitfall', text: 'ngc rejects undecorated abstract base classes' },
        { kind: 'finding', badge: 'tooling', text: 'Examples need direct deps, not hoisted assumptions' },
      ],
      status: '/ filter · a add · d remove · ↵ expand',
      nextCmd: 'review queue',
    },
    {
      project: 'web-project-1',
      activeTab: 'Review Queue',
      rows: [
        { kind: 'queue', badge: 'M1', text: 'Angular compiler fallback cleanup', meta: 'pending' },
        { kind: 'queue', badge: 'M2', text: 'Docs parity wording drift',         meta: 'pending' },
        { kind: 'queue', badge: 'M3', text: 'Semantic setup hardening',          meta: 'pending' },
      ],
      status: 'a approve · r reject · :projects to switch',
      nextCmd: 'health',
    },
    {
      project: 'web-project-1',
      activeTab: 'Health',
      rows: [
        { kind: 'health-ok' },
        { kind: 'health-kv', key: 'machine', value: 'dev-laptop' },
        { kind: 'health-kv', key: 'profile',  value: 'main · 5 projects' },
        { kind: 'health-sep' },
        { kind: 'health-kv', key: 'Hooks',    value: 'Claude Code · Copilot CLI · Codex' },
        { kind: 'health-kv', key: 'Semantic',  value: 'ready · 140/142 embedded' },
        { kind: 'health-kv', key: 'Sync',      value: 'saved · unsynced 0' },
      ],
      status: 'Palette commands work from any view',
      nextCmd: 'projects',
    },
  ];

  const CHAR_BASE  = 34;
  const CHAR_JITTER = 22;
  const PRE_TYPE   = 520;
  const AFTER_TYPE = 1100;
  const END_PAUSE  = 1200;

  let stopped = false;

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function mkEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls)      el.className   = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function makeSepLine() {
    return mkEl('div', 'demo-shell-sep-line');
  }

  function makeTabBar(activeTab) {
    const bar = mkEl('div', 'demo-shell-tabbar');
    TAB_DEFS.forEach((tab, i) => {
      if (i > 0) bar.appendChild(mkEl('span', 'demo-shell-tabbar-pipe', ' │ '));
      const active = tab.id === activeTab;
      bar.appendChild(mkEl('span', `demo-shell-tabbar-tab${active ? ' active' : ''}`, `${tab.icon} ${tab.id}`));
    });
    return bar;
  }

  function makeBottomBar() {
    const bar = mkEl('div', 'demo-shell-btmbar');
    const hints = ['←→ tabs', '↑↓ move', '↵ activate', 'a add', '/ filter', ': cmd', '? help', 'q quit'];
    hints.forEach((h, i) => {
      if (i > 0) bar.appendChild(mkEl('span', 'demo-shell-btmbar-dot', ' · '));
      bar.appendChild(mkEl('span', 'demo-shell-btmbar-hint', h));
    });
    return bar;
  }

  function makeRow(row) {
    if (row.kind === 'section') {
      const el = mkEl('div', `demo-shell-sec-hdr demo-sec-${row.tone}`);
      el.appendChild(mkEl('span', 'demo-shell-sec-bullet', '● '));
      el.appendChild(mkEl('span', 'demo-shell-sec-label', row.label));
      return el;
    }

    if (row.kind === 'health-sep') {
      return mkEl('div', 'demo-health-rule');
    }

    if (row.kind === 'project') {
      const wrap = mkEl('div', `demo-shell-row demo-shell-row-proj${row.selected ? ' selected' : ''}${row.isGlobal ? ' global-entry' : ''}`);
      const l1 = mkEl('div', 'demo-proj-line1');
      l1.appendChild(mkEl('span', 'demo-proj-cursor', row.selected ? '▶' : ' '));
      l1.appendChild(mkEl('span', 'demo-proj-bullet', row.selected ? ' ● ' : ' ○ '));
      l1.appendChild(mkEl('span', 'demo-shell-name', row.name));
      wrap.appendChild(l1);
      wrap.appendChild(mkEl('div', 'demo-proj-line2', row.summary));
      return wrap;
    }

    const el = mkEl('div', `demo-shell-row demo-shell-row-${row.kind}`);

    if (row.kind === 'task') {
      el.appendChild(mkEl('span', 'demo-bl-id', row.id));
      el.appendChild(mkEl('span', 'demo-bl-check', row.tone === 'done' ? '[x] ' : '[ ] '));
      el.appendChild(mkEl('span', 'demo-shell-text', row.text));
      el.appendChild(mkEl('span', `demo-bl-pri demo-bl-pri-${row.tone}`, '[' + row.priority + ']'));
      return el;
    }

    if (row.kind === 'finding') {
      el.appendChild(mkEl('span', 'demo-shell-tag', row.badge));
      el.appendChild(mkEl('span', 'demo-shell-text', row.text));
      return el;
    }

    if (row.kind === 'queue') {
      el.appendChild(mkEl('span', 'demo-shell-badge', row.badge));
      el.appendChild(mkEl('span', 'demo-shell-text', row.text));
      el.appendChild(mkEl('span', 'demo-shell-meta', row.meta));
      return el;
    }

    if (row.kind === 'health-ok') {
      el.classList.add('demo-health-ok');
      el.appendChild(mkEl('span', 'demo-health-check', '✓  '));
      el.appendChild(mkEl('span', '', 'cortex healthy'));
      return el;
    }

    if (row.kind === 'health-kv') {
      el.classList.add('demo-health-kv');
      el.appendChild(mkEl('span', 'demo-shell-key', row.key));
      el.appendChild(mkEl('span', 'demo-shell-value', row.value));
      return el;
    }

    return el;
  }

  function renderScene(scene) {
    body.innerHTML = '';
    const screen = mkEl('div', 'demo-shell-screen');

    const hdr = mkEl('div', 'demo-shell-headerline');
    hdr.appendChild(mkEl('span', 'demo-shell-brand', '◆ cortex'));
    if (scene.project) {
      hdr.appendChild(mkEl('span', 'demo-shell-sep', ' · '));
      hdr.appendChild(mkEl('span', 'demo-shell-project', scene.project));
    }
    screen.appendChild(hdr);
    screen.appendChild(makeSepLine());
    screen.appendChild(makeTabBar(scene.activeTab));
    screen.appendChild(makeSepLine());

    const panel = mkEl('div', 'demo-shell-panel');
    let animIdx = 0;
    scene.rows.forEach(row => {
      const el = makeRow(row);
      panel.appendChild(el);
      if (row.kind !== 'section' && row.kind !== 'health-sep') {
        const idx = animIdx++;
        requestAnimationFrame(() => {
          setTimeout(() => el.classList.add('visible'), 80 * idx);
        });
      }
    });
    screen.appendChild(panel);
    screen.appendChild(mkEl('div', 'demo-shell-status', scene.status));
    screen.appendChild(makeSepLine());
    screen.appendChild(makeBottomBar());

    const input = mkEl('div', 'demo-shell-input');
    input.appendChild(mkEl('span', 'demo-shell-prompt', ':'));
    const cmd = mkEl('span', 'demo-shell-input-text', '');
    input.appendChild(cmd);
    const cursor = mkEl('span', 'demo-dyn-cursor', '▋');
    input.appendChild(cursor);
    screen.appendChild(input);

    body.appendChild(screen);
    return { cmd, cursor };
  }

  async function typeCmd(cmdEl, text) {
    for (const ch of text) {
      if (stopped) return;
      cmdEl.textContent += ch;
      await wait(CHAR_BASE + Math.random() * CHAR_JITTER);
    }
  }

  async function runScene(scene) {
    const ui = renderScene(scene);
    await wait(PRE_TYPE);
    await typeCmd(ui.cmd, scene.nextCmd);
    ui.cursor.remove();
    await wait(AFTER_TYPE);
  }

  async function loop() {
    while (!stopped) {
      for (const scene of SCENES) {
        if (stopped) return;
        await runScene(scene);
      }
      await wait(END_PAUSE);
    }
  }

  const section = document.getElementById('demo');
  if (!section) { loop(); return; }

  let started = false;
  const obs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !started) {
      started = true;
      loop();
      obs.disconnect();
    }
  }, { threshold: 0.4 });
  obs.observe(section);
})();
