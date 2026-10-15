// Shared, pure hand-off decisions and overview labels.
const harnessName = (source) => ({ claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot" })[source] ?? source ?? "agent";

export function movePlan(current, to, moveNewChat) {
  if (!to?.harness) return { label: "Choose where to continue" };
  const name = harnessName(to.harness);
  if (current === to.harness) return { label: `Continues here on ${to.accountLabel || to.account || name}` };
  return moveNewChat === true
    ? { mode: "new-chat", label: `Opens a new ${name} chat with a hand-off` }
    : { label: `Replaces this chat with ${name} (update the Hook for a new chat)` };
}

export function sameChatTarget(a, b) {
  return Boolean(a?.session && b?.session) && ["server", "workspace", "tab", "pane", "source", "session"].every((key) => a[key] === b[key]);
}

/** Links are resolved by the exact Hook target, never a title or a checkout. */
export function handoffNotices(child, rows = []) {
  return [["to", child.handedOffTo], ["from", child.handedOffFrom]].flatMap(([direction, ref]) => {
    if (!ref || typeof ref !== "object") return [];
    const target = ref.target ?? ref;
    const related = rows.find((row) => sameChatTarget(row.child.target, target));
    const text = direction === "to"
      ? `handed off to ${harnessName(ref.harness ?? target.source ?? related?.child.agent)}`
      : `handed off from ${ref.title || related?.child.title || related?.child.label || harnessName(target.source)}`;
    return [{ text, target: target.session ? target : null }];
  });
}
