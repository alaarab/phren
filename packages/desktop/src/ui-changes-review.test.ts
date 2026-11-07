import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error Browser ESM.
import { createLedger, reviewItem } from '../ui/changes/review.js';
// @ts-expect-error Browser ESM.
import { excerpt, formatNotes } from '../ui/changes/notes.js';
// @ts-expect-error Browser ESM.
import { openWorktreeSessions, removalWarnings } from '../ui/changes/worktrees.js';

function storage() {
  const data = new Map<string,string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string,value: string) => {data.set(key,value);} };
}
const file = {path:'src/a.ts',staged:false,status:'M',additions:1,deletions:1};
const patch = '@@ -1 +1 @@\n-old\n+new\n';
const section = {patch,kind:'unstaged'};

describe('Changes review ledger', () => {
  it('remembers exact patches per checkout, path and stage, invalidating same-sized edits', async () => {
    const disk = storage(), ledger = createLedger(disk);
    const item = await reviewItem('host\x01/repo',file,section);
    expect(item.fingerprint).toBe(createHash('sha256').update(patch).digest('hex'));
    ledger.toggle(item);
    expect(createLedger(disk).reviewed(item)).toBe(true);
    for (const changed of [
      await reviewItem('host\x01/repo',file,{patch:patch.replace('new','NEW')}),
      await reviewItem('other\x01/repo',file,section),
      await reviewItem('host\x01/repo',{...file,path:'b.ts'},section),
      await reviewItem('host\x01/repo',{...file,staged:true},section),
    ]) expect(ledger.reviewed(changed)).toBe(false);
    const secondViewer = createLedger(disk);
    secondViewer.toggle(item);
    expect(ledger.reviewed(item)).toBe(false);
  });
  it('counts the current pages and finds the next unreviewed page with wrapping, excluding itself', async () => {
    const ledger = createLedger(storage());
    const items = await Promise.all(['a','b','c'].map(path => reviewItem('checkout',{...file,path},section)));
    ledger.toggle(items[1]);
    expect(ledger.count(items)).toBe(1);
    expect(ledger.next(0,items)).toBe(2);
    expect(ledger.next(2,items)).toBe(0);
    ledger.toggle(items[0]);
    expect(ledger.next(2,items)).toBeNull();
    expect(ledger.next(0,[items[2]])).toBeNull();
    expect(ledger.next(-1,items)).toBeNull();
  });
  it('refuses missing or partial patches even when their visible text was reviewed', async () => {
    const ledger = createLedger(storage());
    ledger.toggle(await reviewItem('c',file,section));
    for (const [sec,truncated] of [[undefined,false],[{...section,truncated:true},false],[{...section,loadState:'truncated'},false],[section,true]] as const) {
      const item = await reviewItem('c',file,sec,truncated);
      ledger.toggle(item);
      expect(ledger.reviewed(item)).toBe(false);
    }
    expect(ledger.reviewed(await reviewItem('c',file,section))).toBe(true);
  });
  it('tolerates corrupt, inaccessible and over-limit viewer storage', async () => {
    const item = await reviewItem('c',file,section);
    for (const raw of ['{','[]','x'.repeat(1_048_577)]) {
      const ledger = createLedger({getItem:() => raw,setItem:() => {throw new Error('quota');}});
      expect(ledger.reviewed(item)).toBe(false); ledger.toggle(item);
      expect(ledger.reviewed(item)).toBe(true);
    }
  });
});

describe('phone note message contract', () => {
  const note = {path:'z.ts',startLine:8,endLine:8,excerpt:'  const x = 1;',note:'  Please simplify. \n',language:'ts',diff:{checkout:'host\x01/repo',fingerprint:'abc',side:'old'}};
  it('formats one note byte-for-byte with its original side, checkout, patch and saved excerpt', () => {
    expect(formatNotes([note])).toBe('A note on the code:\n\n`z.ts:8 (old side)`\ncheckout: host\x01/repo\npatch: abc\n```ts\nconst x = 1;\n```\nPlease simplify.');
  });
  it('sorts notes by path then line, numbers multiple notes and chooses safe fences', () => {
    const first = {...note,path:'a.md',startLine:2,endLine:4,language:'markdown',excerpt:'```md\nhello\n```',diff:{checkout:'',fingerprint:'def',side:'new'}};
    expect(formatNotes([note,first])).toBe('Notes on the code:\n\n1. `a.md:2-4 (new side)`\ncheckout: unknown\npatch: def\n````markdown\n```md\nhello\n```\n````\nPlease simplify.\n\n2. `z.ts:8 (old side)`\ncheckout: host\x01/repo\npatch: abc\n```ts\nconst x = 1;\n```\nPlease simplify.');
    expect(formatNotes([])).toBe('');
  });
  it('bounds excerpts and preserves truncation on repeated formatting', () => {
    const source = '\n' + Array.from({length:15},(_,i) => '  '+String(i)+'x'.repeat(210)).join('\r\n')+'\n';
    const cut = excerpt(source);
    expect(cut.split('\n')).toHaveLength(13);
    expect(cut.split('\n')[0]).toBe('0'+'x'.repeat(199)+'…');
    expect(cut.endsWith('… 3 more lines')).toBe(true);
    expect(excerpt(cut)).toBe(cut);
  });
});

it('matches open sessions only to the deepest checkout on the same computer', () => {
  const rows = [{id:'main',path:'/repo'},{id:'worker',path:'workers/a'}];
  const sessions = [{computer:'Mac',child:{cwd:'/repo/workers/a/src',id:'a'}},{computer:'Other',child:{cwd:'/repo',id:'b'}},{computer:'Mac',child:{cwd:'/repository',id:'c'}}];
  expect([...openWorktreeSessions(rows,sessions,'Mac','/repo')].map(([id,s]:any) => [id,s.child.id])).toEqual([['worker','a']]);
  expect(openWorktreeSessions([{id:'parent',path:'/repo'}],sessions,'Mac','/repo/workers/a').size).toBe(0);
});
it('shows destructive losses and the phone refusal for an open session', () => {
  expect(removalWarnings({path:'/repo/w',branch:'fix',dirty:['a.ts'],untracked:1,submodules:[{path:'vendor',unpushedCommits:1}],sessions:[{pane:'1',title:'Agent'}],removable:false,reason:'sessions-open'})).toEqual([
    '/repo/w','The branch fix stays','Uncommitted and untracked files are deleted with the checkout.','a.ts','1 untracked file','1 unpushed commit in a submodule is lost.','vendor · 1 unpushed commit','1 session is open in this checkout.','Agent · 1','Close the open sessions before removing this checkout.','The checkout folder is deleted. Its branch stays in the repository.',
  ]);
});
