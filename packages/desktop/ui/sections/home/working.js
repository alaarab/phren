import { el } from "../../dom.js";
import { needsYou, sessions } from "../../shell/store.js";
import { backgroundLabel, stalledMinutes } from "../../shell/stalls.js";

export function renderWorking({ state, fill, sessionRow }) {
  const needKeys = new Set(needsYou(state.merged).map((r) => r.key));
  const rows = sessions(state.merged).filter((r) => r.child.agentStatus === "working" && !needKeys.has(r.key));
  fill("working", rows.map((row) => {
    // The overview's current step is the agent's activity verb ("Editing server.ts").
    // A turn that ended with work still running says so instead.
    const activity = row.child.currentStep || row.child.activity || row.child.activityVerb || backgroundLabel(row.child);
    const sub = activity ? el("span", "home-row-sub activity", String(activity)) : undefined;
    return sessionRow(row, { tone: stalledMinutes(row.child) !== null ? "stalled" : "working", sub });
  }), "No agent is working.");
}
