// --- Demo cursor: only blink on the last typed element ---
(function() {
  const typed = document.querySelectorAll('.demo-typed');
  if (typed.length) typed[typed.length - 1].classList.add('active-cursor');
})();

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
    const count = Math.floor((W * H) / 14000);
    nodes = Array.from({ length: Math.min(count, 55) }, mkNode);
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

// --- Rotating terminal command ---
(function() {
  const cmdEl = document.getElementById('terminal-cmd');
  const promptEl = document.getElementById('terminal-prompt');
  const labelEl = document.getElementById('terminal-label');
  const dots = Array.from(document.querySelectorAll('.terminal-progress-dot'));
  if (!cmdEl || !promptEl || !labelEl || dots.length === 0) return;

  const steps = [
    {
      cmd: 'npx @alaarab/cortex init',
      prefix: 'Run once:',
      label: 'creates the memory layer',
    },
    {
      cmd: 'cortex status',
      prefix: 'Then:',
      label: 'check hooks, sync, and project health',
    },
    {
      cmd: 'cortex review-ui',
      prefix: 'Review:',
      label: 'backlog, findings, and queue in the browser',
    },
    {
      cmd: 'context injected · findings saved · synced',
      prefix: 'Daily:',
      label: 'hooks handle the rest automatically',
      output: true,
    },
  ];

  let current = 0;

  function advance() {
    cmdEl.classList.add('fade-out');

    setTimeout(() => {
      current = (current + 1) % steps.length;
      const step = steps[current];
      cmdEl.textContent = step.cmd;
      cmdEl.style.color = step.output ? 'var(--copper-mid)' : '';
      promptEl.style.display = step.output ? 'none' : '';
      cmdEl.classList.remove('fade-out');
      cmdEl.classList.add('fade-in');
      labelEl.innerHTML = `${step.prefix} <span id="step-num">${step.label}</span>`;

      dots.forEach((d, i) => d.classList.toggle('active', i === current));

      setTimeout(() => cmdEl.classList.remove('fade-in'), 300);
    }, 280);
  }

  setInterval(advance, 3200);
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

  const SCENES = [
    {
      project: '',
      activeTab: 'Projects',
      rows: [
        { kind: 'project', selected: true, name: 'ogrid', meta: '97 findings · 12 queue' },
        { kind: 'project', name: 'projectcenter', meta: '14 findings · 3 queue' },
        { kind: 'project', name: 'equipment-tracker', meta: '8 findings · 0 queue' },
      ],
      status: 'Press ↵ or run :open <project>',
      nextCmd: ':open ogrid',
    },
    {
      project: 'ogrid',
      activeTab: 'Backlog',
      rows: [
        { kind: 'backlog', badge: 'A', tone: 'active', text: 'Eliminate Angular dev-server linker gap', meta: 'high' },
        { kind: 'backlog', badge: 'Q', tone: 'queue', text: 'Close Vue autosize callback parity gap', meta: 'low' },
        { kind: 'backlog', badge: 'D', tone: 'done', text: 'Expand Playwright smoke matrix', meta: 'done' },
      ],
      status: 'a add · ↵ mark done · d toggle active/queue',
      nextCmd: ':findings',
    },
    {
      project: 'ogrid',
      activeTab: 'Findings',
      rows: [
        { kind: 'finding', badge: 'pattern', text: 'Turbo family builds avoid false dist races' },
        { kind: 'finding', badge: 'pitfall', text: 'ngc rejects undecorated abstract base classes' },
        { kind: 'finding', badge: 'tooling', text: 'Examples need direct deps, not hoisted assumptions' },
      ],
      status: '/ filter · a add finding · d remove',
      nextCmd: ':health',
    },
    {
      project: 'ogrid',
      activeTab: 'Health',
      rows: [
        { kind: 'health', key: 'Semantic', value: 'ready · 140/142 embedded' },
        { kind: 'health', key: 'Sync', value: 'saved-pushed · unsynced 0' },
        { kind: 'health', key: 'Hooks', value: 'Claude Code · Copilot CLI · Codex' },
        { kind: 'health', key: 'Live', value: 'store updated' },
      ],
      status: 'Palette commands work from any view',
      nextCmd: ':review queue',
    },
    {
      project: 'ogrid',
      activeTab: 'Queue',
      rows: [
        { kind: 'queue', badge: 'M1', text: 'Angular compiler fallback cleanup', meta: 'pending' },
        { kind: 'queue', badge: 'M2', text: 'Docs parity wording drift', meta: 'pending' },
        { kind: 'queue', badge: 'M3', text: 'Semantic setup hardening', meta: 'pending' },
      ],
      status: 'a approve · r reject · :projects to switch',
      nextCmd: ':projects',
    },
  ];

  const TABS = ['Projects', 'Backlog', 'Findings', 'Queue', 'Skills', 'Hooks', 'Health'];
  const CHAR_BASE = 34;
  const CHAR_JITTER = 22;
  const PRE_TYPE = 520;
  const AFTER_TYPE = 1100;
  const END_PAUSE = 1200;

  let stopped = false;
  let pending = [];

  function wait(ms) {
    return new Promise(r => { const t = setTimeout(r, ms); pending.push(t); });
  }

  function mkEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function makeTab(label, active) {
    return mkEl('span', `demo-shell-tab${active ? ' active' : ''}`, label);
  }

  function makeRow(row) {
    const el = mkEl('div', `demo-shell-row demo-shell-row-${row.kind}`);
    if (row.kind === 'project') {
      el.classList.toggle('selected', !!row.selected);
      el.appendChild(mkEl('span', 'demo-shell-caret', row.selected ? '›' : ' '));
      el.appendChild(mkEl('span', 'demo-shell-name', row.name));
      el.appendChild(mkEl('span', 'demo-shell-meta', row.meta));
      return el;
    }
    if (row.kind === 'backlog' || row.kind === 'queue') {
      el.appendChild(mkEl('span', `demo-shell-badge ${row.tone || ''}`.trim(), row.badge));
      el.appendChild(mkEl('span', 'demo-shell-text', row.text));
      el.appendChild(mkEl('span', 'demo-shell-meta', row.meta));
      return el;
    }
    if (row.kind === 'finding') {
      el.appendChild(mkEl('span', 'demo-shell-tag', row.badge));
      el.appendChild(mkEl('span', 'demo-shell-text', row.text));
      return el;
    }
    if (row.kind === 'health') {
      el.appendChild(mkEl('span', 'demo-shell-key', row.key));
      el.appendChild(mkEl('span', 'demo-shell-value', row.value));
      return el;
    }
    return el;
  }

  function renderScene(scene) {
    body.innerHTML = '';

    const screen = mkEl('div', 'demo-shell-screen');
    const header = mkEl('div', 'demo-shell-headerline');
    header.appendChild(mkEl('span', 'demo-shell-brand', '◆ cortex'));
    if (scene.project) {
      header.appendChild(mkEl('span', 'demo-shell-sep', '·'));
      header.appendChild(mkEl('span', 'demo-shell-project', scene.project));
    }

    const tabs = mkEl('div', 'demo-shell-tabs');
    TABS.forEach((tab) => tabs.appendChild(makeTab(tab, tab === scene.activeTab)));

    const panel = mkEl('div', 'demo-shell-panel');
    scene.rows.forEach((row, index) => {
      const rowEl = makeRow(row);
      panel.appendChild(rowEl);
      requestAnimationFrame(() => {
        const t = setTimeout(() => rowEl.classList.add('visible'), 80 * index);
        pending.push(t);
      });
    });

    const status = mkEl('div', 'demo-shell-status', scene.status);
    const input = mkEl('div', 'demo-shell-input');
    input.appendChild(mkEl('span', 'demo-shell-prompt', ':'));
    const cmd = mkEl('span', 'demo-shell-input-text', '');
    input.appendChild(cmd);
    const cursor = mkEl('span', 'demo-dyn-cursor', '▋');
    input.appendChild(cursor);

    screen.appendChild(header);
    screen.appendChild(tabs);
    screen.appendChild(panel);
    screen.appendChild(status);
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

  // Start when section scrolls into view, once
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
