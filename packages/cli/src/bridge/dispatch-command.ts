import { parseArgs } from "node:util";
import { hookRequest } from "./client.js";
import { dispatchSchema } from "./dispatch.js";

export async function runDispatch(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "status") {
    console.log(JSON.stringify(await hookRequest("/v1/dispatch"), null, 2)); return 0;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    harness: { type: "string", default: "codex" }, model: { type: "string" }, prompt: { type: "string" }, label: { type: "string" },
    "parent-provider": { type: "string" }, "parent-session": { type: "string" }, "parent-computer": { type: "string" },
    "parent-server": { type: "string" }, "parent-workspace": { type: "string" }, "parent-tab": { type: "string" }, "parent-pane": { type: "string" },
  } });
  if (positionals.length !== 2) throw new Error("Usage: phren dispatch <computer|anywhere> <project> --label <label> --prompt <brief> [--harness codex|claude|opencode] [--model <model>] [explicit parent flags]");
  const parentValues = ["parent-provider", "parent-session", "parent-computer", "parent-server", "parent-workspace", "parent-tab", "parent-pane"] as const;
  const hasParent = parentValues.some(key => values[key] !== undefined);
  const parent = hasParent ? {
    provider: values["parent-provider"], session: values["parent-session"], computer: values["parent-computer"],
  } : undefined;
  const parentTarget = hasParent ? {
    server: values["parent-server"], workspace: values["parent-workspace"], tab: values["parent-tab"], pane: values["parent-pane"],
    source: values["parent-provider"], session: values["parent-session"],
  } : undefined;
  const ordinary = Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("parent-")));
  const input = dispatchSchema.parse({ computer: positionals[0], project: positionals[1], ...ordinary,
    ...(parent ? { parent, parentTarget } : {}) });
  const result = await hookRequest("/v1/dispatch", input, undefined, 180_000);
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true ? 0 : 1;
}
