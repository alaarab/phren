/** The word a return or worker state shows, and its chip class. */
export function stateChip(state) {
  switch (String(state)) {
    case "done": return { label: "done", cls: "done" };
    case "needs-you": return { label: "needs you", cls: "needs" };
    case "blocked": return { label: "blocked", cls: "needs" };
    case "stalled": return { label: "stalled", cls: "needs" };
    case "failed": return { label: "failed", cls: "failed" };
    case "gone": return { label: "gone", cls: "gone" };
    case "working": return { label: "working", cls: "working" };
    case "launching": return { label: "launching", cls: "working" };
    case "sending": return { label: "sending", cls: "working" };
    case "accepted": return { label: "accepted", cls: "working" };
    case "uncertain": return { label: "uncertain", cls: "needs" };
    case "idle": return { label: "idle", cls: "" };
    case "closed": return { label: "closed", cls: "gone" };
    default: return { label: String(state ?? "unknown"), cls: "" };
  }
}

