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
  const steps = [
    {
      cmd: 'npx @alaarab/cortex init',
      prefix: 'One time:',
      label: 'set everything up',
    },
    {
      cmd: '\u2713 context injected  \u2713 learnings saved',
      prefix: 'Every session:',
      label: 'hooks handle it. you just code.',
      output: true,
    },
  ];

  const cmdEl = document.getElementById('terminal-cmd');
  const promptEl = document.getElementById('terminal-prompt');
  const labelEl = document.getElementById('terminal-label');
  const dots = [
    document.getElementById('dot-0'),
    document.getElementById('dot-1'),
  ];

  let current = 0;

  function advance() {
    cmdEl.classList.add('fade-out');

    setTimeout(() => {
      current = (current + 1) % steps.length;
      const step = steps[current];
      cmdEl.textContent = step.cmd;
      cmdEl.style.color = step.output ? 'var(--indigo)' : '';
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
