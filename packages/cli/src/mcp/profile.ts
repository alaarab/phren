/**
 * MCP tool profiles.
 *
 * The server used to hand every client 59 tools, about 11k tokens of schema
 * before a word was said, and 59 similar verbs to choose the wrong one from.
 * The `core` profile (the default) exposes the handful an agent reaches for
 * during normal work plus one `phren_admin` tool that reaches everything
 * else by name. `full` is the old surface for anyone who scripted against
 * it, and it also gains the composites.
 *
 * Nothing here knows how a tool works. Modules register tools exactly as
 * before; the server's registerTool wrapper records each one in a catalog and
 * only exposes the core ones, and the composites built here dispatch into
 * that catalog, validating against the target tool's own schema first.
 */

import { z } from "zod";
import { readInstallPreferences } from "../init/preferences.js";

export type McpProfile = "core" | "full";
export const MCP_PROFILES: readonly McpProfile[] = ["core", "full"];

/** What an agent gets in the core profile. Order is the order clients list them. */
export const CORE_TOOLS: readonly string[] = [
  "search_knowledge",
  "get_memory_detail",
  "get_project_summary",
  "add_finding",
  "revise_finding",
  "get_tasks",
  "add_task",
  "manage_task",
  "session",
  "phren_admin",
];

/** Env wins, then the install preference, then core. */
export function resolveMcpProfile(phrenPath: string, env: NodeJS.ProcessEnv = process.env): McpProfile {
  const fromEnv = env.PHREN_MCP_PROFILE?.trim().toLowerCase();
  if (fromEnv === "core" || fromEnv === "full") return fromEnv;
  try {
    const prefs = readInstallPreferences(phrenPath) as { mcpProfile?: string };
    if (prefs.mcpProfile === "core" || prefs.mcpProfile === "full") return prefs.mcpProfile;
  } catch {
    // No preferences yet: the default applies.
  }
  return "core";
}

export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}
export type ToolHandler = (args: Record<string, unknown>) => unknown;
export interface CatalogEntry { name: string; config: ToolConfig; handler: ToolHandler }
export type Catalog = Map<string, CatalogEntry>;

interface Composite {
  title: string;
  summary: string;
  /** action → registered tool name it stands for */
  actions: Record<string, string>;
}

const COMPOSITES: Record<string, Composite> = {
  revise_finding: {
    title: "◆ phren · revise finding",
    summary: "Change an existing finding: supersede, retract, edit, remove, link, resolve a contradiction, pin, or give feedback on it. Pass `action` plus that action's own parameters.",
    actions: {
      supersede: "supersede_finding",
      retract: "retract_finding",
      edit: "edit_finding",
      remove: "remove_finding",
      link: "link_findings",
      resolve_contradiction: "resolve_contradiction",
      pin: "pin_memory",
      feedback: "memory_feedback",
    },
  },
  manage_task: {
    title: "◆ phren · manage task",
    summary: "Change an existing task: complete, update, remove, pin, or tidy the done list. Pass `action` plus that action's own parameters.",
    actions: {
      complete: "complete_task",
      update: "update_task",
      remove: "remove_task",
      pin: "pin_task",
      tidy: "tidy_done_tasks",
    },
  },
  session: {
    title: "◆ phren · session",
    summary: "Session lifecycle: start, end, current context, or history. Pass `action` plus that action's own parameters.",
    actions: {
      start: "session_start",
      end: "session_end",
      context: "session_context",
      history: "session_history",
    },
  },
};

/** The tools a composite stands for, so the admin tool does not list them twice. */
function foldedNames(): Set<string> {
  const out = new Set<string>(["add_note"]); // reachable as add_finding with kind: "note"
  for (const c of Object.values(COMPOSITES)) for (const target of Object.values(c.actions)) out.add(target);
  return out;
}

/**
 * Notes fold into add_finding: `kind: "note"` saves a lightweight daily note
 * instead of a durable finding. The note tool keeps its own schema and
 * handler; this only adds the switch and routes through the catalog, so the
 * note module can register before or after the finding module.
 */
export function decorateAddFinding(entry: CatalogEntry, catalog: Catalog): CatalogEntry {
  const schema = schemaOf(entry);
  if (!schema) return entry;
  const config: ToolConfig = {
    ...entry.config,
    description: `${entry.config.description ?? ""} Pass kind: "note" to save a lightweight daily note instead (goes to the project's notes, not FINDINGS.md).`,
    inputSchema: schema.extend({
      kind: z.enum(["finding", "note"]).optional().describe("'finding' (default) is durable, curated knowledge; 'note' is a lightweight daily note."),
      date: z.string().optional().describe("Notes only: YYYY-MM-DD, defaults to today."),
    }),
  };
  const handler: ToolHandler = (args) => {
    const { kind, date, ...rest } = args as { kind?: string; date?: string } & Record<string, unknown>;
    if (kind === "note") {
      const finding = rest.finding;
      const text = Array.isArray(finding) ? finding.map(String).join("\n\n") : String(finding ?? "");
      return dispatch(catalog, "add_note", { project: rest.project, text, ...(date ? { date } : {}) });
    }
    return entry.handler(rest);
  };
  return { name: entry.name, config, handler };
}

export interface ToolGate {
  /** Drop-in for McpServer.registerTool: records every tool, exposes only what the profile allows. */
  registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => void;
  /** Call once every module has registered: adds the composites. */
  finish: () => void;
  readonly catalog: Catalog;
  readonly exposed: Set<string>;
  readonly profile: McpProfile;
}

/**
 * Sits between the tool modules and the real server. Modules keep calling
 * registerTool exactly as before; the gate keeps the catalog, exposes core
 * tools (or everything, in `full`), marks core tools always-loaded for Claude
 * Code, and registers the composites when `finish` is called.
 */
export function createToolGate(opts: {
  profile: McpProfile;
  register: (name: string, config: ToolConfig, handler: ToolHandler) => unknown;
  /** Wraps every handler (guards, telemetry) before it is stored or exposed. */
  wrap?: (name: string, handler: ToolHandler) => ToolHandler;
  /** Extra tools to mark always-loaded for Claude Code, on top of the core set. */
  alwaysLoad?: Iterable<string>;
}): ToolGate {
  const alwaysLoad = new Set<string>([...CORE_TOOLS, ...(opts.alwaysLoad ?? [])]);
  const catalog: Catalog = new Map();
  const exposed = new Set<string>();
  const expose = (name: string, config: ToolConfig, handler: ToolHandler) => {
    let finalConfig = config;
    if (alwaysLoad.has(name)) {
      const meta = (config._meta as Record<string, unknown> | undefined) ?? {};
      finalConfig = { ...config, _meta: { ...meta, "anthropic/alwaysLoad": true } };
    }
    opts.register(name, finalConfig, handler);
    exposed.add(name);
  };
  const registerTool = (name: string, config: ToolConfig, handler: ToolHandler) => {
    if (catalog.has(name)) throw new Error(`Duplicate MCP tool registration: "${name}"`);
    const wrapped = opts.wrap ? opts.wrap(name, handler) : handler;
    let entry: CatalogEntry = { name, config, handler: wrapped };
    if (name === "add_finding") entry = decorateAddFinding(entry, catalog);
    catalog.set(name, entry);
    if (opts.profile === "core" && !CORE_TOOLS.includes(name)) return;
    expose(name, entry.config, entry.handler);
  };
  const finish = () => {
    for (const tool of buildCompositeTools(catalog)) {
      if (catalog.has(tool.name)) continue;
      catalog.set(tool.name, { name: tool.name, config: tool.config, handler: tool.handler });
      expose(tool.name, tool.config, tool.handler);
    }
  };
  return { registerTool, finish, catalog, exposed, profile: opts.profile };
}

function schemaOf(entry: CatalogEntry): z.ZodObject<z.ZodRawShape> | null {
  const raw = entry.config.inputSchema;
  if (!raw) return null;
  if (raw instanceof z.ZodObject) return raw as z.ZodObject<z.ZodRawShape>;
  if (typeof raw === "object") return z.object(raw as z.ZodRawShape);
  return null;
}

interface ParamDoc { name: string; required: boolean; description: string }

function paramDocs(entry: CatalogEntry): ParamDoc[] {
  const schema = schemaOf(entry);
  if (!schema) return [];
  return Object.entries(schema.shape).map(([name, type]) => {
    const t = type as z.ZodTypeAny;
    return { name, required: !t.isOptional(), description: t.description ?? "" };
  });
}

function firstSentence(text: string | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const end = flat.search(/\.\s|\.$/);
  const s = end === -1 ? flat : flat.slice(0, end + 1);
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
}

function actionLine(action: string, entry: CatalogEntry): string {
  const required = paramDocs(entry).filter((p) => p.required).map((p) => p.name);
  const req = required.length ? ` (required: ${required.join(", ")})` : "";
  return `${action} — ${firstSentence(entry.config.description)}${req}`;
}

function errorResponse(error: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error, ...extra }, null, 2) }] };
}

/** Run a catalog tool by name after validating the arguments against its own schema. */
export async function dispatch(catalog: Catalog, target: string, args: Record<string, unknown>): Promise<unknown> {
  const entry = catalog.get(target);
  if (!entry) return errorResponse(`Unknown tool "${target}"`);
  const schema = schemaOf(entry);
  if (schema) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return errorResponse(`Invalid arguments for ${target}`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        params: paramDocs(entry),
      });
    }
    return entry.handler(parsed.data as Record<string, unknown>);
  }
  return entry.handler(args);
}

export interface BuiltTool { name: string; config: ToolConfig; handler: ToolHandler }

/**
 * The composite tools for a catalog. An action that has no registered target
 * (a module not loaded, say) is left out rather than advertised.
 */
export function buildCompositeTools(catalog: Catalog): BuiltTool[] {
  const out: BuiltTool[] = [];
  for (const [name, composite] of Object.entries(COMPOSITES)) {
    const actions = Object.entries(composite.actions).filter(([, target]) => catalog.has(target));
    if (!actions.length) continue;
    const lines = actions.map(([action, target]) => actionLine(action, catalog.get(target)!));
    const actionNames = actions.map(([action]) => action) as [string, ...string[]];
    const map = Object.fromEntries(actions);
    out.push({
      name,
      config: {
        title: composite.title,
        description: `${composite.summary}\nActions:\n${lines.map((l) => `- ${l}`).join("\n")}`,
        inputSchema: z.object({ action: z.enum(actionNames).describe("Which change to make.") }).passthrough(),
      },
      handler: (args) => {
        const { action, ...rest } = args as { action: string } & Record<string, unknown>;
        return dispatch(catalog, map[action], rest);
      },
    });
  }

  const folded = foldedNames();
  const adminTargets = [...catalog.keys()]
    .filter((n) => !CORE_TOOLS.includes(n) && !folded.has(n) && !(n in COMPOSITES))
    .sort();
  if (adminTargets.length) {
    const lines = adminTargets.map((n) => actionLine(n, catalog.get(n)!));
    const actionNames = ["list_actions", ...adminTargets] as [string, ...string[]];
    out.push({
      name: "phren_admin",
      config: {
        title: "◆ phren · admin",
        description:
          "Everything else phren can do — skills, hooks, config, notes, review queue, export/import, doctor, the fragment graph — behind one tool. " +
          "Pass `action` plus that action's parameters; `list_actions` returns every action with its full parameter list.\nActions:\n" +
          lines.map((l) => `- ${l}`).join("\n"),
        inputSchema: z.object({ action: z.enum(actionNames).describe("Which admin action to run, or list_actions.") }).passthrough(),
      },
      handler: (args) => {
        const { action, ...rest } = args as { action: string } & Record<string, unknown>;
        if (action === "list_actions") {
          const actions = adminTargets.map((n) => {
            const entry = catalog.get(n)!;
            return { name: n, description: entry.config.description ?? "", params: paramDocs(entry) };
          });
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, actions }, null, 2) }] };
        }
        return dispatch(catalog, action, rest);
      },
    });
  }
  return out;
}

/** Rough size of what a client downloads for a set of tools, for tests and doctor. */
export function schemaWeight(entries: Iterable<{ config: ToolConfig }>): number {
  let chars = 0;
  for (const { config } of entries) {
    chars += (config.title ?? "").length + (config.description ?? "").length;
    const raw = config.inputSchema;
    const schema = raw instanceof z.ZodObject ? raw : raw && typeof raw === "object" ? z.object(raw as z.ZodRawShape) : null;
    if (schema) for (const [k, t] of Object.entries(schema.shape)) chars += k.length + ((t as z.ZodTypeAny).description ?? "").length + 24;
  }
  return chars;
}
