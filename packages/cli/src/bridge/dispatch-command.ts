import { ownerInboxSchema } from "./owner-inbox.js";
import { prsSchema } from "./return-contract.js";
import { parseArgs } from "node:util";
import { hookRequest } from "./client.js";
import { dispatchSchema } from "./dispatch.js";
import { handOff, moveSession } from "./hand-off.js";
import { terminalPaneFromEnv } from "./terminal.js";
import { dispatchIdFromEnv } from "./launch-brief.js";
import { addGrant, grantSchema, listNamedGrants, removeGrant } from "./grants.js";
import { sessionId, type Json } from "./protocol.js";

export async function runDispatch(args: string[]): Promise<number> {
  if (args[0] === "report") {
    const { values } = parseArgs({ args: args.slice(1), options: { prs: { type: "string" } } });
    const origin = await terminalPaneFromEnv();
    if (!origin || !values.prs) throw new Error("Usage inside a worker pane: phren dispatch report --prs <JSON array>");
    const dispatch = dispatchIdFromEnv();
    console.log(JSON.stringify(await hookRequest("/v1/dispatch/report", { origin, prs: prsSchema.parse(JSON.parse(values.prs)), ...(dispatch ? { dispatch } : {}) }), null, 2)); return 0;
  }
  if (args.length === 1 && args[0] === "status") {
    console.log(JSON.stringify(await hookRequest("/v1/dispatch"), null, 2)); return 0;
  }
  if (args.length === 1 && args[0] === "returns") {
    console.log(JSON.stringify(await hookRequest("/v1/dispatch/returns", {}), null, 2)); return 0;
  }
  if (args[0] === "usage" && args.slice(1).every(arg => arg === "--json")) {
    const { readAccountUsage, formatAccountUsage } = await import("./account-usage.js");
    const view = await readAccountUsage();
    console.log(args.includes("--json") ? JSON.stringify(view, null, 2) : formatAccountUsage(view)); return 0;
  }
  if (args.length === 1 && args[0] === "sessions") {
    const { listLiveSessions } = await import("./hand-off.js");
    console.log(JSON.stringify(await listLiveSessions(), null, 2)); return 0;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "keep-open": { type: "boolean" },
    harness: { type: "string", default: "codex" }, model: { type: "string" }, effort: { type: "string" }, account: { type: "string" }, "permission-mode": { type: "string" }, prompt: { type: "string" }, label: { type: "string" },
    "parent-provider": { type: "string" }, "parent-session": { type: "string" }, "parent-computer": { type: "string" },
    "parent-server": { type: "string" }, "parent-workspace": { type: "string" }, "parent-tab": { type: "string" }, "parent-pane": { type: "string" },
  } });
  if (positionals.length !== 2) throw new Error("Usage: phren dispatch <computer|anywhere> <project> --label <label> --prompt <brief> [--harness codex|claude|opencode|copilot] [--model <model>] [--effort minimal|low|medium|high|xhigh|max] [--account <id>] [--permission-mode supervised|auto-edits|auto|full-access] [explicit parent flags]");
  const parentValues = ["parent-provider", "parent-session", "parent-computer", "parent-server", "parent-workspace", "parent-tab", "parent-pane"] as const;
  const hasParent = parentValues.some(key => values[key] !== undefined);
  const parent = hasParent ? {
    provider: values["parent-provider"], session: values["parent-session"], computer: values["parent-computer"],
  } : undefined;
  const parentTarget = hasParent ? {
    server: values["parent-server"], workspace: values["parent-workspace"], tab: values["parent-tab"], pane: values["parent-pane"],
    source: values["parent-provider"], session: values["parent-session"],
  } : undefined;
  const { "permission-mode": permissionMode, "keep-open": keepOpen, ...rest } = values;
  const ordinary = { ...Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith("parent-"))), ...(permissionMode !== undefined ? { permissionMode } : {}), ...(keepOpen ? { closeOnFinish: false } : {}) };
  const input = dispatchSchema.parse({ computer: positionals[0], project: positionals[1], ...ordinary,
    ...(parent ? { parent, parentTarget } : {}) });
  // Run inside an agent's pane, the dispatch remembers that pane for return notices.
  const origin = await terminalPaneFromEnv();
  const result = await hookRequest("/v1/dispatch", { ...input, ...(origin ? { origin } : {}) }, undefined, 180_000);
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true ? 0 : 1;
}

export async function runHandOff(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "delivery-id": { type: "string" }, status: { type: "boolean" }, session: { type: "string" }, text: { type: "string" }, project: { type: "string" }, account: { type: "string" },
  } });
  if (positionals.length !== 1 || !values.session || (!values.status && !values.text) || (values.status && !values["delivery-id"])) throw new Error("Usage: phren hand-off <computer|local> --session <id> --text <prompt> [--project <slug>] [--account <id>]");
  const computer = positionals[0] === "local" ? undefined : positionals[0];
  const result = await handOff({ ...(computer ? { computer } : {}), project: values.project, ...(values.account ? { account: values.account } : {}), session: sessionId.parse(values.session), ...(values.status ? { status: true } : { text: values.text }), ...(values["delivery-id"] ? { deliveryId: values["delivery-id"] } : {}) });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

const MOVE_USAGE = "Usage: phren move <computer|local> --session <id> --to <claude|codex|opencode|copilot> [--account <id>] [--model <model>] [--effort <effort>] [--no-wait] | phren move <computer|local> --status <move-id>";

/** `phren move`: a live session to another agent, through its computer's Hook (session-move.ts). */
export async function runMove(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    session: { type: "string" }, to: { type: "string" }, account: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    status: { type: "string" }, id: { type: "string" }, "no-wait": { type: "boolean" },
  } });
  if (positionals.length !== 1 || (!values.status && (!values.session || !values.to))) throw new Error(MOVE_USAGE);
  const computer = positionals[0] === "local" ? undefined : positionals[0];
  const result = await moveSession(values.status ? { ...(computer ? { computer } : {}), status: true, id: values.status }
    : { ...(computer ? { computer } : {}), session: sessionId.parse(values.session), harness: values.to, ...(values.account ? { account: values.account } : {}),
      ...(values.model ? { model: values.model } : {}), ...(values.effort ? { effort: values.effort } : {}), ...(values.id ? { id: values.id } : {}),
      ...(values["no-wait"] ? { wait: false } : {}) });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

const CONDUCTOR_USAGE = "Usage: phren conductor status | make [--pane <id>] [--mux herdr:<name>|tmux:<name>] | stop [--pane <id>] | sets [--json] | sets name <name>|--clear | grants [list|add|remove]";

/** The Hook route for a pane's multiplexer: `--mux`, else the pane the command runs in. */
function muxQuery(mux: string | undefined, here: { server: string } | undefined): string {
  if (mux) return `?mux=${encodeURIComponent(mux)}`;
  return here ? `?server=${encodeURIComponent(here.server)}` : "";
}

/** One line per computer: name, reachability, link and conductor. */
export function formatSets(view: Json): string {
  const lines: string[] = [];
  const rows = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object") : [];
  for (const set of rows(view.sets)) {
    const conductors = typeof set.conductors === "number" ? set.conductors : 0;
    lines.push(`${typeof set.name === "string" ? set.name : "Unnamed set"}${set.local ? " (this computer)" : ""}${conductors > 1 ? `: ${conductors} conductors, stop all but one` : ""}`);
    for (const computer of rows(set.computers)) {
      const state = computer.link === "self" ? "this computer" : computer.reachable === true ? "reachable" : computer.reachable === false ? "unreachable" : "not asked";
      const link = computer.link === "self" ? "" : `, ${String(computer.link)} link`;
      lines.push(`  ${String(computer.name)}: ${state}${link}${computer.conductor ? ", conductor" : ""}${typeof computer.hint === "string" ? `. ${computer.hint}` : typeof computer.error === "string" ? `. ${computer.error}` : ""}`);
    }
  }
  const unlinked = rows(view.unlinked);
  if (unlinked.length) {
    lines.push("Not linked");
    for (const computer of unlinked) lines.push(`  ${String(computer.name)}. Link it with phren bridge link ${String(computer.name)}.`);
  }
  return lines.join("\n");
}

export async function runConductor(args: string[]): Promise<number> {
  const [namespace = "status", action = "list", ...rest] = args;
  if (namespace === "status") { console.log(JSON.stringify(await hookRequest("/v1/conductor"), null, 2)); return 0; }
  if (namespace === "make" || namespace === "stop") {
    const { values } = parseArgs({ args: args.slice(1), options: { pane: { type: "string" }, mux: { type: "string" } } });
    const here = await terminalPaneFromEnv();
    if (namespace === "make") {
      const pane = values.pane ?? here?.pane;
      if (!pane) throw new Error("Run phren conductor make inside the agent's pane, or name it with --pane <id>.");
      const place = values.pane ? { paneId: values.pane } : { workspaceId: here!.workspace, tabId: here!.tab, paneId: here!.pane };
      const result = await hookRequest(`/v1/conductor/make${muxQuery(values.mux, values.pane ? undefined : here)}`, place);
      console.log(JSON.stringify(result, null, 2));
      return result.ok === true ? 0 : 1;
    }
    const result = await hookRequest("/v1/conductor/stop", values.pane ? { paneId: values.pane } : {});
    console.log(result.stopped ? "This computer has no conductor now." : "This computer had no conductor.");
    return 0;
  }
  if (namespace === "integrator") {
    const { values } = parseArgs({ args: args.slice(1), options: { session: { type: "string" }, computer: { type: "string" }, clear: { type: "boolean" } } });
    if (values.clear) { console.log(JSON.stringify(await hookRequest("/v1/conductor/integrator", { integrator: null }), null, 2)); return 0; }
    if (!values.session) { console.log(JSON.stringify(await hookRequest("/v1/conductor/integrator"), null, 2)); return 0; }
    const { listLiveSessions } = await import("./hand-off.js");
    const live = await listLiveSessions(), session = live.sessions.find(row => row.target?.session === values.session && (values.computer ? row.computer === values.computer : row.local));
    if (!session?.target) throw new Error("That integrator is not a live session on the selected computer.");
    console.log(JSON.stringify(await hookRequest("/v1/conductor/integrator", { integrator: { target: session.target, ...(!session.local ? { computer: session.computer } : {}) } }), null, 2)); return 0;
  }
  if (namespace === "sets") {
    if (action === "name") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { clear: { type: "boolean" } } });
      const name = values.clear ? null : positionals.join(" ").trim();
      if (name === "") throw new Error("Usage: phren conductor sets name <name>|--clear");
      console.log(JSON.stringify(await hookRequest("/v1/sets/name", { name }), null, 2));
      return 0;
    }
    const view = await hookRequest("/v1/sets", undefined, undefined, 60_000);
    console.log(args.includes("--json") ? JSON.stringify(view, null, 2) : formatSets(view));
    return 0;
  }
  if (namespace !== "grants") throw new Error(CONDUCTOR_USAGE);
  if (action === "list") {
    console.log(JSON.stringify(await listNamedGrants(), null, 2));
    return 0;
  }
  if (action === "add") {
    const { values } = parseArgs({ args: rest, allowPositionals: true, options: {
      scope: { type: "string" }, actions: { type: "string" }, computers: { type: "string" }, until: { type: "string" },
      "max-permission-mode": { type: "string" },
    } });
    const actions = (values.actions ?? "dispatch,hand_off").split(",").map(value => value.trim()).filter(Boolean);
    const grant = grantSchema.parse({
      scope: values.scope ?? "global",
      actions,
      ...(values.computers ? { computers: values.computers.split(",").map(value => value.trim()).filter(Boolean) } : {}),
      ...(values.until ? { until: values.until } : {}),
      ...(values["max-permission-mode"] ? { maxPermissionMode: values["max-permission-mode"] } : {}),
    });
    console.log(JSON.stringify(await addGrant(grant), null, 2));
    return 0;
  }
  if (action === "remove") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
      scope: { type: "string" }, index: { type: "string" },
    } });
    const index = values.index !== undefined ? Number(values.index) : positionals[0] !== undefined ? Number(positionals[0]) : undefined;
    if (index === undefined && !values.scope) throw new Error("Usage: phren conductor grants remove <index>|--scope <scope>");
    if (index !== undefined && !Number.isInteger(index)) throw new Error("Grant index must be an integer.");
    console.log(JSON.stringify(await removeGrant(index !== undefined ? { index } : { scope: values.scope }), null, 2));
    return 0;
  }
  throw new Error(CONDUCTOR_USAGE);
}

export async function runOwnerInbox(args: string[]): Promise<number> {
  const [action = "list", ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { computer: { type: "string" }, project: { type: "string" }, id: { type: "string" }, resolution: { type: "string" }, all: { type: "boolean" } } });
  const input = ownerInboxSchema.parse({ action, ...(values.computer ? { computer: values.computer === "local" ? undefined : values.computer } : {}),
    ...(action === "add" ? { title: positionals.join(" "), project: values.project, id: values.id } : {}),
    ...(action === "resolve" ? { id: positionals[0], resolution: values.resolution } : {}),
    ...(values.all ? { includeResolved: true } : {}) });
  console.log(JSON.stringify(await hookRequest("/v1/owner-inbox", input), null, 2)); return 0;
}
