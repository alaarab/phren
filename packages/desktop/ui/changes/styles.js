// The Changes pane's styles, injected once by changes.js (injectStyle).
export const CHANGES_CSS = `
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
.chg-merge-later{width:100%;margin-top:8px}
.chg-merge-armed{flex:1;font-size:12.5px;color:var(--text)}
.chg-merge-ask{margin-bottom:8px;font-size:12.5px;color:var(--text)}
.chg-btn.merge{background:var(--raised);color:var(--text)}
.chg-btn.merge.ready{background:var(--done);color:var(--bg);box-shadow:0 0 0 0 rgba(138,200,172,.5);animation:chg-ready 2.4s ease-out infinite}
@keyframes chg-ready{0%{box-shadow:0 0 0 0 rgba(138,200,172,.45)}70%{box-shadow:0 0 0 8px rgba(138,200,172,0)}100%{box-shadow:0 0 0 0 rgba(138,200,172,0)}}
.chg-knows{margin-top:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);overflow:hidden}
.chg-knows-h{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;padding:9px 10px;color:var(--text);font:600 12.5px system-ui,sans-serif;cursor:pointer;text-align:left}
.chg-knows-h:hover{background:var(--raised)}
.chg-knows-mark{flex:none;color:var(--accent);font-size:11px}
.chg-knows-sub{flex:1;min-width:0;color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-knows-chev{flex:none;color:var(--muted);transition:transform .18s ease}
.chg-knows.open .chg-knows-chev{transform:rotate(90deg)}
.chg-knows-filter{display:flex;align-items:center;gap:6px;padding:0 10px 6px;font-size:12px;color:var(--muted)}
.chg-knows-list{border-top:1px solid var(--border)}
.chg-knows-item{padding:8px 10px;border-top:1px solid var(--border);cursor:pointer}
.chg-knows-item:first-child{border-top:none}
.chg-knows-item:hover{background:var(--raised)}
.chg-knows-text{color:var(--text-2);font-size:12.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chg-knows-item.full .chg-knows-text{display:block}
.chg-knows-meta{display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap}
.chg-knows-cite{border:none;background:var(--raised);color:var(--link);font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:11px;border-radius:999px;padding:1px 7px;cursor:pointer}
.chg-knows-cite:hover{color:var(--accent)}
.chg-knows-badge{flex:none;border:none;background:rgba(138,170,220,.14);color:var(--accent);font:600 11px system-ui,sans-serif;border-radius:999px;padding:2px 7px;cursor:pointer}
.chg-knows-badge:hover{background:var(--raised)}
@media (prefers-reduced-motion:reduce){.chg-knows-chev{transition:none}}
.chg-fixit{display:flex;align-items:center;gap:10px;margin:8px 0 0}
.chg-fixit .chg-btn{flex:none}
.chg-fixit-sub{min-width:0;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chg-seen{margin:8px 0 0;border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden}
.chg-seen-h{display:flex;align-items:center;gap:8px;padding:7px 10px;color:var(--text);font:600 12.5px system-ui,sans-serif}
.chg-seen-item{padding:8px 10px;border-top:1px solid var(--border)}
@media (prefers-reduced-motion:reduce){.chg-req.pending::before,.chg-pipe-seg.pending,.chg-check-state.pending::before,.chg-btn.merge.ready{animation:none}}
`;
