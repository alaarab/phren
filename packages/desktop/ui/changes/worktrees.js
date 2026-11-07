import { hookPost } from '../api.js';
export function openWorktreeSessions(rows, sessions, computer, root) {
  const parts = p => p?.replace(/\\/g,'/').split('/').filter(p => p && p !== '.');
  const anchor = root?.startsWith('/') && !parts(root).includes('..') ? parts(root) : null;
  const checkouts = rows.flatMap(w => {
    const path = w.path?.replace(/\\/g,'/');
    const p = parts(path);
    if (!p?.length || path.startsWith('~') || p.includes('..') || (!path.startsWith('/') && !anchor)) return [];
    return [{w, parts:path.startsWith('/') ? p : [...anchor,...p]}];
  });
  const starts = (a,b) => b.length <= a.length && b.every((p,i) => a[i] === p);
  const open = new Map();
  for (const s of sessions.filter(s => s.computer === computer)) {
    const p = parts(s.child.cwd); if (!p) continue;
    const match = checkouts.filter(c => starts(p,c.parts)).sort((a,b) => b.parts.length-a.parts.length)[0];
    if (!match || (anchor && anchor.length > match.parts.length && starts(p,anchor))) continue;
    if (!open.has(match.w.id)) open.set(match.w.id,s);
  }
  return open;
}
export function removalWarnings(p) {
  const lines = [p.path];
  if (p.branch) lines.push(`The branch ${p.branch} stays`);
  if (p.dirty?.length || p.untracked > 0) lines.push('Uncommitted and untracked files are deleted with the checkout.');
  lines.push(...(p.dirty || []).slice(0,10));
  if (p.dirty?.length > 10) lines.push(`and ${p.dirty.length-10} more`);
  if (p.untracked) lines.push(`${p.untracked} untracked ${p.untracked === 1 ? 'file' : 'files'}`);
  const submodules = (p.submodules || []).filter(s => s.unpushedCommits > 0);
  const commits = submodules.reduce((n,s) => n+s.unpushedCommits,0);
  if (commits) lines.push(commits === 1 ? '1 unpushed commit in a submodule is lost.' : `${commits} unpushed commits in submodules are lost.`, ...submodules.map(s => `${s.path} · ${s.unpushedCommits} unpushed ${s.unpushedCommits === 1 ? 'commit' : 'commits'}`));
  if (p.sessions?.length) lines.push(p.sessions.length === 1 ? '1 session is open in this checkout.' : `${p.sessions.length} sessions are open in this checkout.`, ...p.sessions.map(s => s.title ? `${s.title} · ${s.pane}` : s.pane));
  if (!p.removable) lines.push({'sessions-open':'Close the open sessions before removing this checkout.', 'main-checkout':"The main checkout can't be removed.", 'current-checkout':"You can't remove the checkout this session is in.", 'pane-checkout':"You can't remove the checkout this session is in."}[p.reason] || "The computer can't remove this checkout right now.");
  lines.push('The checkout folder is deleted. Its branch stays in the repository.');
  return lines;
}
// The phone's conflict summary, including changed identities at equal counts.
function changeSummary(old, fresh) {
  const parts = [];
  if (old.path !== fresh.path) parts.push('the path changed');
  if (old.branch !== fresh.branch) parts.push('the branch changed');
  if (JSON.stringify(old.dirty) !== JSON.stringify(fresh.dirty)) parts.push(old.dirty.length === fresh.dirty.length ? 'different changed files' : `${old.dirty.length} → ${fresh.dirty.length} changed files`);
  if (old.untracked !== fresh.untracked) parts.push(`${old.untracked} → ${fresh.untracked} untracked files`);
  const before = new Map(old.submodules.map(s => [s.path,s.unpushedCommits]));
  const after = new Map(fresh.submodules.map(s => [s.path,s.unpushedCommits]));
  const changed = [...new Set([...before.keys(),...after.keys()])].filter(k => before.get(k) !== after.get(k)).sort();
  if (changed.length) {
    const a = [...before.values()].reduce((n,v) => n+v,0), b = [...after.values()].reduce((n,v) => n+v,0);
    parts.push(a !== b ? `${a} → ${b} unpushed submodule commits` : `the unpushed submodules changed (${changed.join(', ')})`);
  }
  const oldSessions = new Map(old.sessions.map(s => [s.pane,s]));
  const newSessions = new Map(fresh.sessions.map(s => [s.pane,s]));
  const panes = [...new Set([...oldSessions.keys(),...newSessions.keys()])].filter(k => JSON.stringify(oldSessions.get(k)) !== JSON.stringify(newSessions.get(k))).sort();
  if (panes.length) {
    if (old.sessions.length !== fresh.sessions.length) {
      parts.push(!fresh.sessions.length ? 'its open sessions closed' : !old.sessions.length ? 'a session opened in it' : `${old.sessions.length} → ${fresh.sessions.length} open sessions`);
    } else {
      const names = panes.map(pane => { const title = (newSessions.get(pane) || oldSessions.get(pane)).title; return title ? `${title} (${pane})` : pane; });
      parts.push(`the open sessions changed (${names.join(', ')})`);
    }
  }
  if (old.removable && !fresh.removable) parts.push('it can no longer be removed');
  if (!old.removable && fresh.removable) parts.push('it can be removed now');
  return parts.join(', ') || 'its preview was refreshed';
}
function readPreview(value) {
  const p = {...value,dirty:value?.dirty || [],untracked:value?.untracked || 0,submodules:value?.submodules || [],sessions:value?.sessions || []};
  const size = text => typeof text === 'string' ? new TextEncoder().encode(text).length : Infinity;
  if (!p.token || size(p.token)>4096 || !p.path || size(p.path)>4096 || (p.branch != null && size(p.branch)>1000)
      || !Array.isArray(p.dirty) || p.dirty.length>500 || p.dirty.some(path => !path || size(path)>4096 || path.includes('\0'))
      || !Number.isInteger(p.untracked) || p.untracked<0 || !Array.isArray(p.submodules) || p.submodules.length>100
      || p.submodules.some(s => !s.path || size(s.path)>4096 || !Number.isInteger(s.unpushedCommits) || s.unpushedCommits<0)
      || !Array.isArray(p.sessions) || p.sessions.length>100 || p.sessions.some(s => !s.pane || size(s.pane)>1000 || size(s.title)>1000)
      || (p.reason != null && size(p.reason)>1000)) throw new Error('The removal preview is invalid.');
  p.removable = p.removable === true;
  return p;
}
export function removalSheet(computer, target, w, done, onClose = () => {}) {
  const sheet = document.createElement('div'); sheet.className = 'chg-sheet';
  const card = document.createElement('div'); card.className = 'chg-sheet-card';
  card.setAttribute('aria-modal','true'); card.setAttribute('role','dialog'); card.setAttribute('aria-label','Remove checkout'); sheet.append(card);
  let preview, busy = false, message = '';
  const body = {server:target.server, pane:target.pane, worktree:w.id};
  function draw() {
    card.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = 'Remove checkout'; card.append(heading);
    for (const text of preview ? removalWarnings(preview) : ['Reading checkout…']) { const line = document.createElement('div'); line.textContent = text; card.append(line); }
    if (message) { const line = document.createElement('div'); line.textContent = message; line.setAttribute('role','alert'); card.append(line); }
    const btn = (text, fn, disabled = false) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chg-btn'; b.textContent = text; b.disabled = disabled; b.onclick = fn; card.append(b); };
    btn('Cancel', () => { sheet.remove(); onClose(); }, busy);
    btn('Refresh', load, busy);
    btn(busy ? 'Removing…' : 'Remove checkout', remove, busy || !preview?.removable || !preview?.token || !!preview?.sessions?.length);
    card.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
  }
  async function load() {
    if (busy) return; busy = true; draw();
    try { preview = readPreview(await hookPost(computer,'/v1/git/worktrees/remove/preview',body)); message = ''; }
    catch (e) { preview = null; message = e.message; }
    finally { busy = false; draw(); }
  }
  async function remove() {
    if (busy || !preview?.removable || !preview.token || preview.sessions?.length) return;
    busy = true; draw();
    try {
      const res = await hookPost(computer,'/v1/git/worktrees/remove',{...body,token:preview.token});
      if (res.removed !== true) throw new Error(res.error || 'The computer did not confirm the checkout was removed.');
      sheet.remove(); onClose(); done();
    } catch (e) {
      if (e.status === 409 && e.body?.code === 'worktree-changed' && e.body?.preview) {
        const old = preview;
        try {
          preview = readPreview(e.body.preview);
          message = `This checkout changed on the computer: ${changeSummary(old,preview)}. Review it before removing.`;
        } catch (invalid) { preview = null; message = invalid.message; }
      } else { preview = null; message = e.message; }
    } finally { busy = false; draw(); }
  }
  sheet.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !busy) { e.stopPropagation(); sheet.remove(); onClose(); }
    if (e.key === 'Tab') {
      const controls = [...card.querySelectorAll('button:not(:disabled)')];
      if (!controls.length) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0].focus(); }
    }
  });
  load();
  queueMicrotask(() => card.querySelector('button')?.focus());
  return sheet;
}
