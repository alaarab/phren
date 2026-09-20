import { parseArgs } from "node:util";
import { hookRequest } from "./client.js";
import { dispatchSchema } from "./dispatch.js";

export async function runDispatch(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "status") {
    console.log(JSON.stringify(await hookRequest("/v1/dispatch"), null, 2)); return 0;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    harness: { type: "string", default: "codex" }, model: { type: "string" }, prompt: { type: "string" }, label: { type: "string" },
  } });
  if (positionals.length !== 2) throw new Error("Usage: phren dispatch <computer|anywhere> <project> --label <label> --prompt <brief> [--harness codex|claude|opencode] [--model <model>]");
  const input = dispatchSchema.parse({ computer: positionals[0], project: positionals[1], ...values });
  const result = await hookRequest("/v1/dispatch", input, undefined, 180_000);
  console.log(JSON.stringify(result, null, 2));
  return result.ok === true ? 0 : 1;
}
