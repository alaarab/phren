import { hookPost } from '../api.js';
import { fingerprint } from './review.js';
export function excerpt(text) {
  let lines = text.replace(/\r\n/g, '\n').split('\n'), hidden = 0;
  const match = /^… (\d+) more lines$/.exec(lines.at(-1));
  if (lines.length > 1 && match) { hidden = Number(match[1]); lines.pop(); }
  while (lines.length > 1 && !lines[0].trim()) lines.shift();
  while (lines.length > 1 && !lines.at(-1).trim()) lines.pop();
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)[0].length), Infinity);
  const shown = lines.slice(0, 12).map(l => {
    const body = l.slice(Math.min(indent, /^[ \t]*/.exec(l)[0].length));
    const chars = [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(body)].map(s => s.segment);
    return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : body;
  });
  const more = Math.max(0, lines.length - 12) + hidden;
  if (more) shown.push(`… ${more} more lines`);
  return shown.join('\n').replace(/^\n+|\n+$/g, '');
}
const LANG = { ts:'ts',tsx:'tsx',js:'js',jsx:'jsx',mjs:'js',swift:'swift',kt:'kotlin',py:'python',rb:'ruby',go:'go',rs:'rust',java:'java',c:'c',h:'c',m:'objc',cpp:'cpp',cs:'csharp',sh:'sh',zsh:'sh',bash:'sh',json:'json',yml:'yaml',yaml:'yaml',toml:'toml',md:'markdown',sql:'sql',html:'html',css:'css',php:'php',dart:'dart',lua:'lua' };
export function formatNotes(notes) {
  const ordered = [...notes].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine);
  if (!ordered.length) return '';
  return [ordered.length === 1 ? 'A note on the code:' : 'Notes on the code:', ...ordered.map((n,i) => {
    const range = n.startLine === n.endLine ? n.startLine : `${n.startLine}-${n.endLine}`;
    const parts = [`${ordered.length > 1 ? `${i+1}. ` : ''}\`${n.path}:${range} (${n.diff.side} side)\``, `checkout: ${n.diff.checkout || 'unknown'}`, `patch: ${n.diff.fingerprint}`];
    const code = excerpt(n.excerpt);
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
    if (code) parts.push(`${fence}${n.language || ''}\n${code}\n${fence}`);
    if (n.note.trim()) parts.push(n.note.trim());
    return parts.join('\n');
  })].join('\n\n');
}
// Shared by inline patches and centre diff tabs; never writes to the composer.
const drafts = new Map();
export function noteDraft(computer, target) {
  const key = JSON.stringify([computer, target]);
  if (drafts.has(key)) return drafts.get(key);
  const listeners = new Set();
  const draft = { notes: [], busy: false, error: '', delivery: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    changed() { draft.delivery = null; for (const fn of listeners) fn(); },
    async add({path, line, side, text, checkout, patch}) {
      if (draft.busy || draft.editor) return;
      const hash = await fingerprint(patch);
      if (draft.busy || draft.editor) return;
      const saved = {path, startLine:line, endLine:line, excerpt:excerpt(text), note:'',
        language:LANG[path.split('.').at(-1).toLowerCase()], diff:{checkout, fingerprint:hash, side}};
      draft.edit(saved, true);
    },
    edit(saved, adding = false) {
      if (draft.busy || draft.editor) return;
      const sheet = document.createElement('div'); sheet.className = 'chg-code-note-sheet';
      const card = document.createElement('form'); card.className = 'chg-code-note-card';
      card.setAttribute('role','dialog'); card.setAttribute('aria-modal','true'); card.setAttribute('aria-label','Note on diff line');
      const label = document.createElement('label'); label.textContent = `Note on ${saved.path}:${saved.startLine} (${saved.diff.side} side)`;
      const input = document.createElement('textarea'); input.value = saved.note; input.rows = 4; input.setAttribute('aria-label',label.textContent); label.append(input);
      const quote = document.createElement('pre'); quote.textContent = saved.excerpt;
      const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save note';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      const before = document.activeElement;
      const close = () => { draft.editor = null; sheet.remove(); if (before?.isConnected) before.focus({preventScroll:true}); };
      const check = () => { save.disabled = !input.value.trim(); };
      cancel.onclick = close; input.oninput = check;
      card.onsubmit = e => { e.preventDefault(); if (!input.value.trim()) return; saved.note = input.value; if (adding) draft.notes.push(saved); close(); draft.changed(); };
      card.append(label,quote,cancel,save); sheet.append(card); document.body.append(sheet); draft.editor = sheet;
      sheet.onkeydown = e => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
          const controls = [input,cancel,...(save.disabled ? [] : [save])];
          const at = controls.indexOf(document.activeElement);
          if (e.shiftKey && at === 0) { e.preventDefault(); controls.at(-1).focus(); }
          else if (!e.shiftKey && at === controls.length-1) { e.preventDefault(); input.focus(); }
        }
      };
      check(); input.focus();
    },
    async send() {
      if (draft.busy || draft.editor || !draft.notes.length) return;
      const text = formatNotes(draft.notes);
      const deliveryId = draft.delivery || crypto.randomUUID();
      draft.delivery = deliveryId; draft.busy = true; draft.error = '';
      for (const fn of listeners) fn();
      try {
        const res = await hookPost(computer, '/v1/prompt', {target, text, deliveryId});
        if (res.ok === false || res.state === 'failed') throw new Error(res.error || res.reason || 'Could not send notes.');
        draft.notes = []; draft.delivery = null;
      } catch (e) { draft.error = e.message; }
      finally { draft.busy = false; for (const fn of listeners) fn(); }
    },
  };
  drafts.set(key, draft);
  return draft;
}
export function notesTray(draft) {
  if (!document.getElementById('changes-notes-style')) {
    const style = document.createElement('style'); style.id = 'changes-notes-style';
    style.textContent = '.chg-code-note-sheet{position:fixed;inset:0;z-index:1000;background:var(--surface);display:grid;place-items:center;padding:24px}.chg-code-note-card{width:min(560px,100%);max-height:90vh;overflow:auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;color:var(--text-2)}.chg-code-note-card textarea{display:block;box-sizing:border-box;width:100%;margin-top:8px;padding:8px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;font:inherit}.chg-code-note-card pre{overflow:auto}.chg-code-note-card button{margin-right:8px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--text-2)}.chg-notes-tray{flex:none;max-height:200px;overflow:auto;background:var(--surface);color:var(--text-2);font-size:12px}.chg-notes-tray:not(:empty){padding:8px;border-top:1px solid var(--border)}.chg-notes-tray>div{margin-top:6px;overflow-wrap:anywhere}.chg-notes-tray button{border:1px solid var(--border);border-radius:6px;background:var(--raised);color:var(--text-2);cursor:pointer}';
    document.head.append(style);
  }
  const tray = document.createElement('div'); tray.className = 'chg-notes-tray';
  if (!draft.notes.length) return tray;
  const send = document.createElement('button'); send.type = 'button';
  send.className = 'chg-btn'; send.textContent = `${draft.notes.length} ${draft.notes.length === 1 ? 'note' : 'notes'} · ${draft.busy ? 'Sending…' : 'Send to agent'}`;
  send.disabled = draft.busy; send.onclick = () => draft.send(); tray.append(send);
  for (const n of draft.notes) {
    const row = document.createElement('div'); row.textContent = `${n.path}:${n.startLine} (${n.diff.side} side): ${n.note}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove note'; remove.disabled = draft.busy;
    remove.onclick = () => { draft.notes.splice(draft.notes.indexOf(n),1); draft.changed(); };
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit note'; edit.disabled = draft.busy; edit.onclick = () => draft.edit(n);
    row.append(edit,remove); tray.append(row);
  }
  if (draft.error) { const error = document.createElement('div'); error.setAttribute('role','alert'); error.textContent = draft.error; tray.append(error); }
  return tray;
}
