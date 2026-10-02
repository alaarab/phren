import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractJson, loadJsonSchema, produceStructuredOutput } from "../structured-output.js";
import type { AgentToolDef, LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";

const SCHEMA = { type: "object", required: ["files", "ok"], properties: { files: { type: "array", items: { type: "string" } }, ok: { type: "boolean" } }, additionalProperties: false };

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("loadJsonSchema", () => {
  it("takes inline JSON or a file, and rejects what isn't a schema", () => {
    expect(loadJsonSchema(JSON.stringify(SCHEMA)).validate({ files: [], ok: true })).toBe(true);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "schema-"));
    dirs.push(d);
    fs.writeFileSync(path.join(d, "s.json"), JSON.stringify(SCHEMA));
    expect(loadJsonSchema(path.join(d, "s.json")).validate({ files: ["a"], ok: "yes" })).toBe(false);
    expect(() => loadJsonSchema("/no/such/file.json")).toThrow("neither a JSON object nor a readable file");
    expect(() => loadJsonSchema("{not json")).toThrow("not valid JSON");
    expect(() => loadJsonSchema('{"type": 12}')).toThrow("not a usable JSON Schema");
  });

  it("finds the JSON in a bare or fenced reply", () => {
    expect(extractJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
});

describe("produceStructuredOutput", () => {
  function provider(replies: string[], seen: { messages: LlmMessage[]; tools: AgentToolDef[] }[]): LlmProvider {
    return {
      name: "mock",
      async chat(_s, messages, tools): Promise<LlmResponse> {
        seen.push({ messages: structuredClone(messages), tools });
        return { content: [{ type: "text", text: replies.shift() ?? "" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      },
    };
  }
  const history: LlmMessage[] = [{ role: "user", content: "list the changed files" }, { role: "assistant", content: "a.ts and b.ts" }];
  const tools: AgentToolDef[] = [{ name: "read_file", description: "r", input_schema: { type: "object" } }];

  it("asks for the JSON with the session's tools, and retries with the validation errors", async () => {
    const seen: { messages: LlmMessage[]; tools: AgentToolDef[] }[] = [];
    const result = await produceStructuredOutput(provider(['{"files":["a.ts"]}', '{"files":["a.ts","b.ts"],"ok":true}'], seen), "sys", history, tools, loadJsonSchema(JSON.stringify(SCHEMA)));
    expect(result).toEqual({ value: { files: ["a.ts", "b.ts"], ok: true } });
    expect(seen).toHaveLength(2);
    expect(seen[0].tools).toEqual(tools);
    expect(String(seen[0].messages.at(-1)!.content)).toContain('"required"');
    expect(String(seen[1].messages.at(-1)!.content)).toContain("must have required property 'ok'");
    // The session's own history is not touched.
    expect(history).toHaveLength(2);
  });

  it("gives up with the last problem after three tries", async () => {
    const result = await produceStructuredOutput(provider(["nope", "nope", "nope"], []), "sys", history, tools, loadJsonSchema(JSON.stringify(SCHEMA)));
    expect(result).toMatchObject({ error: expect.stringContaining("after 3 attempts: not JSON") });
  });
});
