// What a project did today (the local day), for the "Today" block on its page. Pure: the page hands in
// what it already loaded (the overview's sessions, the git host's pull requests, the project's findings).
import { dayBounds, savedToday } from "./saved-today.js";

export const TODAY_ROWS = 5;

const trimSlash = (p) => String(p ?? "").replace(/\/+$/, "");
const lastSegment = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

/** Whether `cwd` is the checkout itself or inside it (a subfolder or a worktree under it); never a same-named folder elsewhere. */
export function insideCheckout(cwd, checkout) {
  const dir = trimSlash(checkout);
  const at = trimSlash(cwd);
  return !!dir && !!at && (at === dir || at.startsWith(`${dir}/`));
}

/**
 * The overview sessions that belong to a project, on any computer that has it. `rows` are `{ computer, child }`;
 * `checkouts` maps a computer to the project's known checkout paths there (its repo directory, the git host
 * data's directory, listed worktrees). A computer with the project but no known path falls back to the folder
 * name (the cwd's last segment, never the label); a computer without the project has none.
 */
export function sessionsForProject(rows, { name, checkouts }) {
  return rows.filter((row) => {
    const paths = checkouts.get(row.computer);
    const cwd = row.child?.cwd;
    if (!paths || !cwd) return false;
    if (paths.length) return paths.some((dir) => insideCheckout(cwd, dir));
    return lastSegment(cwd) === name;
  });
}

const inDay = (iso, [start, end]) => {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) && at >= start && at < end ? at : null;
};

/**
 * `sessions`: `{ computer, child }` rows already filtered to the project. `pulls`: the host's pull request
 * list plus the checkout's own `current` request; the host reports only an `updated` instant, so a request
 * counts as today's when it was updated today, and is "merged" when its state says so.
 * `findings`: `{ id, text, created }` as the Hook returns them. Each group is newest first.
 */
export function todayGroups({ sessions = [], pulls = [], current = null, findings = [], computer = "", project = "" }, now = Date.now()) {
  const bounds = dayBounds(now);
  const chats = sessions
    .map((row) => ({ row, at: inDay(row.child?.lastChangedAt, bounds) }))
    .filter((x) => x.at !== null)
    .sort((a, b) => b.at - a.at)
    .map(({ row, at }) => ({ key: `chat:${row.computer}:${row.child.id}`, row, at }));

  const seen = new Set();
  const prs = [];
  for (const pull of [current, ...pulls]) {
    if (!pull || pull.number === undefined || pull.number === null || seen.has(pull.number)) continue;
    // The checkout's own request may lack `updated`; the open list then speaks for it, so only a counted one is seen.
    const at = inDay(pull.updated, bounds);
    if (at === null) continue;
    seen.add(pull.number);
    const state = String(pull.state ?? "OPEN").toUpperCase();
    prs.push({ key: `pr:${pull.number}`, pull, at, merged: state === "MERGED", failing: pull.checks === "failing" });
  }
  prs.sort((a, b) => b.at - a.at);

  const memory = savedToday(
    findings.filter((f) => f && f.id).map((f) => ({
      kind: "finding", key: `finding:${f.id}`, dedupe: `finding|${f.id}`, created: f.created, id: String(f.id),
      text: String(f.text ?? "").replace(/\s+/g, " ").trim(), computer, project,
    })),
    now,
  );
  return { chats, prs, memory, total: chats.length + prs.length + memory.length };
}
