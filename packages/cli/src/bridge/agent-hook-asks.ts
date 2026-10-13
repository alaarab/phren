import { object, objects, type Json } from "./protocol.js";
import type { PendingServerRequest } from "./codex-app-server.js";

/** Pure translations between the harnesses' permission asks and the Hook's
 * approval cards (agent-hooks.ts holds and answers them). */

/** A conductor `dispatch` or `hand_off` ask, with the fields a standing grant matches on. */
export type ConductorCall = { action: "dispatch" | "hand_off"; project?: string; computer?: string };

/** The approval card's tool and input for an app-server request, in the
 * shapes `approvalSummary` and the phone already read for Codex's hook.
 * Undefined for questions (`item/tool/requestUserInput`) and MCP
 * elicitations, which stay in the pane. */
export function appServerApproval(request: PendingServerRequest): { tool: string; input: Json } | undefined {
  const params = request.params;
  const reason = typeof params.reason === "string" && params.reason ? { reason: params.reason } : {};
  if (request.method === "item/commandExecution/requestApproval") {
    return { tool: "Bash", input: { ...(typeof params.command === "string" ? { command: params.command } : {}),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}), ...reason } };
  }
  if (request.method === "item/fileChange/requestApproval") {
    const changes = objects(params.changes);
    const verb = (change: Json) => object(change.kind).type === "add" ? "Add" : object(change.kind).type === "delete" ? "Delete" : "Update";
    const patch = changes.filter(change => typeof change.path === "string").map(change => `*** ${verb(change)} File: ${change.path}`).join("\n");
    return { tool: "apply_patch", input: { ...(patch ? { patch } : {}), ...(typeof params.grantRoot === "string" ? { grantRoot: params.grantRoot } : {}), ...reason } };
  }
  if (request.method === "item/permissions/requestApproval") return { tool: "Permissions", input: { permissions: params.permissions ?? {}, ...reason } };
  return undefined;
}

/** The app-server's answer for the phone's allow or deny (T3's
 * CodexSessionRuntime shapes: accept / decline, a permission grant or none). */
export function appServerDecision(request: PendingServerRequest, allow: boolean): Json {
  if (request.method === "item/permissions/requestApproval") return { permissions: allow ? object(request.params.permissions) : {}, scope: "turn" };
  return { decision: allow ? "accept" : "decline" };
}

/** A conductor `dispatch` or `hand_off` permission ask the Hook can answer
 * itself under a standing grant, or offer the phone two grant-writing answers. */
export function conductorCall(tool: string, input: unknown): ConductorCall | undefined {
  // MCP tool names vary by harness: `dispatch`, `phren.dispatch`,
  // `mcp__phren__dispatch`; phren_admin carries the action in its fields.
  const tail = /(?:^|[.:/]|__)(dispatch|hand_off|phren_admin)$/.exec(tool.replace(/^mcp_phren_/, ""))?.[1];
  const fields = object(input);
  let action: "dispatch" | "hand_off" | undefined;
  if (tail === "dispatch") action = "dispatch";
  else if (tail === "hand_off") action = "hand_off";
  else if (tail === "phren_admin" && (fields.action === "dispatch" || fields.action === "hand_off")) action = fields.action;
  if (!action) return undefined;
  const project = typeof fields.project === "string" ? fields.project : undefined;
  const computer = typeof fields.computer === "string" ? fields.computer : undefined;
  return { action, ...(project ? { project } : {}), ...(computer ? { computer } : {}) };
}

/** The decisions an OpenCode permission ask offers the phone. OpenCode's
 * `always` covers the current session, so both grant answers reply `always`;
 * `allow-everywhere` additionally writes an allow rule into the user's
 * OpenCode config. Advertised as the approval card's `options`, the same
 * shape the phone already renders for a provider-supplied option list. */
export const OPENCODE_APPROVAL_OPTIONS: Json[] = [
  { label: "Allow once", decision: "approve" },
  { label: "Allow for this project", decision: "allow-project" },
  { label: "Allow everywhere", decision: "allow-everywhere" },
  { label: "Deny", decision: "deny" },
];

/** The OpenCode permission reply a card decision maps to: both grant scopes
 * are `always`, a plain approve is `once`, a deny is `reject`. Undefined for
 * anything else. */
export function opencodePermissionReply(decision: unknown): "once" | "always" | "reject" | undefined {
  if (decision === "approve") return "once";
  if (decision === "deny") return "reject";
  if (decision === "allow-project" || decision === "allow-everywhere") return "always";
  return undefined;
}
