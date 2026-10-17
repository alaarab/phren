// Plain-words reading of one standing approval rule (the Hook's `GET /v1/approval-rules`).
// Rules only ever restrict: effect "always-ask" or "deny" on a Bash command, never an allow.
import { age, shortDate } from "../../time.js";

const HARNESS = { claude: "Claude", codex: "Codex", copilot: "Copilot", opencode: "OpenCode", phren: "The Phren agent" };

function commandWords(rule) {
  const cmd = `\`${rule.command}\``;
  if (rule.match === "prefix") return `commands starting with ${cmd}`;
  if (rule.match === "glob") return `commands matching ${cmd}`;
  return cmd;
}

/** "Claude must ask before running `pnpm test` in phren." / "... may not run ..." */
export function ruleSentence(rule) {
  const scope = rule.scope ?? {};
  const who = HARNESS[scope.harness] ?? "Any agent";
  const where = rule.projectName || scope.project;
  const tail = [where ? `in ${where}` : "", scope.session ? "in one session" : "", scope.computer ? `on ${scope.computer}` : ""].filter(Boolean).join(" ");
  const verb = rule.effect === "deny" ? "may not run" : "must ask before running";
  const tool = rule.tool && rule.tool !== "Bash" ? ` (${rule.tool})` : "";
  return `${who} ${verb} ${commandWords(rule)}${tool}${tail ? " " + tail : ""}.`;
}

/** "Project /path · Claude only · Session abc": the scope fields as the Hook stores them. */
export function ruleScope(rule) {
  const scope = rule.scope ?? {};
  const only = scope.harness === "phren" ? "Phren agent only" : HARNESS[scope.harness] ? `${HARNESS[scope.harness]} only` : "Any agent";
  return [scope.project ? `Project ${scope.project}` : "", only,
    scope.session ? `Session ${scope.session}` : "", scope.computer ? `Computer ${scope.computer}` : ""].filter(Boolean).join(" · ");
}

export function ruleStatus(rule, now = Date.now()) {
  if (rule.enabled === false) return "Off";
  if (rule.until && Date.parse(rule.until) <= now) return "Expired";
  return "On";
}

/** "Added Oct 7 (3d ago) · Expires Oct 20" / "· No expiry" / "· Expired Oct 9". */
export function ruleDates(rule, now = Date.now()) {
  const ago = age(rule.createdAt, " ago", now);
  const added = rule.createdAt ? `Added ${shortDate(rule.createdAt)}${ago ? ` (${ago})` : ""}` : "";
  const end = !rule.until ? "No expiry" : `${Date.parse(rule.until) <= now ? "Expired" : "Expires"} ${shortDate(rule.until)}`;
  return [added, end].filter(Boolean).join(" · ");
}
