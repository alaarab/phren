// Branch tasks: the project's open Phren tasks that name a branch or the issue
// number in it, from the Hook's /v1/projects/:project/tasks?branch= (gitboy's
// pull request card). Done completes one by its stable id. Used by Changes ›
// PRs for the current request and by the project page's Code block.
import { hookGet, hookPost } from "./api.js";

const CSS = `
.bt{margin:8px 0 0;border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden}
.bt-h{display:flex;align-items:center;gap:8px;padding:7px 10px;color:var(--text);font:600 12.5px system-ui,sans-serif}
.bt-mark{flex:none;color:var(--accent);font-size:11px}
.bt-sub{flex:1;min-width:0;color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-item{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-top:1px solid var(--border)}
.bt-item.done{opacity:.55}
.bt-item.done .bt-text{text-decoration:line-through}
.bt-text{flex:1;min-width:0;color:var(--text-2);font-size:12.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-tag{flex:none;margin-top:1px;border-radius:999px;padding:1px 7px;background:var(--raised);color:var(--muted);font:11px "JetBrains Mono",ui-monospace,Menlo,monospace}
.bt-tag.active{color:var(--accent)}
.bt-done{flex:none;border:1px solid var(--border);background:transparent;color:var(--text-2);border-radius:999px;padding:1px 9px;font:500 11.5px system-ui,sans-serif;cursor:pointer}
.bt-done:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.bt-done:disabled{cursor:default}
.bt-error{padding:0 10px 7px;color:var(--danger);font-size:12px}
`;

/** Open tasks naming this branch, or null when the Hook has no such route
 *  (older Hook, project outside the store). */
export async function loadBranchTasks(computer, project, branch) {
  if (!project || !branch) return null;
  try {
    const body = await hookGet(computer, `/v1/projects/${encodeURIComponent(project)}/tasks`, { branch });
    return Array.isArray(body?.tasks) ? body.tasks : null;
  } catch { return null; }
}

/** Mark one task done; "completed" or "already-done", else throws. */
export async function completeBranchTask(computer, project, id) {
  const body = await hookPost(computer, `/v1/projects/${encodeURIComponent(project)}/tasks/complete`, { id });
  return body?.status;
}

/** The card. `state` is { tasks, done: Set of ids, busy: id|null, error } and
 *  is kept by the caller; `rerender` redraws after a change. */
export function renderBranchTasks({ computer, project, branch, state, rerender }) {
  injectStyle();
  const box = document.createElement("div");
  box.className = "bt";
  const head = document.createElement("div");
  head.className = "bt-h";
  head.append(span("bt-mark", "◆"), span("", `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"} for this branch`), span("bt-sub", branch));
  box.append(head);
  for (const task of state.tasks) {
    const finished = state.done.has(task.id);
    const row = document.createElement("div");
    row.className = "bt-item" + (finished ? " done" : "");
    row.dataset.id = task.id;
    const text = span("bt-text", task.text || "");
    if (task.context) text.title = task.context;
    row.append(span("bt-tag" + (task.section === "active" ? " active" : ""), task.match === "issue" ? "issue" : task.section || "open"), text);
    const done = document.createElement("button");
    done.type = "button";
    done.className = "bt-done";
    done.textContent = finished ? "Done ✓" : state.busy === task.id ? "Saving…" : "Done";
    done.disabled = finished || !!state.busy;
    done.title = "Mark this task done in Phren";
    done.onclick = async (e) => {
      e.stopPropagation();
      state.busy = task.id; state.error = ""; rerender();
      try { await completeBranchTask(computer, project, task.id); state.done.add(task.id); }
      catch (err) { state.error = err?.message || "Phren did not save that."; }
      finally { state.busy = null; rerender(); }
    };
    row.append(done);
    box.append(row);
  }
  if (state.error) box.append(Object.assign(document.createElement("div"), { className: "bt-error", textContent: state.error }));
  return box;
}

function span(cls, text) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function injectStyle() {
  if (document.getElementById("branch-tasks-style")) return;
  const style = document.createElement("style");
  style.id = "branch-tasks-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}
