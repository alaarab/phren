// Pure helpers behind the git review surfaces: hunks cut from a patch for
// staging one at a time, which file versions a diff compares, the one sync
// action a branch needs, branch-name rules and the checks summary. No DOM, so
// src/git-review.test.ts covers them directly.

/** A patch split into its file header (everything before the first `@@`)
 * and its hunks, each with the ranges from its `@@` line. */
export function splitHunks(patch) {
  const text = String(patch || "");
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]), oldLines: match[2] == null ? 1 : Number(match[2]),
        newStart: Number(match[3]), newLines: match[4] == null ? 1 : Number(match[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current) current.lines.push(line);
    else header.push(line);
  }
  for (const hunk of hunks) {
    hunk.added = hunk.lines.filter((l) => l.startsWith("+")).length;
    hunk.removed = hunk.lines.filter((l) => l.startsWith("-")).length;
  }
  return { header: header.join("\n"), hunks };
}

/** One hunk as a patch Git can apply on its own: the file header, then it. */
export function hunkPatch(header, hunk) {
  return [header, hunk.header, ...hunk.lines].filter((part, i) => i > 0 || part).join("\n") + "\n";
}

/** The hunk that covers `line` on one side (`new` or `old`); a line between
 * hunks picks the next one, past the last the last. */
export function hunkAt(hunks, line, side = "new") {
  if (!hunks.length) return -1;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const start = side === "old" ? h.oldStart : h.newStart;
    const count = side === "old" ? h.oldLines : h.newLines;
    if (line < start) return i;
    if (line <= start + Math.max(count, 1) - 1) return i;
  }
  return hunks.length - 1;
}

/** Which two versions a diff tab compares. `mode` is `all` (HEAD to the
 * working file), `unstaged` (index to working file) or `staged` (HEAD to
 * index); a commit compares its parent with itself. `null` is the working
 * file on disk. */
export function diffSides(mode, commit) {
  if (commit) return { original: commit.parent || null, modified: commit.sha, originalPath: commit.oldPath, readOnly: true };
  if (mode === "unstaged") return { original: "INDEX", modified: null };
  if (mode === "staged") return { original: "HEAD", modified: "INDEX" };
  return { original: "HEAD", modified: null };
}

/** The modes worth offering for a file's sections, and the one to start on. */
export function diffModes(sections) {
  const kinds = new Set((sections || []).filter((s) => s && s.patch).map((s) => s.kind));
  const staged = kinds.has("staged"), unstaged = kinds.has("unstaged");
  if (staged && unstaged) return { modes: ["all", "unstaged", "staged"], initial: "unstaged" };
  if (staged) return { modes: ["staged"], initial: "staged" };
  return { modes: ["unstaged"], initial: "unstaged" };
}

/** What the branch bar's one sync button does: pull when behind (and on a
 * branch with an upstream), otherwise fetch when there is a remote to ask. */
export function syncAction(status) {
  if (!status || !status.branch) return null;
  if (status.upstream && status.behind > 0) return { kind: "pull", label: `Pull ${status.behind}` };
  return { kind: "fetch", label: "Fetch" };
}

/** "↑2 ↓1", "not pushed", or "" when even with its upstream. */
export function trackingText(status) {
  if (!status || !status.branch) return "";
  if (!status.upstream) return "not pushed";
  const parts = [];
  if (status.ahead > 0) parts.push("↑" + status.ahead);
  if (status.behind > 0) parts.push("↓" + status.behind);
  return parts.join(" ");
}

/** Why `name` cannot be a branch (Git's check-ref-format rules), or "". */
export function branchProblem(name) {
  if (!name) return "Enter a branch name.";
  if (name.length > 250) return "The branch name is too long.";
  if (name.startsWith("-")) return "A branch name cannot start with a dash.";
  if (name === "@" || name === "HEAD") return `${name} is reserved by Git.`;
  if (/[\x00-\x20\x7f]/.test(name)) return "A branch name cannot contain spaces.";
  for (const bad of ["~", "^", ":", "?", "*", "[", "\\"]) if (name.includes(bad)) return `A branch name cannot contain ${bad}.`;
  if (name.includes("..")) return "A branch name cannot contain two dots in a row.";
  if (name.includes("@{")) return "A branch name cannot contain @{.";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return "Slashes must separate words.";
  if (name.endsWith(".")) return "A branch name cannot end with a dot.";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "No part of a branch name can start with a dot.";
    if (part.endsWith(".lock")) return "No part of a branch name can end with .lock.";
  }
  return "";
}

/** The local name for a remote-tracking branch: `origin/feat/x` → `feat/x`. */
export function localForRemote(name, remotes = ["origin"]) {
  for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
    if (name.startsWith(remote + "/")) return name.slice(remote.length + 1);
  }
  const slash = name.indexOf("/");
  return slash < 0 ? name : name.slice(slash + 1);
}

/** "2 failing · 1 pending · 9 passing" from a pull request's check runs. */
export function checksSummary(runs) {
  const counts = { failing: 0, pending: 0, passing: 0, skipped: 0, neutral: 0 };
  for (const run of runs || []) if (run && counts[run.state] != null) counts[run.state]++;
  return ["failing", "pending", "passing", "skipped"].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(" · ");
}

/** The review decision and merge state as one short line, or "". */
export function pullStanding(pull) {
  if (!pull) return "";
  const review = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" }[pull.reviewDecision] || "";
  const merge = { CLEAN: "Ready to merge", BLOCKED: "Merge blocked", BEHIND: "Behind its base", DIRTY: "Has conflicts", UNSTABLE: "Checks unstable", DRAFT: "Draft", HAS_HOOKS: "Ready to merge" }[pull.mergeState] || "";
  return [review, merge].filter(Boolean).join(" · ");
}

/** Line changes as Monaco reports them, counted like a patch: added lines on
 * the modified side, removed lines on the original. */
export function lineChangeTotals(changes) {
  let added = 0, removed = 0;
  for (const c of changes || []) {
    if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
  }
  return { added, removed };
}

/** The change to move to from `line`: the next one starting below it (or the
 * previous one above), wrapping at the ends. -1 with no changes. */
export function stepChange(changes, line, delta) {
  if (!changes || !changes.length) return -1;
  const start = (c) => Math.max(1, c.modifiedStartLineNumber || c.modifiedEndLineNumber || 1);
  if (delta > 0) {
    const i = changes.findIndex((c) => start(c) > line);
    return i < 0 ? 0 : i;
  }
  for (let i = changes.length - 1; i >= 0; i--) if (start(changes[i]) < line) return i;
  return changes.length - 1;
}

/** How the remote's host names its requests, from the Hook's `host` answer:
 * GitHub and gitboy say pull request (#42), GitLab merge request (!42). An
 * unknown or not yet loaded host reads as a generic "pull request" on "the
 * git host", never as any one product. */
export function hostTerms(host) {
  const terms = host && host.terms ? host.terms : {};
  return {
    short: terms.short || "PR",
    long: terms.long || "pull request",
    ref: terms.ref || "#",
    name: (host && host.kind && host.name) || "the git host",
    supported: !!(host && host.supported),
  };
}

/** "Pull request" → sentence case for titles. */
export function capitalize(text) { return text ? text[0].toUpperCase() + text.slice(1) : text; }

const RUN_ORDER = { failing: 0, pending: 1, passing: 2, neutral: 3, skipped: 4 };

/** The pipeline bar: one segment per state that has runs, failing first,
 * each with its share of the bar. */
export function pipelineSegments(runs) {
  const counts = {};
  for (const run of runs || []) if (run && RUN_ORDER[run.state] != null) counts[run.state] = (counts[run.state] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return Object.keys(RUN_ORDER).filter((state) => counts[state]).map((state) => ({ state, count: counts[state], share: counts[state] / total }));
}

/** Checks grouped by stage or workflow, the group with the worst run first
 * and runs failing first inside each; runs without one share an unnamed group. */
export function groupRuns(runs) {
  const groups = new Map();
  for (const run of runs || []) {
    const key = run.workflow || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const worst = (list) => Math.min(...list.map((run) => RUN_ORDER[run.state] ?? 9));
  return [...groups.entries()]
    .map(([name, list]) => ({ name, runs: [...list].sort((a, b) => (RUN_ORDER[a.state] ?? 9) - (RUN_ORDER[b.state] ?? 9)) }))
    .sort((a, b) => worst(a.runs) - worst(b.runs));
}

/** The merge methods a host lets a client choose. GitLab merges or rebases by
 * the project's own setting, so it offers merge and squash. */
export function mergeMethods(host) {
  const kind = host && host.kind;
  if (kind === "gitlab") return [["merge", "Merge"], ["squash", "Squash and merge"]];
  return [["merge", "Create a merge commit"], ["squash", "Squash and merge"], ["rebase", "Rebase and merge"]];
}

/** Whether a Merge button belongs on the request, and why not when it doesn't.
 * The host has the final say; this only hides it where merging can't apply. */
export function mergeAvailability(pull) {
  if (!pull) return { show: false };
  if (pull.state && pull.state !== "OPEN") return { show: false };
  if (pull.draft || pull.mergeState === "DRAFT") return { show: true, enabled: false, why: "Mark it ready first" };
  if (pull.mergeState === "DIRTY") return { show: true, enabled: false, why: "Resolve the conflicts first" };
  return { show: true, enabled: true, ready: pull.mergeState === "CLEAN" && pull.checks !== "failing" && pull.checks !== "pending" };
}

/** Where to make a token for Connect, on the remote's own domain. */
export function tokenPage(host) {
  if (!host || !host.domain) return null;
  if (host.kind === "gitlab") return `https://${host.domain}/-/user_settings/personal_access_tokens?name=Phren%20Hook&scopes=api`;
  if (host.kind === "gitboy") return `https://${host.domain}/settings/tokens`;
  return null;
}

/** "1m 30s", "45s", "2h 5m" for a run's duration; "" without one. */
export function durationText(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)}m` : ""}`;
}

/** "just now", "5m ago", "3h ago", "2d ago" from an ISO time; "" without one. */
export function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
