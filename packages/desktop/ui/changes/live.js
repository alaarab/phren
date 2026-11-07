import { store } from '../shell/store.js';
import { isShown } from '../shown.js';
// Phone ChangesLive: Hook-debounced frames (1 s), reconnect 1/2/4/8/16/30 s.
export function watchChanges(computer, target, element, worktree, refresh) {
  let socket, retry, failures = 0, stopped = false, closed = false, scope = worktree();
  const active = () => !closed && document.visibilityState === 'visible' && isShown(element);
  function disconnect() { clearTimeout(retry); retry = null; const old = socket; socket = null; old?.close(); }
  async function connect() {
    if (!active() || stopped || socket || retry) return;
    const caps = await store.capabilities(computer).catch(() => ({}));
    if (!active() || !caps.gitWatch || socket) return;
    scope = worktree();
    const query = new URLSearchParams({...target, ...(scope ? {worktree:scope} : {})});
    const ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/hosts/${encodeURIComponent(computer)}/v1/git/watch?${query}`);
    ws.onopen = () => { if (socket === ws) refresh(); };
    ws.onmessage = event => {
      if (socket !== ws) return;
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === 'error') { stopped = true; disconnect(); return; }
      failures = 0;
      if (frame.type === 'changed') refresh();
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (!active() || stopped) return;
      const delay = [1,2,4,8,16,30][Math.min(failures++,5)];
      retry = setTimeout(() => { retry = null; connect(); }, delay * 1000);
    };
    ws.onerror = () => ws.close();
  }
  const tick = setInterval(() => {
    if (scope !== worktree()) { scope = worktree(); stopped = false; failures = 0; disconnect(); }
    if (!active()) disconnect();
    if (active()) connect();
  }, 1000);
  connect();
  return () => { closed = true; clearInterval(tick); disconnect(); };
}
