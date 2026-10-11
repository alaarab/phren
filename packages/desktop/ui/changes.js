// Changes workbench pane: working tree, history, branches, pull requests and
// worktrees, each scoped to the session (or a worker's worktree). Owns its own
// CSS (injected once) and re-renders fully from module state.
import { hookPost, readRepoFile } from "./api.js";
import { ADDED_FILE_MAX_LINES, additionHunks, parsePatch, wordSegments } from "./patch.js";
import { branchProblem, capitalize, checksSummary, durationText, groupRuns, hostTerms, localForRemote, mergeAvailability, mergeMethods, pipelineSegments, pullStanding, relativeTime, syncAction, tokenPage, trackingText } from "./git-review.js";
import { announceGitChange } from "./diff-doc.js";

// The phone's Changes tabs, minus Working tree (the Files pane owns that here).
// "Session" is what this agent changed, from the Hook's per-call capture.
// Short labels so six fit the panel; each carries its full name as a title.
const VIEWS = [["changes", "Changes", "Uncommitted changes"], ["session", "Session", "What this agent changed"], ["history", "History", "Commit history"],
  ["branches", "Branches", "Branches"], ["pulls", "PRs", "Pull requests and checks"], ["worktrees", "Workers", "Other worktrees and the workers in them"]];
// The pulls label follows the remote's host ("MRs" on GitLab) once /v1/git/pulls answers.

const CSS = `
.chg{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--text-2);font:13px/1.45 system-ui,sans-serif}
.chg-top{padding:12px 12px 8px;flex:none}
.chg-segs{display:flex;gap:3px;background:var(--surface);border-radius:999px;padding:3px}
.chg-seg{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;border:none;background:none;color:var(--muted);font:11.5px system-ui,sans-serif;padding:5px 4px;border-radius:999px;cursor:pointer;white-space:nowrap;transition:background .18s ease,color .18s ease}
.chg-seg:hover{color:var(--text-2)}
.chg-seg.sel{background:var(--card);color:var(--accent)}
.chg-sub{margin-top:7px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-scope{display:flex;align-items:center;gap:8px;margin-top:7px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:10px}
.chg-scope-back{border:none;background:none;color:var(--accent);font:600 12px system-ui,sans-serif;cursor:pointer;padding:0}
.chg-scope-back:hover{color:var(--accent-hover)}
.chg-scope-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--text)}
.chg-body{flex:1;min-height:0;overflow:auto;padding:0 12px 12px}
.chg-sec{margin-top:12px}
.chg-sec-h{display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chg-pill{background:var(--raised);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--text-2)}
.chg-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border-radius:10px;cursor:pointer;position:relative}
.chg-row:hover{background:var(--surface)}
.chg-row-menu{position:absolute;top:40px;right:6px;z-index:7;min-width:140px;background:var(--card);border:1px solid var(--border-strong);border-radius:12px;padding:6px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.chg-row-item{display:block;width:100%;text-align:left;border:none;background:none;color:var(--text-2);font:13px system-ui,sans-serif;padding:8px 10px;border-radius:9px;cursor:pointer}
.chg-row-item:hover{background:var(--raised)}
.chg-row-item.danger{color:var(--danger)}
.chg-tile{flex:none;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px}
.chg-tile.M,.chg-tile.A{background:rgba(138,200,172,.16);color:var(--done)}
.chg-tile.D{background:rgba(239,152,152,.16);color:var(--danger)}
.chg-tile.R{background:var(--raised);color:var(--link)}
.chg-tile.Q{background:var(--raised);color:var(--muted)}
.chg-main{min-width:0;flex:1}
.chg-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-folder{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-stat{display:flex;gap:8px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;white-space:nowrap}
.chg-adds{color:var(--done)}
.chg-dels{color:var(--danger)}
.chg-actions{display:flex;gap:4px;opacity:0;pointer-events:none}
.chg-row:hover .chg-actions{opacity:1;pointer-events:auto}
.chg-icon{width:26px;height:26px;border:none;border-radius:7px;background:var(--raised);color:var(--muted);font-size:12px;cursor:pointer}
.chg-icon:hover{background:var(--card);color:var(--text)}
.chg-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 0;color:var(--muted);text-align:center}
.chg-empty-check{font-size:22px;color:var(--done)}
.chg-empty-icon{font-size:22px;color:var(--muted)}
.chg-diff{margin:2px 0 8px;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.chg-diff-sec{border-top:1px solid var(--border)}
.chg-diff-sec:first-child{border-top:none}
.chg-diff-label{padding:5px 10px;background:var(--sunken);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chg-hunk{padding:4px 10px;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--accent);border-top:1px solid var(--border)}
.chg-line{position:relative;display:flex;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.5}
.chg-line.add{background:rgba(138,200,172,.14)}
.chg-line.del{background:rgba(239,152,152,.14)}
.chg-line .ln{flex:none;width:38px;padding-right:8px;text-align:right;color:var(--dim);user-select:none}
.chg-line .mark{flex:none;width:14px;text-align:center;color:var(--dim)}
.chg-line .code{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;padding-right:44px}
.chg-word.old-changed{background:rgba(239,152,152,.32);border-radius:2px}
.chg-word.new-changed{background:rgba(138,200,172,.32);border-radius:2px}
.chg-ask{position:absolute;top:1px;right:6px;opacity:0;border:none;border-radius:6px;background:var(--card);color:var(--accent);font:600 10.5px system-ui,sans-serif;padding:2px 7px;cursor:pointer}
.chg-line:hover .chg-ask{opacity:1}
.chg-footer{position:sticky;bottom:0;flex:none;display:flex;flex-direction:column;gap:8px;padding:10px 12px;background:var(--bg);border-top:1px solid var(--border)}
.chg-error{color:var(--danger);font-size:12px}
.chg-note{color:var(--waiting);font-size:12px}
.chg-confirm{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;font-size:12.5px;color:var(--text-2)}
.chg-confirm>span:first-child{flex:1}
.chg-commit{display:flex;align-items:flex-end;gap:8px}
.chg-msg{flex:1;min-height:34px;max-height:96px;resize:none;padding:8px 10px;background:var(--sunken);border:1px solid var(--border);border-radius:12px;color:var(--text);font:13px/1.4 system-ui,sans-serif;outline:none}
.chg-msg:focus{border-color:var(--border-strong)}
.chg-btn{border:none;border-radius:10px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.chg-btn:disabled{cursor:default;opacity:.35}
.chg-btn.commit{background:var(--accent-solid);color:var(--text)}
.chg-btn.stage{background:var(--raised);color:var(--text)}
.chg-btn.danger{background:var(--danger);color:var(--bg)}
.chg-btn.push{background:var(--card);color:var(--accent);border-radius:999px}
.chg-actions-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chg-log-row{display:flex;gap:10px;padding:9px 6px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:8px}
.chg-log-row:hover{background:var(--surface)}
.chg-sha{flex:none;font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--accent)}
.chg-log-mid{min-width:0;flex:1}
.chg-log-subject{color:var(--text);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-log-meta{color:var(--muted);font-size:12px;margin-top:1px}
.chg-refs{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
.chg-ref{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:10.5px;padding:1px 6px;border-radius:999px;background:var(--raised);color:var(--muted)}
.chg-ref.head{color:var(--done)}
.chg-ref.remote{color:var(--waiting)}
.chg-ref.local{color:var(--link)}
.chg-ref.tag{color:var(--muted)}
.chg-branch-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border-radius:10px;cursor:pointer}
.chg-branch-row:hover{background:var(--surface)}
.chg-branch-check{width:16px;color:var(--done);text-align:center}
.chg-branch-name{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--text);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-branch-up{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted)}
.chg-track{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);white-space:nowrap}
.chg-track .up{color:var(--done)}
.chg-track .down{color:var(--waiting)}
.chg-pr-row{display:flex;gap:10px;min-height:44px;padding:8px 6px;border-radius:10px;cursor:pointer;align-items:flex-start}
.chg-pr-row:hover{background:var(--surface)}
.chg-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px}
.chg-pr-num{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.chg-pr-title{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-pr-meta{display:flex;gap:6px;align-items:center;margin-top:2px;flex-wrap:wrap}
.chg-chip{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);background:var(--raised);border-radius:999px;padding:1px 7px}
.chg-checks{font-size:11px;border-radius:999px;padding:1px 8px}
.chg-checks.passing{background:rgba(138,200,172,.16);color:var(--done)}
.chg-checks.failing{background:rgba(239,152,152,.16);color:var(--danger)}
.chg-checks.pending{background:rgba(224,188,127,.16);color:var(--waiting)}
.chg-wt-row{display:flex;gap:10px;min-height:44px;padding:8px 6px;border-radius:10px;cursor:pointer;align-items:center}
.chg-wt-row:hover{background:var(--surface)}
.chg-wt-glyph{flex:none;width:24px;height:24px;border-radius:7px;display:flex;align-items:center;justify-content:center;background:var(--raised);color:var(--accent);font-size:12px}
.chg-wt-mid{min-width:0;flex:1}
.chg-wt-title{font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-wt-detail{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.chg-toast{position:sticky;bottom:0;display:flex;justify-content:center;padding:10px;pointer-events:none}
.chg-toast>span{background:var(--raised);border:1px solid var(--border-strong);border-radius:999px;padding:6px 14px;font-size:12.5px;color:var(--text)}
.chg-notice{margin:8px 0;padding:10px;background:var(--surface);border:1px solid var(--border-strong);border-radius:10px;font-size:12.5px;color:var(--text-2)}
.chg-notice-title{font-weight:600;color:var(--text);margin-bottom:3px}
.chg-notice-link{display:inline-block;margin-top:6px;color:var(--link);cursor:pointer;text-decoration:none}
.chg-sheet{position:fixed;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.chg-sheet-card{width:min(440px,90vw);background:var(--card);border:1px solid var(--border-strong);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}
.chg-sheet-h{font-weight:600;font-size:15px;color:var(--text)}
.chg-field{display:flex;flex-direction:column;gap:4px}
.chg-field label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.chg-field input,.chg-field textarea{background:var(--sunken);border:1px solid var(--border);border-radius:10px;color:var(--text);font:13px/1.4 system-ui,sans-serif;padding:8px 10px;outline:none;resize:vertical}
.chg-field input:focus,.chg-field textarea:focus{border-color:var(--border-strong)}
.chg-sheet-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.chg-branchbar{display:flex;align-items:center;gap:8px;margin-top:8px;min-height:30px}
.chg-bb-name{display:flex;align-items:center;gap:6px;min-width:0;flex:1;border:none;background:none;padding:0;cursor:pointer;color:var(--text);font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px}
.chg-bb-name>span:first-of-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-bb-glyph{color:var(--accent)}
.chg-bb-track{flex:none;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--raised);color:var(--muted)}
.chg-bb-track.unpushed{color:var(--waiting)}
.chg-bb-btn{flex:none;border:1px solid var(--border);background:var(--raised);color:var(--text-2);border-radius:999px;font:600 11.5px system-ui,sans-serif;padding:4px 10px;cursor:pointer;white-space:nowrap}
.chg-bb-btn:hover:not(:disabled){border-color:var(--border-strong);color:var(--text)}
.chg-bb-btn:disabled{opacity:.4;cursor:default}
.chg-bb-btn.pull{color:var(--waiting)}
.chg-bb-pr{flex:none;font:600 11px "JetBrains Mono",ui-monospace,Menlo,monospace;padding:2px 8px;border-radius:999px;cursor:pointer;border:none}
.chg-bb-pr.passing{background:rgba(138,200,172,.16);color:var(--done)}
.chg-bb-pr.failing{background:rgba(239,152,152,.16);color:var(--danger)}
.chg-bb-pr.pending{background:rgba(224,188,127,.16);color:var(--waiting)}
.chg-bb-pr.none{background:var(--raised);color:var(--muted)}
.chg-commit-head{padding:10px 6px 12px;border-bottom:1px solid var(--border)}
.chg-back{border:none;background:none;color:var(--accent);font:600 12px system-ui,sans-serif;cursor:pointer;padding:0;margin-bottom:8px}
.chg-commit-subject{font-size:14px;font-weight:600;color:var(--text);line-height:1.35}
.chg-commit-body{margin-top:6px;white-space:pre-wrap;font-size:12.5px;color:var(--text-2)}
.chg-commit-meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:8px;font-size:12px;color:var(--muted)}
.chg-copy{border:1px solid var(--border);background:var(--raised);color:var(--accent);font:11.5px "JetBrains Mono",ui-monospace,Menlo,monospace;border-radius:999px;padding:1px 8px;cursor:pointer}
.chg-log-row .chg-icon{opacity:0}
.chg-log-row:hover .chg-icon{opacity:1}
.chg-checks-list{margin:6px 0 10px;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.chg-check{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--border);font-size:12.5px;cursor:default}
.chg-check:first-child{border-top:none}
.chg-check.link{cursor:pointer}
.chg-check.link:hover{background:var(--surface)}
.chg-check-state{flex:none;width:16px;text-align:center;font-weight:700}
.chg-check-state.failing{color:var(--danger)}.chg-check-state.pending{color:var(--waiting)}.chg-check-state.passing{color:var(--done)}.chg-check-state.skipped,.chg-check-state.neutral{color:var(--muted)}
.chg-check-name{flex:1;min-width:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-check-wf{color:var(--muted);font-size:11.5px}
.chg-pr-card{margin-top:12px;padding:10px;border:1px solid var(--border-strong);border-radius:12px;background:var(--surface)}
.chg-pr-card-title{font-size:13.5px;font-weight:600;color:var(--text);cursor:pointer}
.chg-pr-card-title:hover{color:var(--link)}
.chg-pr-standing{margin-top:4px;font-size:12px;color:var(--waiting)}
.chg-session-sum{margin-top:10px;font-size:12px;color:var(--muted)}
.chg-edit-label{display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--sunken);font-size:11px;letter-spacing:.04em;color:var(--muted)}
.chg-edit-label .chg-stat{margin-left:auto}
.chg-mark{display:inline-flex;flex:none;align-items:center;justify-content:center}
.chg-mark.github{color:var(--text)}.chg-mark.gitlab{color:#FC6D26}.chg-mark.gitboy{color:var(--accent)}.chg-mark.none{color:var(--muted)}
.chg-host{display:flex;align-items:center;gap:10px;margin-top:10px;padding:8px 10px;border:1px solid var(--border);border-radius:12px;background:linear-gradient(180deg,var(--surface),transparent)}
.chg-host-who{flex:1;min-width:0}
.chg-host-name{font-weight:600;color:var(--text);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-host-sub{font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-host-link{border:none;background:none;padding:0 0 0 8px;color:var(--muted);font:11.5px system-ui,sans-serif;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.chg-host-link:hover{color:var(--danger)}
.chg-host-btn{border:1px solid var(--border);background:none;color:var(--text-2);font:12px system-ui,sans-serif;border-radius:999px;padding:4px 10px;cursor:pointer;white-space:nowrap}
.chg-host-btn:hover{color:var(--text);border-color:var(--border-strong)}
.chg-connect{margin-top:12px;padding:14px;border:1px solid var(--border-strong);border-radius:14px;background:radial-gradient(120% 140% at 0% 0%,rgba(185,148,244,.10),transparent 60%),var(--surface)}
.chg-connect-h{display:flex;gap:12px;align-items:center}
.chg-connect-title{font-size:15px;font-weight:650;color:var(--text)}
.chg-connect-sub{font-size:12px;color:var(--muted);margin-top:2px}
.chg-connect-steps{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.chg-connect-step{display:flex;align-items:flex-start;gap:10px;font-size:12.5px;color:var(--text-2)}
.chg-connect-body{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding-top:1px}
.chg-connect-body.row{flex-direction:row;align-items:center;flex-wrap:wrap}
.chg-connect-n{flex:none;width:20px;height:20px;border-radius:50%;background:var(--card);color:var(--accent);font:600 11px system-ui,sans-serif;display:inline-flex;align-items:center;justify-content:center}
.chg-connect-input{flex:1;min-width:160px;background:var(--sunken);border:1px solid var(--border-strong);border-radius:10px;padding:8px 10px;color:var(--text);font:12.5px "JetBrains Mono",ui-monospace,Menlo,monospace;outline:none}
.chg-connect-input:focus{border-color:var(--accent)}
.chg-connect-foot{margin-top:10px;font-size:11px;color:var(--muted)}
.chg-req{position:relative;margin:12px 0 14px;padding:12px 12px 10px;border:1px solid var(--border-strong);border-radius:14px;background:var(--surface);overflow:hidden}
.chg-req::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--border)}
.chg-req.passing::before{background:var(--done)}.chg-req.failing::before{background:var(--danger)}
.chg-req.pending::before{background:linear-gradient(90deg,transparent,var(--waiting),transparent);background-size:200% 100%;animation:chg-sweep 1.6s linear infinite}
@keyframes chg-sweep{from{background-position:200% 0}to{background-position:-200% 0}}
.chg-req-top{display:flex;align-items:center;gap:8px}
.chg-req-state{font:600 11px system-ui,sans-serif;border-radius:999px;padding:2px 9px}
.chg-req-state.open{background:rgba(138,200,172,.16);color:var(--done)}
.chg-req-state.draft{background:var(--raised);color:var(--muted)}
.chg-req-state.merged{background:rgba(185,148,244,.18);color:var(--accent)}
.chg-req-state.closed{background:rgba(239,152,152,.14);color:var(--danger)}
.chg-req-num{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;color:var(--muted);font-size:12px}
.chg-req-age{margin-left:auto;font-size:11.5px;color:var(--muted)}
.chg-req-title{margin-top:6px;font-size:15px;line-height:1.3;font-weight:650;color:var(--text);cursor:pointer}
.chg-req-title:hover{color:var(--link)}
.chg-req-route{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.chg-req-arrow{color:var(--muted)}
.chg-req-by{font-size:11.5px;color:var(--muted)}
.chg-req-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chg-pill{font-size:11.5px;border-radius:999px;padding:2px 9px;background:var(--raised);color:var(--text-2)}
.chg-pill.ok{background:rgba(138,200,172,.16);color:var(--done)}.chg-pill.bad{background:rgba(239,152,152,.16);color:var(--danger)}.chg-pill.wait{background:rgba(224,188,127,.16);color:var(--waiting)}
.chg-pipe{margin-top:10px}
.chg-pipe .chg-checks-list{margin:6px 0 0}
.chg-pipe-h{display:flex;align-items:baseline;gap:8px}
.chg-pipe-word{flex:none;font-weight:600;font-size:12.5px;color:var(--text);white-space:nowrap}
.chg-pipe-word.passing{color:var(--done)}.chg-pipe-word.failing{color:var(--danger)}.chg-pipe-word.pending{color:var(--waiting)}
.chg-pipe-word.link{cursor:pointer}.chg-pipe-word.link:hover{text-decoration:underline}
.chg-pipe-sum{font-size:11.5px;color:var(--muted)}
.chg-pipe-bar{display:flex;gap:2px;height:6px;margin:6px 0 4px;border-radius:999px;overflow:hidden}
.chg-pipe-seg{flex-basis:0;min-width:6px}
.chg-pipe-seg.passing{background:var(--done)}.chg-pipe-seg.failing{background:var(--danger)}.chg-pipe-seg.skipped,.chg-pipe-seg.neutral{background:var(--raised)}
.chg-pipe-seg.pending{background:repeating-linear-gradient(-45deg,var(--waiting) 0 6px,rgba(224,188,127,.45) 6px 12px);background-size:17px 17px;animation:chg-stripes .8s linear infinite}
@keyframes chg-stripes{from{background-position:0 0}to{background-position:17px 0}}
.chg-check-group{padding:5px 10px;background:var(--sunken);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.chg-check-state.pending::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--waiting);animation:chg-pulse 1.2s ease-in-out infinite}
@keyframes chg-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.chg-check-detail{font-size:11px;color:var(--danger);max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-check-go{color:var(--muted);font-size:11px;opacity:0}
.chg-check.link:hover .chg-check-go{opacity:1}
.chg-merge-banner{margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--raised);font-size:12.5px;color:var(--text-2)}
.chg-merge-banner.ok{background:rgba(138,200,172,.12);color:var(--done)}.chg-merge-banner.bad{background:rgba(239,152,152,.12);color:var(--danger)}.chg-merge-banner.wait{background:rgba(224,188,127,.12);color:var(--waiting)}
.chg-merge-banner ul{margin:4px 0 0 16px;padding:0;color:var(--text-2);font-size:12px}
.chg-merge-word{font-weight:600}
.chg-merge{margin-top:10px}
.chg-merge-row{display:flex;gap:8px;align-items:center}
.chg-merge-method{flex:1;min-width:0;background:var(--sunken);color:var(--text);border:1px solid var(--border-strong);border-radius:10px;padding:8px;font:12.5px system-ui,sans-serif}
.chg-merge-ask{margin-bottom:8px;font-size:12.5px;color:var(--text)}
.chg-btn.merge{background:var(--raised);color:var(--text)}
.chg-btn.merge.ready{background:var(--done);color:var(--bg);box-shadow:0 0 0 0 rgba(138,200,172,.5);animation:chg-ready 2.4s ease-out infinite}
@keyframes chg-ready{0%{box-shadow:0 0 0 0 rgba(138,200,172,.45)}70%{box-shadow:0 0 0 8px rgba(138,200,172,0)}100%{box-shadow:0 0 0 0 rgba(138,200,172,0)}}
@media (prefers-reduced-motion:reduce){.chg-req.pending::before,.chg-pipe-seg.pending,.chg-check-state.pending::before,.chg-btn.merge.ready{animation:none}}
`;

export function openChanges(el, ctx) {
  const computer = ctx.computer;
  const target = ctx.child && ctx.child.target;
  const state = {
    view: "changes", status: null, expanded: null, diffs: {}, addedText: {},
    draft: "", confirm: null, error: "", landed: "",
    log: null, logRef: null,
    branches: null, pulls: null, worktrees: null,
    worktree: null, worktreeTitle: null,
    rowMenu: null, sheet: null, notice: null, copyToast: null, busy: null,
    commit: null, session: null, sessionOpen: null,
    connect: null, merge: null,
  };
  let timer = null;
  let commitBtn = null;
  let toastTimer = null;
  let visible = true;
  // The footer's PR action needs the branch's pull request; loaded quietly once.
  let pullsRequested = false;

  injectStyle();

  const scopeBody = (extra = {}) => {
    const b = { target, ...extra };
    if (state.worktree) b.worktree = state.worktree;
    return b;
  };
  const repo = () => (state.status && state.status.repository) || undefined;
  // What the remote's host calls its requests; generic until /v1/git/pulls says.
  const terms = () => hostTerms(state.pulls && state.pulls.host);
  const changedPaths = () => [...new Set((state.status?.files || []).filter((f) => !f.staged).map((f) => f.path))];
  // Only this pane's own commit box counts: the chat composer beside it is a
  // textarea too, and is focused most of the time.
  const typing = () => { const a = document.activeElement; return !!a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.tagName === "SELECT") && el.contains(a); };
  // A half-typed token or an open merge confirmation must survive the 10-second re-read.
  const canPoll = () => visible && document.visibilityState === "visible" && !state.confirm && !state.sheet && !typing()
    && !(state.connect && state.connect.token) && !(state.merge && state.merge.confirm);

  function render() {
    el.innerHTML = "";
    const root = div("chg");
    root.appendChild(renderTop());
    root.appendChild(renderBody());
    if (state.view === "changes") root.appendChild(renderFooter());
    if (state.notice) root.appendChild(renderNotice());
    if (state.copyToast) root.appendChild(renderToast());
    if (state.sheet) root.appendChild(renderSheet());
    el.appendChild(root);
    const ta = root.querySelector(".chg-msg");
    if (ta) autosize(ta);
  }

  function toast(text) {
    state.copyToast = text;
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { state.copyToast = null; render(); }, 1600);
  }

  function copy(text, label) {
    const done = () => toast("Copied " + (label || text));
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  function selectView(key) {
    if (state.view === key) return;
    state.view = key;
    state.expanded = null; state.rowMenu = null; state.error = ""; state.confirm = null;
    if (key !== "history") { state.logRef = null; state.commit = null; }
    refresh();
  }

  function openWorktree(wt) {
    state.worktree = wt.id;
    state.worktreeTitle = worktreeTitle(wt);
    state.status = null; state.expanded = null; state.diffs = {}; state.addedText = {};
    state.log = null; state.branches = null; state.pulls = null; state.worktrees = null;
    state.view = "changes"; state.error = ""; state.confirm = null;
    pullsRequested = false;
    refresh();
  }

  function closeWorktree() {
    state.worktree = null; state.worktreeTitle = null;
    state.status = null; state.log = null; state.branches = null; state.pulls = null; state.worktrees = null;
    state.view = "worktrees"; state.error = "";
    pullsRequested = false;
    refresh();
  }

  async function refresh() {
    if (!target) { state.error = "This session has no target."; render(); return; }
    try {
      if (state.view === "changes") await loadChanges();
      else if (state.view === "history") { await loadHistory(); if (state.commit && !state.commit.data) await loadCommit(state.commit.sha); }
      else if (state.view === "session") { state.session = await hookPost(computer, "/v1/git/session-changes", scopeBody()); if (!state.status) await loadStatusQuiet(); }
      else if (state.view === "branches") { state.branches = await hookPost(computer, "/v1/git/branches", scopeBody()); await loadStatusQuiet(); }
      else if (state.view === "pulls") { state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody()); await loadStatusQuiet(); }
      else if (state.view === "worktrees") state.worktrees = await hookPost(computer, "/v1/git/worktrees", scopeBody());
      state.error = "";
      loadPullsQuiet();
    } catch (e) {
      state.error = e.message || String(e);
    }
    render();
  }

  async function loadChanges() {
    const res = await hookPost(computer, "/v1/git/status", scopeBody());
    state.status = res;
    if (state.expanded) {
      const f = (res.files || []).find((x) => x.path === state.expanded.path && !!x.staged === state.expanded.staged);
      if (!f) state.expanded = null;
      else await loadDiff(f);
    }
    loadPullsQuiet();
  }

  // The branch bar shows on every view; other views read status quietly.
  async function loadStatusQuiet() {
    try { state.status = await hookPost(computer, "/v1/git/status", scopeBody()); } catch { /* the bar just hides */ }
  }

  async function loadCommit(sha) {
    state.commit = { sha, data: null, error: "" };
    try { state.commit.data = await hookPost(computer, "/v1/git/show", scopeBody({ sha })); }
    catch (e) { state.commit.error = e.status === 404 && /Unknown Phren Hook route/.test(e.message) ? "Update Phren on this computer to open commits." : e.message || String(e); }
  }

  // The branch's pull request drives the footer's PR action; best effort.
  async function loadPullsQuiet() {
    if (pullsRequested) return;
    pullsRequested = true;
    try {
      state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody());
      // The branch bar's pull request chip shows on every view.
      if (!typing()) render();
    } catch { /* optional: the PRs tab reports its own failure */ }
  }

  async function loadHistory() {
    state.log = await hookPost(computer, "/v1/git/log", scopeBody({ limit: 60, ...(state.logRef ? { ref: state.logRef } : {}) }));
  }

  async function loadDiff(f) {
    const res = await hookPost(computer, "/v1/diff", scopeBody({ paths: [f.path] }));
    const data = (res.files || []).find((x) => x.path === f.path) || (res.files || [])[0];
    state.diffs[f.path] = data;
    // A new file has no diff hunks until it is staged; read its content instead.
    const added = f.status === "?" || f.status === "A";
    const hasHunks = ((data && data.sections) || []).some((s) => !s.binary && parsePatch(s.patch || "").length > 0);
    if (added && !hasHunks) {
      try { state.addedText[f.path] = (await readRepoFile(computer, target, f.path)).text || ""; }
      catch { state.addedText[f.path] = null; }
    }
  }

  // Run a write, then refresh; a failure becomes the one error line and never refetches.
  async function write(fn) {
    try {
      await fn();
      state.error = ""; state.confirm = null;
      announce();
      await refresh();
    } catch (e) {
      state.confirm = null; state.error = e.message || String(e);
      render();
    }
  }

  const doStage = (f) => write(() => hookPost(computer, "/v1/git/stage", scopeBody({ paths: [f.path], expectedRepository: repo() })));
  const doUnstage = (f) => write(() => hookPost(computer, "/v1/git/unstage", scopeBody({ paths: [f.path], expectedRepository: repo() })));
  const doStageAll = () => write(() => hookPost(computer, "/v1/git/stage", scopeBody({ paths: changedPaths(), confirmBulk: true, expectedRepository: repo() })));
  const doDiscard = () => write(() => hookPost(computer, "/v1/git/discard", scopeBody({ paths: [state.confirm.path], expectedRepository: repo() })));

  async function doCommit() {
    if (state.busy) return;
    state.busy = "commit";
    try {
      const res = await hookPost(computer, "/v1/git/commit", scopeBody({ message: state.draft.trim(), expectedRepository: repo() }));
      if (res && res.ok === false) { state.notice = { title: "The commit was refused", message: res.output || "git commit failed." }; }
      else { state.draft = ""; state.landed = `Committed ${res.short || ""} ${res.subject || ""}`.trim(); }
      state.error = ""; state.confirm = null;
      await refresh();
    } catch (e) { state.notice = { title: "Could not commit", message: e.message || String(e) }; }
    finally { state.busy = null; render(); }
  }

  async function doPush(confirmDefault) {
    if (state.busy) return;
    state.busy = "push";
    try {
      const res = await hookPost(computer, "/v1/git/push", scopeBody({ expectedRepository: repo(), ...(confirmDefault ? { confirmDefault: true } : {}) }));
      if (res && res.ok === false) { state.notice = { title: "The push was refused", message: res.output || "git push failed." }; }
      else { state.landed = `Pushed to ${res.upstream || "origin"}`; state.confirm = null; }
      state.error = "";
      await refresh();
    } catch (e) {
      if (e.status === 409 && e.body && e.body.defaultBranch) { state.confirm = { kind: "push", branch: e.body.defaultBranch }; state.error = ""; }
      else state.notice = { title: "Could not push", message: e.message || String(e) };
    } finally { state.busy = null; render(); }
  }

  async function doPullRequest(draft, fields) {
    if (state.busy) return;
    state.busy = "pr";
    try {
      const body = scopeBody({ draft: !!draft, ...(fields || {}) });
      const res = await hookPost(computer, "/v1/git/pr", body);
      const t = hostTerms(res && res.host);
      if (res && res.ok && res.url) state.notice = { title: res.existing ? `This branch already has a ${t.long}` : `${capitalize(t.long)} opened`, message: res.url, url: res.url, site: t.name };
      else state.notice = { title: `Could not open a ${t.long}`, message: res.message || res.output || `The ${t.long} was not created.` };
      state.sheet = null;
      await refresh();
    } catch (e) { state.notice = { title: `Could not open a ${terms().long}`, message: e.message || String(e) }; }
    finally { state.busy = null; render(); }
  }

  // Tell diff tabs the index moved; this pane's own listener skips its echo.
  let announcedAt = 0;
  function announce() { announcedAt = Date.now(); announceGitChange(computer, target); }

  // ---- branch moves: fetch, pull, switch, create ----------------------------
  async function sync(kind) {
    if (state.busy) return;
    state.busy = kind; render();
    try {
      const res = await hookPost(computer, `/v1/git/${kind}`, scopeBody({ expectedRepository: repo() }));
      if (res && res.ok === false) state.notice = { title: kind === "pull" ? "The pull was refused" : "The fetch was refused", message: res.output || `git ${kind} failed.` };
      else state.landed = kind === "pull" ? (res.commits ? `Pulled ${res.commits} commit${res.commits === 1 ? "" : "s"}` : "Already up to date") : `Fetched ${res.remote || "origin"}`;
      pullsRequested = false;
      announce();
      await loadStatusQuiet();
      await refresh();
    } catch (e) { state.notice = { title: kind === "pull" ? "Could not pull" : "Could not fetch", message: newerHook(e, kind) }; }
    finally { state.busy = null; render(); }
  }

  async function checkout(request) {
    if (state.busy) return;
    state.busy = "checkout"; state.confirm = null; render();
    try {
      const res = await hookPost(computer, "/v1/git/checkout", scopeBody({ branch: request.branch, ...(request.create ? { create: true } : {}),
        ...(request.startPoint ? { startPoint: request.startPoint } : {}), ...(request.carry ? { carryChanges: true } : {}), expectedRepository: repo() }));
      if (res && res.ok === false) state.notice = { title: "Git refused the switch", message: res.output || "git switch failed." };
      else {
        state.landed = res.created ? `Created and switched to ${res.branch}` : `Switched to ${res.branch}`;
        if (res.carried) state.landed += ` with ${res.carried} uncommitted file${res.carried === 1 ? "" : "s"}`;
        state.sheet = null; state.log = null; state.commit = null; pullsRequested = false; state.pulls = null;
      }
      announce();
      await loadStatusQuiet();
      await refresh();
    } catch (e) {
      if (e.status === 409 && e.code === "git-dirty") state.confirm = { kind: "carry", request, message: e.message };
      else if (state.sheet && state.sheet.kind === "branch") state.sheet.error = newerHook(e, "checkout");
      else state.notice = { title: "Could not switch branches", message: newerHook(e, "checkout") };
    } finally { state.busy = null; render(); }
  }

  function newerHook(e, what) {
    if (e && e.status === 404 && /Unknown Phren Hook route/.test(e.message || "")) {
      return `Update Phren on ${computer} to ${what === "checkout" ? "switch branches" : what} from the desktop.`;
    }
    return (e && e.message) || String(e);
  }

  function openBranchSheet(startPoint) {
    state.sheet = { kind: "branch", name: startPoint ? localForRemote(startPoint) : "", startPoint: startPoint || null, error: "" };
    render();
    el.querySelector(".chg-sheet input[data-key=name]")?.focus();
  }

  // ---- header ---------------------------------------------------------------
  function renderTop() {
    const top = div("chg-top");
    const segs = div("chg-segs");
    const t = terms();
    for (const [key, label, title] of VIEWS) {
      if ((key === "worktrees" || key === "session") && state.worktree) continue;
      const seg = button(key === "pulls" ? t.short + "s" : label, "chg-seg" + (state.view === key ? " sel" : ""), () => selectView(key));
      seg.title = key === "pulls" ? `${capitalize(t.long)}s and checks` : title;
      seg.dataset.view = key;
      segs.appendChild(seg);
    }
    top.appendChild(segs);
    if (state.status && !(state.view === "history" && state.commit)) top.appendChild(renderBranchBar(state.status));
    if (state.view === "changes" && state.status) top.appendChild(div("chg-sub", subline(state.status)));
    else if (state.view === "history" && state.logRef) top.appendChild(div("chg-sub", "History · " + state.logRef));
    else if (state.view === "worktrees" && state.worktrees) top.appendChild(div("chg-sub", worktreeCaption(state.worktrees)));
    if (state.worktree) top.appendChild(renderScope());
    return top;
  }

  function renderBranchBar(s) {
    const bar = div("chg-branchbar");
    const name = button("", "chg-bb-name", () => selectView("branches"));
    name.title = "Branches";
    name.appendChild(span("chg-bb-glyph", "⑂"));
    name.appendChild(span("", s.branch || "detached HEAD"));
    const track = trackingText(s);
    if (track) name.appendChild(span("chg-bb-track" + (s.upstream ? "" : " unpushed"), track));
    bar.appendChild(name);
    const pr = state.pulls && state.pulls.current;
    if (pr && pr.head === s.branch) {
      const t = terms();
      const chip = button(`${t.ref}${pr.number}`, "chg-bb-pr " + (pr.checks || "none"), () => selectView("pulls"));
      chip.title = `${capitalize(t.long)} ${t.ref}${pr.number}` + (pr.checks ? ` · checks ${pr.checks}` : "");
      bar.appendChild(chip);
    }
    const act = syncAction(s);
    if (act) {
      const b = button(state.busy === act.kind ? (act.kind === "pull" ? "Pulling…" : "Fetching…") : act.label, "chg-bb-btn" + (act.kind === "pull" ? " pull" : ""), () => sync(act.kind));
      b.disabled = !!state.busy;
      b.dataset.act = act.kind;
      b.title = act.kind === "pull" ? `Fast-forward ${s.branch} to ${s.upstream}` : `Fetch ${s.upstream ? s.upstream.split("/")[0] : "origin"} and update ahead/behind`;
      bar.appendChild(b);
    }
    const nb = button("+ Branch", "chg-bb-btn", () => openBranchSheet(null));
    nb.title = "Create a branch here and switch to it";
    nb.disabled = !!state.busy;
    nb.dataset.act = "new-branch";
    bar.appendChild(nb);
    return bar;
  }

  function renderScope() {
    const bar = div("chg-scope");
    bar.appendChild(button("← All worktrees", "chg-scope-back", closeWorktree));
    bar.appendChild(div("chg-scope-name", state.worktreeTitle || "worktree"));
    return bar;
  }

  function subline(s) {
    // The branch bar above names the branch; this line counts the work.
    const n = s.totalFiles != null ? s.totalFiles : (s.files || []).length;
    if (!n) return "Nothing uncommitted";
    let line = `${n} file${n === 1 ? "" : "s"} changed`;
    const counts = [];
    if (s.additions) counts.push("+" + s.additions);
    if (s.deletions) counts.push("−" + s.deletions);
    if (counts.length) line += " " + counts.join(" ");
    return line;
  }

  function worktreeCaption(res) {
    const rows = Array.isArray(res) ? res : (res.worktrees || []);
    return `${rows.length} worktree${rows.length === 1 ? "" : "s"}`;
  }

  // ---- body ----------------------------------------------------------------
  function renderBody() {
    if (state.view === "history") return state.commit ? renderCommit() : renderHistory();
    if (state.view === "session") return renderSession();
    if (state.view === "branches") return renderBranches();
    if (state.view === "pulls") return renderPulls();
    if (state.view === "worktrees") return renderWorktrees();
    return renderChanges();
  }

  function renderChanges() {
    const body = div("chg-body");
    if (!state.status) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const staged = (state.status.files || []).filter((f) => f.staged);
    const changed = (state.status.files || []).filter((f) => !f.staged);
    if (!staged.length && !changed.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-check", "✓"));
      empty.appendChild(div("", "Working tree clean"));
      body.appendChild(empty);
      return body;
    }
    if (staged.length) body.appendChild(renderSection("STAGED", staged));
    if (changed.length) body.appendChild(renderSection("CHANGES", changed));
    return body;
  }

  function renderSection(title, files) {
    const sec = div("chg-sec");
    const head = div("chg-sec-h");
    head.appendChild(span("", title));
    head.appendChild(span("chg-pill", String(files.length)));
    sec.appendChild(head);
    for (const f of files) {
      sec.appendChild(renderFileRow(f));
      if (state.confirm && state.confirm.kind === "discard" && state.confirm.path === f.path) sec.appendChild(renderDiscardConfirm(f));
      else if (state.expanded && state.expanded.path === f.path && state.expanded.staged === !!f.staged) sec.appendChild(renderDiff(f));
    }
    return sec;
  }

  function renderFileRow(f) {
    const row = div("chg-row");
    // Modified and renamed files open their diff as a centre tab; untracked and
    // deleted files have nothing to read, so they expand inline.
    row.onclick = () => {
      if (f.status === "?" || f.status === "D") toggleDiff(f);
      else ctx.openFile(f.path, { diff: true });
    };
    row.appendChild(div("chg-tile " + tileClass(f.status), f.status === "?" ? "?" : f.status));
    const main = div("chg-main");
    main.appendChild(div("chg-name", basename(f.path)));
    const dir = dirname(f.path);
    if (dir) main.appendChild(div("chg-folder", dir));
    row.appendChild(main);
    const stat = div("chg-stat");
    if (f.additions) stat.appendChild(span("chg-adds", "+" + f.additions));
    if (f.deletions) stat.appendChild(span("chg-dels", "−" + f.deletions));
    row.appendChild(stat);
    const actions = div("chg-actions");
    actions.appendChild(icon("↗", "Open file", () => ctx.openFile(f.path)));
    if (f.status !== "?" && f.status !== "D") actions.appendChild(icon("⇄", "Open side-by-side diff", () => ctx.openFile(f.path, { diff: true })));
    if (f.staged) actions.appendChild(icon("−", "Unstage", () => doUnstage(f)));
    else {
      actions.appendChild(icon("+", "Stage", () => doStage(f)));
      actions.appendChild(icon("⋯", "More actions", () => { state.rowMenu = state.rowMenu === f.path ? null : f.path; render(); }));
    }
    row.appendChild(actions);
    if (state.rowMenu === f.path) row.appendChild(renderRowMenu(f));
    return row;
  }

  function renderRowMenu(f) {
    const menu = div("chg-row-menu");
    menu.onclick = (e) => e.stopPropagation();
    menu.appendChild(button("Discard", "chg-row-item danger", () => { state.rowMenu = null; state.confirm = { kind: "discard", path: f.path }; render(); }));
    return menu;
  }

  function renderDiscardConfirm(f) {
    const row = div("chg-confirm");
    row.appendChild(span("", `Discard changes to ${basename(f.path)}? This cannot be undone.`));
    row.appendChild(button("Discard", "chg-btn danger", doDiscard));
    row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
    return row;
  }

  // ---- diff ----------------------------------------------------------------
  function renderDiff(f) {
    const wrap = div("chg-diff");
    const data = state.diffs[f.path];
    const sections = (data && data.sections) || [];
    const hasHunks = sections.some((s) => !s.binary && parsePatch(s.patch || "").length > 0);
    // Added or untracked file with no diff hunks: show its content as additions.
    if ((f.status === "?" || f.status === "A") && !hasHunks) {
      const text = state.addedText[f.path];
      if (text == null) { wrap.appendChild(div("chg-diff-label", "Loading file…")); return wrap; }
      const { hunks, truncated } = additionHunks(text);
      const box = div("chg-diff-sec");
      if (!hunks.length) box.appendChild(div("chg-diff-label", "Empty file."));
      else renderHunks(box, hunks, f.path);
      if (truncated) box.appendChild(div("chg-diff-label", `Showing the first ${ADDED_FILE_MAX_LINES} lines`));
      wrap.appendChild(box);
      return wrap;
    }
    if (!data) { wrap.appendChild(div("chg-diff-label", "Loading diff…")); return wrap; }
    if (!sections.length) { wrap.appendChild(div("chg-diff-label", "No changes to show.")); return wrap; }
    const multi = sections.length > 1;
    for (const sec of sections) {
      const box = div("chg-diff-sec");
      if (multi) box.appendChild(div("chg-diff-label", sec.kind === "staged" ? "Staged" : "Unstaged"));
      if (sec.binary) box.appendChild(div("chg-diff-label", "Binary file"));
      else renderPatch(box, sec.patch || "", f.path);
      if (sec.truncated) box.appendChild(div("chg-diff-label", "Diff truncated."));
      wrap.appendChild(box);
    }
    return wrap;
  }

  function renderPatch(box, patch, path) {
    const parsed = parsePatch(patch);
    renderHunks(box, Array.isArray(parsed) ? parsed : (parsed && parsed.hunks) || [], path);
  }

  function renderHunks(box, hunks, path) {
    for (const hunk of hunks) {
      const header = hunkHeader(hunk);
      if (header) box.appendChild(div("chg-hunk", header));
      const lines = hunk.lines || [];
      annotate(lines);
      for (const line of lines) box.appendChild(renderDiffLine(line, path));
    }
  }

  function renderDiffLine(line, path) {
    const kind = line.kind === "add" ? "add" : line.kind === "del" ? "del" : "";
    const row = div("chg-line" + (kind ? " " + kind : ""));
    row.appendChild(span("ln", line.kind === "add" ? "" : line.oldLine != null ? String(line.oldLine) : ""));
    row.appendChild(span("ln", line.kind === "del" ? "" : line.newLine != null ? String(line.newLine) : ""));
    row.appendChild(span("mark", kind === "add" ? "+" : kind === "del" ? "−" : " "));
    const code = div("code");
    if (line.segments && line.segments.length) {
      const cls = kind === "del" ? "chg-word old-changed" : "chg-word new-changed";
      code.innerHTML = line.segments.map((s) => s.changed ? `<span class="${cls}">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)).join("");
    } else {
      code.textContent = line.text == null ? "" : line.text;
    }
    row.appendChild(code);
    const askNo = line.newLine != null ? line.newLine : line.oldLine;
    if (askNo != null) {
      row.appendChild(button("Ask", "chg-ask", (e) => { e.stopPropagation(); ctx.ask(`${path}:${askNo}\n> ${line.text || ""}\n`); }));
    }
    return row;
  }

  // Tag adjacent del→add pairs so wordSegments can tint only the changed words.
  function annotate(lines) {
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind !== "del") { i++; continue; }
      let d = i; while (d < lines.length && lines[d].kind === "del") d++;
      let a = d; while (a < lines.length && lines[a].kind === "add") a++;
      const dels = lines.slice(i, d), adds = lines.slice(d, a);
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const seg = wordSegments(dels[k].text || "", adds[k].text || "");
        dels[k].segments = seg.old; adds[k].segments = seg.new;
      }
      i = a;
    }
  }

  async function toggleDiff(f) {
    state.rowMenu = null;
    const same = state.expanded && state.expanded.path === f.path && state.expanded.staged === !!f.staged;
    if (same) { state.expanded = null; render(); return; }
    state.expanded = { path: f.path, staged: !!f.staged };
    render();
    try { await loadDiff(f); state.error = ""; } catch (e) { state.error = e.message || String(e); }
    render();
  }

  // ---- footer (working tree) -----------------------------------------------
  function renderFooter() {
    commitBtn = null;
    const foot = div("chg-footer");
    if (state.error) foot.appendChild(div("chg-error", state.error));
    if (state.confirm && state.confirm.kind === "push") {
      const row = div("chg-confirm");
      row.appendChild(span("", `Push to ${state.confirm.branch}, the default branch?`));
      row.appendChild(button("Push to " + state.confirm.branch, "chg-btn danger", () => doPush(true)));
      row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
      foot.appendChild(row);
    }
    const s = state.status;
    if (!s) return foot;
    const plan = planPublish(s, state.pulls && state.pulls.current);
    if (plan.isEmpty && !state.landed) return foot;
    if (plan.commit) {
      const row = div("chg-commit");
      const ta = document.createElement("textarea");
      ta.className = "chg-msg"; ta.placeholder = "Commit message"; ta.rows = 1; ta.value = state.draft;
      ta.addEventListener("input", () => { state.draft = ta.value; autosize(ta); updateCommitBtn(); });
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && state.draft.trim()) { e.preventDefault(); doCommit(); } });
      row.appendChild(ta);
      commitBtn = button("✓ Commit", "chg-btn commit", doCommit);
      commitBtn.disabled = !state.draft.trim() || !!state.busy;
      commitBtn.title = state.draft.trim() ? "Commit the staged files (⌘Enter)" : "Write a commit message first.";
      row.appendChild(commitBtn);
      foot.appendChild(row);
    } else if (plan.stageAll > 0) {
      foot.appendChild(button("Stage all " + plan.stageAll, "chg-btn stage", doStageAll));
    }
    const actions = div("chg-actions-row");
    const push = button(plan.push || "Push", "chg-btn push", () => doPush(false));
    push.disabled = !plan.push || !!state.busy;
    if (!plan.push) push.title = pushReason(s) || "Nothing to push.";
    actions.appendChild(push);
    const existing = plan.pull && plan.pull.existing;
    const t = terms();
    const prBtn = button(existing ? `${t.short} ${t.ref}${existing}` : `Create ${t.short}`, "chg-btn stage", () => {
      if (existing) window.open(plan.pull.url, "_blank", "noopener");
      else if (plan.pull && plan.pull.open) openPrSheet(s);
    });
    prBtn.disabled = !plan.pull || !!state.busy;
    if (!plan.pull) prBtn.title = prReason(s, t.long);
    actions.appendChild(prBtn);
    foot.appendChild(actions);
    if (state.landed) foot.appendChild(div("chg-note", state.landed));
    return foot;
  }

  function updateCommitBtn() {
    if (!commitBtn) return;
    const staged = (state.status?.files || []).some((f) => f.staged);
    commitBtn.disabled = !state.draft.trim() || !staged || !!state.busy;
  }

  function openPrSheet(s) {
    state.sheet = { title: "", body: "", base: s.defaultBranch || "main", head: s.branch || "" };
    render();
  }

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 96) + "px";
  }

  // ---- history -------------------------------------------------------------
  function sectionHead(title, count) {
    const head = div("chg-sec-h");
    head.appendChild(span("", title));
    if (count != null) head.appendChild(span("chg-pill", String(count)));
    return head;
  }

  function renderHistory() {
    const body = div("chg-body");
    if (!state.log) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const commits = state.log.commits || [];
    const uncommitted = state.log.uncommitted;
    if (uncommitted && uncommitted.files > 0) body.appendChild(renderUncommittedRow(uncommitted));
    if (!commits.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⟲"));
      empty.appendChild(div("", "No commits yet"));
      body.appendChild(empty);
      return body;
    }
    for (const c of commits) body.appendChild(renderCommitRow(c));
    return body;
  }

  function renderUncommittedRow(u) {
    const row = div("chg-log-row");
    const mid = div("chg-log-mid");
    mid.appendChild(div("chg-log-subject", "Uncommitted changes"));
    mid.appendChild(div("chg-log-meta", `${u.files} file${u.files === 1 ? "" : "s"}`));
    row.appendChild(mid);
    const stat = div("chg-stat");
    if (u.additions) stat.appendChild(span("chg-adds", "+" + u.additions));
    if (u.deletions) stat.appendChild(span("chg-dels", "−" + u.deletions));
    row.appendChild(stat);
    return row;
  }

  function renderCommitRow(c) {
    const row = div("chg-log-row");
    row.appendChild(span("chg-sha", c.short || (c.sha || "").slice(0, 7)));
    const mid = div("chg-log-mid");
    mid.appendChild(div("chg-log-subject", c.subject || ""));
    mid.appendChild(div("chg-log-meta", `${c.author || ""} · ${relTime(c.date)}`));
    const refs = (c.refs || []).filter((r) => r && r.name);
    if (refs.length) {
      const wrap = div("chg-refs");
      for (const r of refs) wrap.appendChild(span("chg-ref " + (r.kind || ""), r.name));
      mid.appendChild(wrap);
    }
    row.appendChild(mid);
    row.title = c.sha || "";
    row.onclick = async () => { await loadCommit(c.sha); render(); };
    row.appendChild(icon("⧉", "Copy " + (c.short || ""), () => copy(c.sha, c.short || "")));
    return row;
  }

  // ---- commit detail ---------------------------------------------------------
  function renderCommit() {
    const body = div("chg-body");
    const head = div("chg-commit-head");
    head.appendChild(button("← History", "chg-back", () => { state.commit = null; render(); }));
    const c = state.commit;
    if (!c.data) { head.appendChild(div("chg-empty", c.error || "Loading commit…")); body.appendChild(head); return body; }
    const d = c.data;
    head.appendChild(div("chg-commit-subject", d.subject || ""));
    if (d.body) head.appendChild(div("chg-commit-body", d.body));
    const meta = div("chg-commit-meta");
    meta.appendChild(button(d.short || d.sha.slice(0, 7), "chg-copy", () => copy(d.sha, d.short)));
    meta.appendChild(span("", `${d.author || ""} · ${relTime(d.date)}`));
    if (d.committer && d.committer !== d.author) meta.appendChild(span("", `committed by ${d.committer}`));
    if ((d.parents || []).length > 1) meta.appendChild(span("chg-chip", `merge of ${d.parents.length}`));
    const stat = div("chg-stat");
    stat.appendChild(span("", `${d.totalFiles} file${d.totalFiles === 1 ? "" : "s"}`));
    if (d.additions) stat.appendChild(span("chg-adds", "+" + d.additions));
    if (d.deletions) stat.appendChild(span("chg-dels", "−" + d.deletions));
    meta.appendChild(stat);
    head.appendChild(meta);
    const refs = (d.refs || []).filter((r) => r && r.name);
    if (refs.length) {
      const wrap = div("chg-refs");
      for (const r of refs) wrap.appendChild(span("chg-ref " + (r.kind || ""), r.name));
      head.appendChild(wrap);
    }
    body.appendChild(head);
    const sec = div("chg-sec");
    sec.appendChild(sectionHead("FILES", (d.files || []).length));
    for (const f of d.files || []) {
      const row = div("chg-row");
      row.dataset.path = f.path;
      row.appendChild(div("chg-tile " + tileClass(f.status), f.status));
      const main = div("chg-main");
      main.appendChild(div("chg-name", basename(f.path)));
      const dir = f.oldPath && f.oldPath !== f.path ? `${f.oldPath} →` : dirname(f.path);
      if (dir) main.appendChild(div("chg-folder", dir));
      row.appendChild(main);
      const st = div("chg-stat");
      if (f.binary) st.appendChild(span("", "binary"));
      else { if (f.additions) st.appendChild(span("chg-adds", "+" + f.additions)); if (f.deletions) st.appendChild(span("chg-dels", "−" + f.deletions)); }
      row.appendChild(st);
      row.onclick = () => ctx.openFile(f.path, { commit: { sha: d.sha, short: d.short, parent: (d.parents || [])[0] || null, oldPath: f.oldPath || f.path },
        ...(state.worktree ? { worktree: state.worktree } : {}) });
      sec.appendChild(row);
    }
    if (d.truncated) sec.appendChild(div("chg-note", `Showing ${(d.files || []).length} of ${d.totalFiles} files; some patches were cut short.`));
    body.appendChild(sec);
    return body;
  }

  // ---- this session -----------------------------------------------------------
  function renderSession() {
    const body = div("chg-body");
    const res = state.session;
    if (!res) { body.appendChild(div("chg-empty", state.error ? newerHook({ status: /Unknown Phren Hook route/.test(state.error) ? 404 : 0, message: state.error }, "review this session's changes") : "Loading…")); return body; }
    const files = res.files || [];
    if (!files.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "◇"));
      empty.appendChild(div("", "This session has not changed any files yet"));
      empty.appendChild(div("chg-folder", "Edits and shell commands the agent runs are recorded here as they happen."));
      body.appendChild(empty);
      return body;
    }
    body.appendChild(div("chg-session-sum", `${res.calls} tool call${res.calls === 1 ? "" : "s"} changed ${res.totalFiles} file${res.totalFiles === 1 ? "" : "s"} · +${res.additions} −${res.deletions}` + (res.others ? ` · ${res.others} in other repositories` : "")));
    const sec = div("chg-sec");
    sec.appendChild(sectionHead("CHANGED BY THIS AGENT", files.length));
    const uncommitted = new Set((state.status?.files || []).map((f) => f.path));
    for (const f of files) {
      const row = div("chg-row");
      row.dataset.path = f.path;
      row.appendChild(div("chg-tile " + tileClass(f.status), f.status));
      const main = div("chg-main");
      main.appendChild(div("chg-name", basename(f.path)));
      main.appendChild(div("chg-folder", [dirname(f.path), `${f.edits.length} edit${f.edits.length === 1 ? "" : "s"}`, uncommitted.has(f.path) ? "uncommitted" : "committed"].filter(Boolean).join(" · ")));
      row.appendChild(main);
      const st = div("chg-stat");
      if (f.added) st.appendChild(span("chg-adds", "+" + f.added));
      if (f.removed) st.appendChild(span("chg-dels", "−" + f.removed));
      row.appendChild(st);
      const actions = div("chg-actions");
      if (uncommitted.has(f.path) && f.status !== "D") actions.appendChild(icon("⇄", "Open the file's uncommitted diff", () => ctx.openFile(f.path, { diff: true })));
      actions.appendChild(icon("↗", "Open file", () => ctx.openFile(f.path)));
      row.appendChild(actions);
      row.onclick = () => { state.sessionOpen = state.sessionOpen === f.path ? null : f.path; render(); };
      sec.appendChild(row);
      if (state.sessionOpen === f.path) {
        const wrap = div("chg-diff");
        if (f.redacted || f.binary) wrap.appendChild(div("chg-diff-label", f.binary ? "Binary file" : "Patch hidden: this looks like a secrets file."));
        f.edits.forEach((e, i) => {
          const box = div("chg-diff-sec");
          const label = div("chg-edit-label");
          label.appendChild(span("", `Edit ${i + 1} of ${f.edits.length}`));
          const es = div("chg-stat");
          if (e.added) es.appendChild(span("chg-adds", "+" + e.added));
          if (e.removed) es.appendChild(span("chg-dels", "−" + e.removed));
          label.appendChild(es);
          box.appendChild(label);
          if (e.patch) renderPatch(box, e.patch, f.path);
          if (e.truncated) box.appendChild(div("chg-diff-label", "Patch truncated."));
          wrap.appendChild(box);
        });
        sec.appendChild(wrap);
      }
    }
    body.appendChild(sec);
    return body;
  }

  // ---- branches ------------------------------------------------------------
  function renderBranches() {
    const body = div("chg-body");
    const res = state.branches;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const local = res.local || [], remote = res.remote || [];
    if (!local.length && !remote.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⑂"));
      empty.appendChild(div("", "No branches yet"));
      body.appendChild(empty);
      return body;
    }
    if (state.confirm && ["switch", "track", "carry"].includes(state.confirm.kind)) body.appendChild(renderBranchConfirm());
    if (local.length) {
      body.appendChild(sectionHead("LOCAL", local.length));
      for (const b of local) body.appendChild(renderBranchRow(b, res.current, false));
    }
    if (remote.length) {
      body.appendChild(sectionHead("REMOTE", remote.length));
      for (const b of remote) body.appendChild(renderBranchRow(b, res.current, true));
    }
    return body;
  }

  function renderBranchRow(b, current, isRemote) {
    const row = div("chg-branch-row");
    row.appendChild(span("chg-branch-check", b.name === current ? "✓" : ""));
    row.appendChild(span("chg-branch-name", b.name));
    if (b.upstream) row.appendChild(span("chg-branch-up", b.upstream));
    const track = div("chg-track");
    if (b.ahead > 0) track.appendChild(span("up", "↑" + b.ahead));
    if (b.behind > 0) track.appendChild(span("down", "↓" + b.behind));
    row.appendChild(track);
    row.dataset.branch = b.name;
    const isCurrent = !isRemote && b.name === current;
    if (isCurrent) row.title = `${b.name} is checked out`;
    else if (isRemote) row.title = `Check out ${b.name} as a local branch`;
    else row.title = `Switch to ${b.name}`;
    row.onclick = () => {
      if (isCurrent) return;
      if (isRemote) {
        const local = localForRemote(b.name);
        const exists = (state.branches?.local || []).some((l) => l.name === local);
        state.confirm = exists ? { kind: "switch", branch: local } : { kind: "track", branch: local, startPoint: b.name };
      } else state.confirm = { kind: "switch", branch: b.name };
      render();
    };
    row.appendChild(icon("⧉", "Copy " + b.name, () => copy(b.name, b.name)));
    row.appendChild(icon("⟲", "History of " + b.name, () => { state.logRef = b.name; state.view = "history"; state.commit = null; refresh(); }));
    if (!isRemote) row.appendChild(icon("+", "New branch from " + b.name, () => openBranchSheet(b.name)));
    return row;
  }

  function renderBranchConfirm() {
    const c = state.confirm;
    const row = div("chg-confirm");
    if (c.kind === "carry") {
      row.appendChild(span("", c.message));
      row.appendChild(button("Switch with changes", "chg-btn commit", () => checkout({ ...c.request, carry: true })));
    } else if (c.kind === "track") {
      row.appendChild(span("", `Check out ${c.startPoint} as ${c.branch}, tracking it?`));
      row.appendChild(button("Check out", "chg-btn commit", () => checkout({ branch: c.branch, create: true, startPoint: c.startPoint })));
    } else {
      row.appendChild(span("", `Switch to ${c.branch}?`));
      row.appendChild(button("Switch", "chg-btn commit", () => checkout({ branch: c.branch })));
    }
    row.appendChild(button("Cancel", "chg-btn stage", () => { state.confirm = null; render(); }));
    return row;
  }

  // ---- pull requests -------------------------------------------------------
  function pullColor(p) {
    if (p.draft) return "var(--muted)";
    if (p.state === "MERGED") return "var(--accent)";
    if (p.state === "CLOSED") return "var(--danger)";
    if (p.state === "OPEN") return "var(--done)";
    return "var(--muted)";
  }


  function renderPulls() {
    const body = div("chg-body");
    const res = state.pulls;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    body.appendChild(renderHostBar(res));
    if (res.available === false) {
      // GitLab and gitboy sign in with a token this computer stores; the rest
      // say why in the host's own terms (a missing CLI, an unplaced remote).
      if (res.reason === "auth" && res.host && (res.host.kind === "gitlab" || res.host.kind === "gitboy")) { body.appendChild(renderConnect(res)); return body; }
      const empty = div("chg-empty");
      empty.appendChild(hostMark(res.host && res.host.kind, 28));
      const t = hostTerms(res.host);
      empty.appendChild(div("", `${capitalize(t.long)}s are not available here`));
      empty.appendChild(div("chg-folder", res.message || `${t.name} did not answer on this computer.`));
      body.appendChild(empty);
      return body;
    }
    const pulls = res.pulls || [];
    if (res.current) body.appendChild(renderCurrentPull(res.current, res.host));
    if (!pulls.length && !res.current) {
      const empty = div("chg-empty");
      empty.appendChild(hostMark(res.host && res.host.kind, 28));
      empty.appendChild(div("", `No open ${terms().long}s`));
      body.appendChild(empty);
      return body;
    }
    const others = pulls.filter((p) => !res.current || p.number !== res.current.number);
    if (others.length) body.appendChild(sectionHead(`OPEN ${terms().long.toUpperCase()}S`, others.length));
    for (const p of others) body.appendChild(renderPullRow(p));
    return body;
  }

  // The remote's host, who this computer reads it as, and a way out to its site.
  function renderHostBar(res) {
    const host = res.host || {};
    const bar = div("chg-host");
    bar.appendChild(hostMark(host.kind, 18));
    const who = div("chg-host-who");
    who.appendChild(div("chg-host-name", host.kind ? `${host.name}${host.domain && !/^(github|gitlab)\.com$/.test(host.domain) ? ` · ${host.domain}` : ""}` : "No git host"));
    const account = res.account;
    const via = account ? { environment: "from the environment", file: "connected here", cli: "via glab" }[account.source] || "" : host.kind === "github" ? "via gh" : "";
    const line = account && account.user ? `@${account.user}${via ? ` · ${via}` : ""}` : via;
    if (line || (account && account.source === "file")) {
      const sub = div("chg-host-sub", line);
      if (account && account.source === "file") { const out = button("Disconnect", "chg-host-link", () => doConnect("")); sub.appendChild(out); }
      who.appendChild(sub);
    }
    bar.appendChild(who);
    if (host.webUrl) bar.appendChild(button(`Open on ${host.kind ? host.name : "the host"} ↗`, "chg-host-btn", () => window.open(host.webUrl, "_blank", "noopener")));
    return bar;
  }

  function renderConnect(res) {
    const host = res.host;
    const c = state.connect || (state.connect = { token: "", error: "" });
    const card = div("chg-connect");
    const head = div("chg-connect-h");
    head.appendChild(hostMark(host.kind, 30));
    const words = div("");
    words.appendChild(div("chg-connect-title", `Connect ${host.name}`));
    words.appendChild(div("chg-connect-sub", `See ${hostTerms(host).long}s, pipelines and reviews for ${host.domain} here, and merge from this pane.`));
    head.appendChild(words);
    card.appendChild(head);
    const steps = div("chg-connect-steps");
    const page = tokenPage(host);
    const one = div("chg-connect-step");
    one.appendChild(span("chg-connect-n", "1"));
    const oneBody = div("chg-connect-body");
    oneBody.appendChild(span("", host.kind === "gitlab" ? "Create a personal access token with the api scope" : "Create a personal access token with read:repo and write:repo"));
    if (page) oneBody.appendChild(button("Open token page ↗", "chg-host-btn", () => window.open(page, "_blank", "noopener")));
    one.appendChild(oneBody);
    steps.appendChild(one);
    const two = div("chg-connect-step");
    two.appendChild(span("chg-connect-n", "2"));
    const twoBody = div("chg-connect-body row");
    two.appendChild(twoBody);
    const input = document.createElement("input");
    input.type = "password"; input.className = "chg-connect-input"; input.placeholder = host.kind === "gitlab" ? "glpat-…" : "gbp_…";
    input.autocomplete = "off"; input.spellcheck = false; input.value = c.token;
    input.oninput = () => { c.token = input.value; c.error = ""; };
    input.onkeydown = (e) => { if (e.key === "Enter") doConnect(c.token); };
    twoBody.appendChild(input);
    twoBody.appendChild(button(state.busy === "connect" ? "Checking…" : "Connect", "chg-btn commit", () => doConnect(c.token)));
    steps.appendChild(two);
    card.appendChild(steps);
    if (c.error) card.appendChild(div("chg-error", c.error));
    card.appendChild(div("chg-connect-foot", `The token is checked with ${host.name}, then stored only on that computer (mode 600), never in your Phren store. You can also run: phren bridge git-host set ${host.domain} ${host.kind}`));
    return card;
  }

  async function doConnect(token) {
    if (state.busy) return;
    state.busy = "connect"; render();
    try {
      const res = await hookPost(computer, "/v1/git/host-token", scopeBody({ token: String(token || "").trim(), expectedRepository: repo() }));
      if (res && res.ok) {
        state.connect = null;
        toast(res.disconnected ? `Disconnected ${res.domain}` : `Connected${res.user ? ` as @${res.user}` : ""}`);
        state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody());
      } else (state.connect || (state.connect = { token: "" })).error = (res && res.message) || "The host refused that token.";
    } catch (e) { (state.connect || (state.connect = { token: "" })).error = newerHook(e, "host-token"); }
    finally { state.busy = null; render(); }
  }

  function renderCurrentPull(p, host) {
    const t = terms();
    const card = div("chg-req " + (p.checks || "none"));
    const top = div("chg-req-top");
    top.appendChild(span("chg-req-state " + reqState(p), reqStateLabel(p)));
    top.appendChild(span("chg-req-num", `${t.ref}${p.number}`));
    if (p.updated) top.appendChild(span("chg-req-age", relativeTime(p.updated)));
    card.appendChild(top);
    const title = div("chg-req-title", p.title || "");
    title.title = p.url || "";
    title.onclick = () => { if (p.url) window.open(p.url, "_blank", "noopener"); };
    card.appendChild(title);
    const route = div("chg-req-route");
    route.appendChild(span("chg-chip", p.head || ""));
    route.appendChild(span("chg-req-arrow", "→"));
    route.appendChild(span("chg-chip", p.base || ""));
    if (p.author) route.appendChild(span("chg-req-by", `by @${p.author}`));
    if (typeof p.ahead === "number" && p.ahead) route.appendChild(span("chg-req-by", `${p.ahead} ahead`));
    if (typeof p.behind === "number" && p.behind) route.appendChild(span("chg-req-by", `${p.behind} behind`));
    card.appendChild(route);

    const chips = div("chg-req-chips");
    const review = { APPROVED: ["Approved", "ok"], CHANGES_REQUESTED: ["Changes requested", "bad"], REVIEW_REQUIRED: ["Review required", "wait"] }[p.reviewDecision];
    if (review) chips.appendChild(span("chg-pill " + review[1], review[0] + (p.approvals ? ` · ${p.approvals.given}${p.approvals.required ? `/${p.approvals.required}` : ""}` : "")));
    else if (p.approvals && p.approvals.given) chips.appendChild(span("chg-pill ok", `${p.approvals.given} approval${p.approvals.given === 1 ? "" : "s"}`));
    if (typeof p.comments === "number" && p.comments) chips.appendChild(span("chg-pill", `${p.comments} comment${p.comments === 1 ? "" : "s"}`));
    if (p.conflicts) chips.appendChild(span("chg-pill bad", "Conflicts"));
    if (chips.childNodes.length) card.appendChild(chips);

    const runs = p.checkRuns || [];
    if (runs.length || p.pipeline) card.appendChild(renderPipeline(p, runs));
    else if (p.checks == null) card.appendChild(div("chg-log-meta", `No checks reported for this ${t.long}.`));

    const merge = mergeAvailability(p);
    if (p.mergeState || (p.blockers && p.blockers.length)) card.appendChild(renderMergeBanner(p));
    if (merge.show) card.appendChild(renderMergeBar(p, host, merge));
    return card;
  }

  function reqState(p) { return p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : p.draft ? "draft" : "open"; }
  function reqStateLabel(p) { return { merged: "Merged", closed: "Closed", draft: "Draft", open: "Open" }[reqState(p)]; }

  function renderPipeline(p, runs) {
    const box = div("chg-pipe");
    const head = div("chg-pipe-h");
    // GitHub reports checks; GitLab and gitboy run a pipeline.
    const what = state.pulls && state.pulls.host && state.pulls.host.kind !== "github" ? "Pipeline" : "Checks";
    const word = { failing: `${what} failing`, pending: `${what} running`, passing: `${what} passed` }[p.checks] || "Checks";
    const label = span("chg-pipe-word " + (p.checks || ""), word);
    if (p.pipeline && p.pipeline.url) { label.classList.add("link"); label.onclick = () => window.open(p.pipeline.url, "_blank", "noopener"); label.title = p.pipeline.url; }
    head.appendChild(label);
    if (runs.length) head.appendChild(span("chg-pipe-sum", checksSummary(runs)));
    box.appendChild(head);
    const bar = div("chg-pipe-bar");
    for (const seg of pipelineSegments(runs)) {
      const s = div("chg-pipe-seg " + seg.state);
      s.style.flexGrow = String(seg.count);
      s.title = `${seg.count} ${seg.state}`;
      bar.appendChild(s);
    }
    if (runs.length) box.appendChild(bar);
    for (const group of groupRuns(runs)) {
      const list = div("chg-checks-list");
      if (group.name) list.appendChild(div("chg-check-group", group.name));
      for (const r of group.runs) {
        const row = div("chg-check" + (r.url ? " link" : ""));
        row.appendChild(span("chg-check-state " + r.state, { failing: "✕", pending: "", passing: "✓", skipped: "–", neutral: "○" }[r.state] ?? "○"));
        const name = span("chg-check-name", r.name);
        if (r.detail) name.title = r.detail;
        row.appendChild(name);
        if (r.detail && r.state === "failing") row.appendChild(span("chg-check-detail", r.detail));
        const d = durationText(r.seconds);
        if (d) row.appendChild(span("chg-check-wf", d));
        if (r.url) { row.title = r.url; row.onclick = () => window.open(r.url, "_blank", "noopener"); row.appendChild(span("chg-check-go", "↗")); }
        list.appendChild(row);
      }
      box.appendChild(list);
    }
    return box;
  }

  function renderMergeBanner(p) {
    const tone = p.mergeState === "CLEAN" ? "ok" : p.mergeState === "DIRTY" ? "bad" : p.mergeState === "UNKNOWN" ? "" : "wait";
    const banner = div("chg-merge-banner " + tone);
    banner.appendChild(div("chg-merge-word", p.mergeDetail || pullStanding({ mergeState: p.mergeState }) || "Merge state unknown"));
    const extra = (p.blockers || []).filter((b) => b !== p.mergeDetail);
    if (extra.length) { const ul = document.createElement("ul"); for (const b of extra) { const li = document.createElement("li"); li.textContent = b; ul.appendChild(li); } banner.appendChild(ul); }
    return banner;
  }

  function renderMergeBar(p, host, avail) {
    const m = state.merge && state.merge.number === p.number ? state.merge : (state.merge = { number: p.number, method: mergeMethods(host)[0][0], confirm: false });
    const bar = div("chg-merge");
    if (!avail.enabled) { bar.appendChild(div("chg-log-meta", avail.why)); return bar; }
    if (m.confirm) {
      const sha = p.headSha ? p.headSha.slice(0, 7) : "";
      const label = (mergeMethods(host).find(([k]) => k === m.method) || [, "Merge"])[1];
      bar.appendChild(div("chg-merge-ask", `${label} ${terms().ref}${p.number}${sha ? ` at ${sha}` : ""} into ${p.base || "its base"}?`));
      const row = div("chg-merge-row");
      row.appendChild(button("Cancel", "chg-btn stage", () => { m.confirm = false; render(); }));
      row.appendChild(button(state.busy === "merge" ? "Merging…" : "Confirm merge", "chg-btn merge", () => doMerge(p)));
      bar.appendChild(row);
      return bar;
    }
    const row = div("chg-merge-row");
    const select = document.createElement("select");
    select.className = "chg-merge-method";
    for (const [key, label] of mergeMethods(host)) { const o = document.createElement("option"); o.value = key; o.textContent = label; if (key === m.method) o.selected = true; select.appendChild(o); }
    select.onchange = () => { m.method = select.value; };
    row.appendChild(select);
    row.appendChild(button(avail.ready ? "Merge" : "Merge…", "chg-btn merge" + (avail.ready ? " ready" : ""), () => { m.confirm = true; render(); }));
    bar.appendChild(row);
    if (!avail.ready) bar.appendChild(div("chg-log-meta", `${host && host.kind ? host.name : "The host"} decides; it will refuse while checks or reviews block it.`));
    return bar;
  }

  async function doMerge(p) {
    if (state.busy) return;
    state.busy = "merge"; render();
    const m = state.merge;
    try {
      const res = await hookPost(computer, "/v1/git/pr/merge", scopeBody({ number: p.number, method: m.method, ...(p.headSha ? { expectedHeadSha: p.headSha } : {}), expectedRepository: repo() }));
      if (res && res.ok) { state.merge = null; toast(`Merged ${terms().ref}${p.number}`); state.landed = `merged-${p.number}`; }
      else state.notice = { title: res && res.reason === "blocked" ? `${terms().ref}${p.number} can't be merged yet` : "The merge was refused", message: (res && res.message) || "The host refused the merge." };
      m.confirm = false;
      state.pulls = await hookPost(computer, "/v1/git/pulls", scopeBody());
    } catch (e) { state.notice = { title: "Could not merge", message: newerHook(e, "pr/merge") }; }
    finally { state.busy = null; render(); }
  }

  function renderPullRow(p) {
    const row = div("chg-pr-row");
    const dot = div("chg-dot");
    dot.style.background = pullColor(p);
    row.appendChild(dot);
    const mid = div("chg-main");
    const title = div("chg-pr-title");
    title.appendChild(span("chg-req-num", `${terms().ref}${p.number}`));
    title.appendChild(document.createTextNode(" " + (p.title || "")));
    mid.appendChild(title);
    const meta = div("chg-pr-meta");
    if (p.draft) meta.appendChild(span("chg-req-state draft", "Draft"));
    if (p.head) meta.appendChild(span("chg-chip", p.head));
    if (p.author) meta.appendChild(span("chg-req-by", `@${p.author}`));
    if (p.updated) meta.appendChild(span("chg-req-by", relativeTime(p.updated)));
    mid.appendChild(meta);
    row.appendChild(mid);
    row.title = p.url || "";
    row.onclick = () => { if (p.url) window.open(p.url, "_blank", "noopener"); };
    return row;
  }

  // ---- worktrees -----------------------------------------------------------
  function worktreeTitle(w) { return (w.worker && w.worker.label) || w.branch || w.path || "worktree"; }

  function worktreeDetail(w) {
    if (w.main) return (w.branch || "detached") + " · main checkout";
    if (w.worker) return w.branch || "detached";
    return w.branch == null ? "detached · " + w.path : w.path;
  }

  function renderWorktrees() {
    const body = div("chg-body");
    const res = state.worktrees;
    if (!res) { body.appendChild(div("chg-empty", state.error ? state.error : "Loading…")); return body; }
    const rows = (res.worktrees || []).filter(Boolean);
    if (!rows.length) {
      const empty = div("chg-empty");
      empty.appendChild(div("chg-empty-icon", "⑂"));
      empty.appendChild(div("", "No other worktrees"));
      body.appendChild(empty);
      return body;
    }
    const workers = rows.filter((w) => w.worker);
    const others = rows.filter((w) => !w.worker);
    if (workers.length) { body.appendChild(sectionHead("WORKERS", workers.length)); for (const w of workers) body.appendChild(renderWorktreeRow(w)); }
    if (others.length) { body.appendChild(sectionHead(workers.length ? "OTHER WORKTREES" : "WORKTREES", others.length)); for (const w of others) body.appendChild(renderWorktreeRow(w)); }
    return body;
  }

  function renderWorktreeRow(w) {
    const row = div("chg-wt-row");
    row.appendChild(div("chg-wt-glyph", w.worker ? (w.worker.provider || "◆").slice(0, 1).toUpperCase() : "⑂"));
    const mid = div("chg-wt-mid");
    mid.appendChild(div("chg-wt-title", worktreeTitle(w)));
    mid.appendChild(div("chg-wt-detail", worktreeDetail(w)));
    row.appendChild(mid);
    const track = div("chg-track");
    if (w.ahead > 0) track.appendChild(span("up", "↑" + w.ahead));
    if (w.behind > 0) track.appendChild(span("down", "↓" + w.behind));
    if (w.changed > 0) track.appendChild(span("chg-dels", w.changed + " changed"));
    row.appendChild(track);
    row.title = w.path || "";
    row.onclick = () => openWorktree(w);
    return row;
  }

  // ---- notices, toast, sheet ----------------------------------------------
  function renderNotice() {
    const n = state.notice;
    const box = div("chg-notice");
    box.appendChild(div("chg-notice-title", n.title || ""));
    if (n.message) box.appendChild(div("", n.message));
    if (n.url) {
      const a = document.createElement("a");
      a.className = "chg-notice-link"; a.href = n.url; a.textContent = `View on ${n.site || "the git host"}`;
      a.target = "_blank"; a.rel = "noopener";
      box.appendChild(a);
    }
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Dismiss", "chg-btn stage", () => { state.notice = null; render(); }));
    box.appendChild(actions);
    return box;
  }

  function renderToast() {
    const t = div("chg-toast");
    t.appendChild(span("", state.copyToast));
    return t;
  }

  function sheetField(label, key, value, multiline, placeholder) {
    const wrap = div("chg-field");
    const l = document.createElement("label"); l.textContent = label; wrap.appendChild(l);
    const input = document.createElement(multiline ? "textarea" : "input");
    input.dataset.key = key; input.value = value || ""; input.placeholder = placeholder || "";
    if (multiline) input.rows = 3;
    wrap.appendChild(input);
    return wrap;
  }

  function submitPr(card, draft) {
    const fields = { title: "", body: "", base: "", head: (state.sheet && state.sheet.head) || "" };
    for (const el of card.querySelectorAll("[data-key]")) fields[el.dataset.key] = el.value;
    doPullRequest(draft, fields);
  }

  function renderBranchSheet(sheet) {
    const s = state.sheet;
    const card = div("chg-sheet-card");
    card.appendChild(div("chg-sheet-h", s.startPoint ? `New branch from ${s.startPoint}` : "New branch"));
    const field = sheetField("Branch name", "name", s.name, false, "feature/name");
    const input = field.querySelector("input");
    const problem = div("chg-error", s.error || "");
    const create = button(state.busy === "checkout" ? "Creating…" : "Create and switch", "chg-btn commit", () => submit());
    const check = () => {
      s.name = input.value.trim();
      const why = s.name ? branchProblem(s.name) : "";
      problem.textContent = why || s.error || "";
      create.disabled = !s.name || !!why || !!state.busy;
    };
    const submit = () => { check(); if (!create.disabled) { s.error = ""; checkout({ branch: s.name, create: true, startPoint: s.startPoint || undefined }); } };
    input.addEventListener("input", () => { s.error = ""; check(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { state.sheet = null; render(); } });
    card.appendChild(field);
    card.appendChild(problem);
    card.appendChild(div("chg-log-meta", s.startPoint ? `Starts at ${s.startPoint}${s.startPoint.includes("/") && !(state.branches?.local || []).some((b) => b.name === s.startPoint) ? " and tracks it" : ""}.`
      : "Starts at the current commit. Uncommitted changes come along."));
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Cancel", "chg-btn stage", () => { state.sheet = null; render(); }));
    actions.appendChild(create);
    card.appendChild(actions);
    sheet.appendChild(card);
    check();
    return sheet;
  }

  function renderSheet() {
    const s = state.sheet;
    if (s.kind === "branch") {
      const sheet = div("chg-sheet");
      sheet.onclick = (e) => { if (e.target === sheet) { state.sheet = null; render(); } };
      return renderBranchSheet(sheet);
    }
    const sheet = div("chg-sheet");
    sheet.onclick = (e) => { if (e.target === sheet) { state.sheet = null; render(); } };
    const card = div("chg-sheet-card");
    const t = terms();
    card.appendChild(div("chg-sheet-h", `Open a ${t.long}`));
    card.appendChild(sheetField("Title", "title", s.title, false, "Derived from the commits"));
    card.appendChild(sheetField("Body", "body", s.body, true, "Derived from the commits"));
    card.appendChild(sheetField("Base", "base", s.base, false, "Default branch"));
    card.appendChild(div("chg-log-meta", `The computer opens this on ${t.name}, titled from the commits.`));
    const actions = div("chg-sheet-actions");
    actions.appendChild(button("Cancel", "chg-btn stage", () => { state.sheet = null; render(); }));
    actions.appendChild(button("Open as draft", "chg-btn stage", () => submitPr(card, true)));
    actions.appendChild(button(state.busy === "pr" ? "Opening…" : `Open ${t.long}`, "chg-btn commit", () => submitPr(card, false)));
    card.appendChild(actions);
    sheet.appendChild(card);
    return sheet;
  }

  // ---- lifecycle -----------------------------------------------------------
  function startTimer() { timer = setInterval(() => { if (canPoll()) refresh(); }, 10000); }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  // A diff tab staged a hunk or a file: re-read this pane when it is the same session.
  const onGitChanged = (e) => {
    if (Date.now() - announcedAt < 1000) return;
    if (e.detail?.computer === computer && e.detail?.session === target?.session && !state.busy) refresh();
  };
  window.addEventListener("phren:git-changed", onGitChanged);

  startTimer();
  refresh();

  return {
    refresh,
    close() { visible = false; stopTimer(); window.removeEventListener("phren:git-changed", onGitChanged); el.innerHTML = ""; },
  };
}

function injectStyle() {
  if (document.getElementById("changes-style")) return;
  const style = document.createElement("style");
  style.id = "changes-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---- helpers ---------------------------------------------------------------
/** A small mark for the remote's host: GitHub's pull-request glyph, GitLab's
 * fox, gitboy's handheld, or a neutral branch for an unknown host. */
function hostMark(kind, size = 18) {
  const paths = {
    github: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M6 8.4v7.2M18 15.6V10a3 3 0 0 0-3-3h-4m0 0 2.5-2.5M11 7l2.5 2.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    gitlab: '<path d="M12 21.2 3.3 13.6l1.6-7.9 2.6 6.1h9l2.6-6.1 1.6 7.9z" stroke="none"/>',
    gitboy: '<rect x="5" y="2.5" width="14" height="19" rx="3" fill="none" stroke-width="1.8"/><rect x="8" y="5.5" width="8" height="6" rx="1" stroke="none"/><path d="M9 15v4M7 17h4" fill="none" stroke-width="1.6" stroke-linecap="round"/><circle cx="15.5" cy="16" r="1.1" stroke="none"/><circle cx="17" cy="18.4" r="1.1" stroke="none"/>',
  };
  const mark = document.createElement("span");
  mark.className = "chg-mark " + (kind || "none");
  mark.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="currentColor" stroke="currentColor">${paths[kind] || '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3-11 6" fill="none" stroke-width="1.7"/>'}</svg>`;
  return mark;
}

function div(cls, text) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  if (text != null) s.textContent = text;
  return s;
}
function button(label, cls, onclick) {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.textContent = label;
  if (onclick) b.onclick = onclick;
  return b;
}
function icon(glyph, title, onclick) {
  const b = button(glyph, "chg-icon");
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

function basename(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function dirname(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function tileClass(status) {
  if (status === "M" || status === "A" || status === "D" || status === "R") return status;
  return "Q";
}

function hunkHeader(hunk) {
  if (typeof hunk.header === "string") return hunk.header;
  if (typeof hunk.heading === "string") return hunk.heading;
  if (typeof hunk.raw === "string") return hunk.raw;
  if (hunk.oldStart != null) return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return "";
}

function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + "mo";
  return Math.floor(mo / 12) + "y";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- publish plan (pure, unit tested) --------------------------------------
export function isDefaultBranch(status) {
  return !!status.defaultBranch && status.branch === status.defaultBranch;
}

/** Which publish actions the working tree allows, matching the phone. */
export function planPublish(status, current) {
  const plan = { stageAll: 0, commit: false, push: null, pull: null };
  const unstagedPaths = new Set((status.files || []).filter((f) => !f.staged).map((f) => f.path)).size;
  const hasStaged = (status.files || []).some((f) => f.staged);
  if (hasStaged) plan.commit = true; else plan.stageAll = unstagedPaths;
  const branch = status.branch;
  if (branch) {
    if (!status.upstream) plan.push = "Push branch";
    else if (status.ahead > 0) plan.push = "Push " + status.ahead;
    if (current && current.head === branch) plan.pull = { existing: current.number, url: current.url, checks: current.checks };
    else if (!isDefaultBranch(status) && status.upstream && status.ahead === 0) plan.pull = { open: true };
  }
  plan.isEmpty = plan.stageAll === 0 && !plan.commit && !plan.push && !plan.pull;
  return plan;
}

/** Why Push is disabled, or "" when it is possible. */
export function pushReason(status) {
  if (!status) return "";
  if (!status.branch) return "HEAD is detached.";
  if (status.upstream && status.ahead === 0) return "Nothing to push.";
  return "";
}

/** Why the pull request action is disabled, or "" when it is possible.
 * `term` is the host's word for it ("merge request" on GitLab). */
export function prReason(status, term = "pull request") {
  if (!status || !status.branch) return `No branch to open a ${term} from.`;
  if (isDefaultBranch(status)) return "This is the default branch.";
  if (!status.upstream) return "Push the branch first.";
  if (status.ahead > 0) return "Push " + status.ahead + " commit" + (status.ahead === 1 ? "" : "s") + " first.";
  return "";
}

