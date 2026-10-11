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
