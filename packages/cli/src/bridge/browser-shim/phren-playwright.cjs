'use strict';
// This preload must remain optional, dependency-free, and invisible to its host.
const noop = async () => {};
module.exports.initPage = noop;
try {
  const fs = require('node:fs');
  const socketPath = process.env.PHREN_BROWSER_SOCKET;
  if (process.env.PHREN_BROWSER_WATCH !== '0' && socketPath && fs.existsSync(socketPath)) {
    const Module = require('node:module');
    const net = require('node:net');
    const { randomUUID } = require('node:crypto');
    const installed = Symbol.for('phren.playwright.preload');
    if (!globalThis[installed]) {
      const browsers = new WeakMap(), contexts = new WeakSet(), pages = new WeakSet(), wrapped = new WeakSet();
      const safe = (fn) => (...args) => { try { Promise.resolve(fn(...args)).catch(() => {}); } catch {} };
      const id = () => randomUUID();
      function watchBrowser(browser, headless = false, playwright = '') {
        if (!browser || browsers.has(browser)) return browsers.get(browser);
        const state = { browserId: id(), socket: null, ended: false, ready: false, queued: [], cleanup: new Set() };
        browsers.set(browser, state);
        const socket = net.createConnection(socketPath); state.socket = socket; socket.unref();
        const stop = () => { if (state.ended) return; state.ended = true; for (const cleanup of state.cleanup) cleanup(); state.cleanup.clear(); socket.destroy(); };
        state.stop = stop;
        state.send = (type, data, jpeg) => {
          try {
            if (state.ended || socket.destroyed) return;
            // Pages usually open before the socket connects: keep their announcements (not frames) until it does.
            if (!state.ready) { if (type !== 3 && state.queued.length < 64) state.queued.push([type, data]); return; }
            if (socket.writableLength > 4 * 1024 * 1024) { if (type !== 3) stop(); return; }
            const json = Buffer.from(JSON.stringify({ browserId: state.browserId, ...data }));
            const body = jpeg ? Buffer.concat([Buffer.from([type]), Buffer.alloc(4), json, jpeg]) : Buffer.concat([Buffer.from([type]), json]);
            if (body.length > 4 * 1024 * 1024) return;
            if (jpeg) body.writeUInt32BE(json.length, 1);
            const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
            socket.write(Buffer.concat([head, body]));
          } catch {}
        };
        socket.on('error', stop); socket.on('close', stop);
        socket.on('connect', safe(async () => {
          if (state.ended) return;
          state.ready = true;
          state.send(1, { v: 1, pid: process.pid, session: process.env.PHREN_BROWSER_SESSION || '', cwd: process.cwd(), engine: 'chromium', headless: !!headless, playwright });
          const queued = state.queued; state.queued = [];
          for (const [type, data] of queued) state.send(type, data);
        }));
        // Wrapped before the socket connects: browser.newPage() runs right after launch() and creates its context through this method.
        for (const context of browser.contexts ? browser.contexts() : [browser]) watchContext(context, state);
        if (typeof browser.newContext === 'function') {
          const original = browser.newContext;
          browser.newContext = async function (...args) { const context = await original.apply(this, args); safe(() => watchContext(context, state))(); return context; };
        }
        if (browser.on) browser.on(browser.contexts ? 'disconnected' : 'close', safe(() => { state.send(4, {}); stop(); }));
        return state;
      }
      function watchContext(context, state) {
        if (!context || contexts.has(context) || state.ended) return;
        contexts.add(context);
        const onPage = safe(page => watchPage(page, context, state));
        context.on('page', onPage);
        state.cleanup.add(() => { try { context.off('page', onPage); } catch {} });
        for (const page of context.pages()) onPage(page);
      }
      async function watchPage(page, context, state) {
        if (pages.has(page) || state.ended || typeof context.newCDPSession !== 'function') return;
        pages.add(page);
        const pageId = id(); let closed = false, timer, pending, last = 0, cdp;
        const dimensions = () => { const v = page.viewportSize && page.viewportSize(); return { width: v?.width || 0, height: v?.height || 0 }; };
        let navigation = 0;
        const announce = safe(async () => {
          const n = ++navigation, url = page.url();
          // Emit the page before CDP starts, even if title() is slow or the page is navigating.
          state.send(2, { pageId, url, title: '', ...dimensions() });
          const title = await page.title().catch(() => '');
          if (!closed && n === navigation) state.send(2, { pageId, url, title, ...dimensions() });
        });
        const nav = safe(frame => { if (frame === page.mainFrame()) announce(); });
        const flush = () => { timer = undefined; if (closed || state.ended || !pending) return; const event = pending; pending = undefined; last = Date.now(); state.send(3, { pageId, t: last, width: Math.round(event.metadata?.deviceWidth || dimensions().width), height: Math.round(event.metadata?.deviceHeight || dimensions().height) }, Buffer.from(event.data, 'base64')); };
        const close = safe(() => {
          if (closed) return; closed = true; clearTimeout(timer); pending = undefined;
          state.cleanup.delete(cleanup); state.send(4, { pageId }); page.off('framenavigated', nav); page.off('close', close); context.off('close', close);
          if (cdp) { awaitStop(cdp); }
        });
        const cleanup = () => close(); state.cleanup.add(cleanup);
        page.on('framenavigated', nav); page.on('close', close); context.on('close', close); announce();
        // The 'page' event fires while newPage() is still setting the page up, and CDP then answers
        // "Not attached to an active page"; retry briefly with a fresh session.
        for (const delay of [0, 100, 250, 500, 1000, 2000]) {
          if (delay) await new Promise(resolve => { const t = setTimeout(resolve, delay); t.unref?.(); });
          if (closed || state.ended) return;
          try {
            cdp = await context.newCDPSession(page);
            if (closed || state.ended) { awaitStop(cdp); return; }
            cdp.on('Page.screencastFrame', safe(event => {
              // CDP acknowledgements never wait for the Hook or phone.
              Promise.resolve(cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })).catch(() => {});
              if (closed || state.ended) return;
              pending = event;
              if (!timer) { const delay = Math.max(0, 100 - (Date.now() - last)); if (!delay) flush(); else { timer = setTimeout(safe(flush), delay); timer.unref?.(); } }
            }));
            await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1280 });
            return;
          } catch { if (cdp) awaitStop(cdp); cdp = undefined; }
        }
        close();
      }
      function awaitStop(cdp) { try { Promise.resolve(cdp.send('Page.stopScreencast')).catch(() => {}); Promise.resolve(cdp.detach()).catch(() => {}); } catch {} }
      function instrument(exports, parent) {
        try {
          const chromium = exports && exports.chromium;
          if (!chromium || wrapped.has(chromium)) return;
          wrapped.add(chromium);
          let version = '';
          try { version = load.call(Module, Module._resolveFilename('playwright-core/package.json', parent), parent).version || ''; } catch {}
          for (const name of ['launch', 'launchPersistentContext', 'connectOverCDP']) {
            const original = chromium[name]; if (typeof original !== 'function') continue;
            chromium[name] = async function (...args) {
              const result = await original.apply(this, args);
              safe(() => watchBrowser(result, name === 'connectOverCDP' ? false : name === 'launchPersistentContext' ? args[1]?.headless !== false : args[0]?.headless !== false, version))();
              return result;
            };
          }
        } catch {}
      }
      const load = Module._load;
      Module._load = function (...args) { const result = load.apply(this, args); try { if (/(?:playwright|playwright-core)/.test(String(args[0]))) instrument(result, args[1]); } catch {} return result; };
      module.exports.initPage = async ({ page } = {}) => {
        try {
          if (!page) return;
          const context = page.context(), browser = context.browser();
          watchBrowser(browser || context);
        } catch {}
      };
      globalThis[installed] = module.exports;
    } else module.exports.initPage = globalThis[installed].initPage;
  }
} catch { /* A preload must never break the program it observes. */ }
