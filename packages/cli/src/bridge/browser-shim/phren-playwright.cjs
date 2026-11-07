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
        const state = { browserId: id(), socket: null, ended: false, ready: false, queued: [], inputs: new Map(), cleanup: new Set() };
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
        // Bounded incremental reader: tolerate fragmented/coalesced frames and unknown types.
        let incoming = Buffer.alloc(0);
        socket.on('data', safe(chunk => {
          while (chunk.length && !state.ended) {
            const needed = incoming.length < 4 ? 4 : 4 + incoming.readUInt32BE(0);
            const count = Math.min(chunk.length, needed - incoming.length);
            incoming = Buffer.concat([incoming, chunk.subarray(0, count)]); chunk = chunk.subarray(count);
            if (incoming.length < 4) continue;
            const length = incoming.readUInt32BE(0);
            if (length < 1 || length > 4 * 1024 * 1024) { stop(); return; }
            if (incoming.length < length + 4) continue;
            const body = incoming.subarray(4); incoming = Buffer.alloc(0);
            if (body[0] !== 0x10) continue;
            try {
              const input = JSON.parse(body.subarray(1).toString('utf8'));
              if (input.browserId === state.browserId) state.inputs.get(input.pageId)?.(input);
            } catch {}
          }
        }));
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
        const pageId = id(); let closed = false, timer, pending, last = 0, cdp, metadata, inputQueue = Promise.resolve(), queuedInputs = 0;
        const send = async (method, params) => { try { if (!closed && !state.ended && cdp) await cdp.send(method, params); } catch {} };
        const dimensions = () => { const v = page.viewportSize && page.viewportSize(); return { width: v?.width || 0, height: v?.height || 0 }; };
        const keys = { Enter: ['Enter', 13], Backspace: ['Backspace', 8], Tab: ['Tab', 9], Escape: ['Escape', 27], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39] };
        const drive = async input => {
          if (closed || state.ended || !cdp) return;
          if (input.event === 'text') { if (typeof input.text === 'string' && input.text.length <= 1000) await send('Input.insertText', { text: input.text }); return; }
          if (input.event === 'key') {
            if (!Object.prototype.hasOwnProperty.call(keys, input.key)) return;
            const [code, windowsVirtualKeyCode] = keys[input.key];
            const key = { key: input.key, code, windowsVirtualKeyCode };
            await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, ...(input.key === 'Enter' ? { text: '\r' } : {}) });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }); return;
          }
          if (!['click', 'wheel'].includes(input.event) || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return;
          const width = metadata?.deviceWidth, height = metadata?.deviceHeight;
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
          const point = { x: Math.max(0, Math.min(1, input.x)) * width, y: Math.max(0, Math.min(1, input.y)) * height };
          if (input.event === 'wheel') {
            if (!Number.isFinite(input.dx) || !Number.isFinite(input.dy) || !Number.isFinite(input.dx * width) || !Number.isFinite(input.dy * height)) return;
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: input.dx * width, deltaY: input.dy * height }); return;
          }
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        };
        state.inputs.set(pageId, safe(input => {
          if (queuedInputs >= 120) return;
          queuedInputs++;
          inputQueue = inputQueue.then(() => drive(input)).catch(() => {}).finally(() => { queuedInputs--; });
        }));
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
          if (closed) return; closed = true; state.inputs.delete(pageId); clearTimeout(timer); pending = undefined;
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
              metadata = event.metadata; pending = event;
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
