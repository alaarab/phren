// Pure helpers of the Changes pane: small DOM builders, path and time words,
// the host mark, and the publish plan (unit tested in src/changes.test.ts).
/** A small mark for the remote's host: GitHub's pull-request glyph, GitLab's
 * fox, gitboy's handheld, or a neutral branch for an unknown host. */
export function hostMark(kind, size = 18) {
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

export function div(cls, text) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}
export function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  if (text != null) s.textContent = text;
  return s;
}
export function button(label, cls, onclick) {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.textContent = label;
  if (onclick) b.onclick = onclick;
  return b;
}
export function icon(glyph, title, onclick) {
  const b = button(glyph, "chg-icon");
  b.title = title;
  b.onclick = (e) => { e.stopPropagation(); onclick(); };
  return b;
}

export function basename(p) { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
export function dirname(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
export function tileClass(status) {
  if (status === "M" || status === "A" || status === "D" || status === "R") return status;
  return "Q";
}

export function hunkHeader(hunk) {
  if (typeof hunk.header === "string") return hunk.header;
  if (typeof hunk.heading === "string") return hunk.heading;
  if (typeof hunk.raw === "string") return hunk.raw;
  if (hunk.oldStart != null) return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return "";
}

export function relTime(iso) {
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

export function escapeHtml(text) {
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

/** The Hook's staging gates, applied to the exact unstaged selection. The
 * Hook checks again on write because the working tree can change meanwhile. */
export function stagePlan(files, status) {
  const selected = files.filter((file) => !file.staged);
  const paths = [...new Set(selected.map((file) => file.path))];
  const directories = paths.filter((path) => selected.some((file) => file.path === path && (file.directory || path.endsWith("/"))));
  const binary = paths.filter((path) => selected.some((file) => file.path === path && file.status === "?" && file.binary));
  const unknown = paths.filter((path) => !directories.includes(path) && !binary.includes(path)
    && selected.some((file) => file.path === path && file.status === "?" && file.countsComplete !== true));
  const manifest = paths.map((path) => {
    const file = selected.find((file) => file.path === path);
    return { path, type: directories.includes(path) ? "dir" : file.status === "D" ? "deleted" : file.binary ? "binary" : "file",
      untracked: file.status === "?", countsComplete: file.countsComplete === true };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const omitted = Math.max(0, (status?.totalFiles || 0) - new Set((status?.files || []).map((file) => file.path)).size);
  return {
    paths, directories, binary, unknown, manifest,
    confirm: paths.length > 100 || directories.length > 0 || binary.length > 0 || unknown.length > 0,
    error: status?.truncated ? `The listing is truncated (${omitted ? omitted + " more file" + (omitted === 1 ? "" : "s") + (omitted === 1 ? " exists" : " exist") : "more changes exist"}). Stage smaller selections first; this partial listing cannot be confirmed.` : paths.length > 500 ? `Choose at most 500 paths to stage at once (${paths.length} selected). Stage smaller selections first.` : "",
  };
}
