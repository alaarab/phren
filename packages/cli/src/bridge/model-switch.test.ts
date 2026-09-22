import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { rpc, validateTarget } from "./herdr.js";
import { codexModelStatus, MODEL_BUSY, ModelSwitcher, refuseWorkingSlash } from "./model-switch.js";
import { codexModels, ModelCatalog } from "./models.js";
import type { Target } from "./protocol.js";

vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(), rpc: vi.fn(), validateTarget: vi.fn() }));
const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session: "fixture-session" };
const astra = { id: "gpt-6-astra", name: "GPT-6-Astra", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] };

describe("model switch route transaction", () => {
  let switcher: ModelSwitcher, hooks: AgentHooks, stage: string, highlight: number;
  let missing: boolean, stuck: boolean, status: string, wrongFooter: boolean, draft: boolean, quick: boolean, missingEffort: boolean;
  const sent = () => vi.mocked(rpc).mock.calls.filter(call => call[1] !== "agent.read").map(call => [call[1], call[2]]);
  beforeEach(() => {
    hooks = new AgentHooks();
    switcher = new ModelSwitcher(hooks, new ModelCatalog(async () => [astra], async () => [{ id: "claude-opus-5-5", name: "Opus 5.5" }]), 20);
    stage = "idle"; highlight = 0; missing = false; stuck = false; wrongFooter = false; draft = false; status = "idle"; quick = false; missingEffort = false;
    vi.mocked(validateTarget).mockReset().mockImplementation(async () => ({ terminal_id: "t1", agent_status: status }));
    vi.mocked(rpc).mockReset().mockImplementation(async (_server, method, params) => {
      if (method === "agent.prompt") { stage = String(params?.text).includes("opus") ? "claude" : quick ? "quick" : "model"; return {}; }
      if (method === "agent.send_keys") {
        for (const key of params?.keys as string[]) {
          if (key === "escape") stage = stage === "effort" ? "model" : "idle";
          if (key === "enter") { stage = stage === "quick" ? "model" : stage === "model" ? "effort" : "done"; highlight = 0; }
          if (!stuck && key === "down") highlight++;
          if (!stuck && key === "up") highlight--;
        }
        return {};
      }
      if (method === "agent.read") {
        const labels = stage === "quick" ? ["Auto", "All models"] : stage === "model" ? ["GPT-5.6-Sol", missing ? "GPT-Other" : "GPT-6-Astra (current)"] : ["Low", missingEffort ? "Minimal" : "Medium (default)", "High", "Extra high"];
        const text = ["quick", "model", "effort"].includes(stage)
          ? `${stage === "effort" ? "Select Reasoning Level for GPT-6-Astra" : "Select Model"}\n\n${labels.map((label, i) => `${i === highlight ? "›" : " "} ${i + 1}. ${label}  Description`).join("\n")}\nPress enter to confirm or esc to go back`
          : stage === "claude" ? "Set model to Opus 5.5\n❯\n"
          : `›${draft ? " unfinished draft" : ""}\n${stage === "done" && !wrongFooter ? "gpt-6-astra" : "gpt-5.6-sol"} medium · 100% left`;
        return { read: { text } };
      }
      throw Error(`Unexpected ${method}`);
    });
  });

  it.each([undefined, "xhigh"])("walks both menus and verifies the status line with effort %s", async effort => {
    expect(await switcher.switch(target, { model: astra.id, effort })).toEqual({ ok: true, model: astra.id, name: astra.name, effort: effort ?? "medium" });
    expect(sent()).toEqual([
      ["agent.prompt", { target: target.pane, text: "/model" }],
      ["agent.send_keys", { target: target.pane, keys: ["down"] }],
      ["agent.send_keys", { target: target.pane, keys: ["enter"] }],
      ["agent.send_keys", { target: target.pane, keys: Array(effort ? 3 : 1).fill("down") }],
      ["agent.send_keys", { target: target.pane, keys: ["enter"] }],
    ]);
    expect(hooks.menuOpen(target)).toBe(false);
  });
  it("refuses a working pane without typing anything", async () => {
    status = "working";
    await expect(switcher.switch(target, { model: astra.id })).rejects.toMatchObject({ status: 409, message: MODEL_BUSY });
    expect(sent()).toEqual([]);
  });
  it("does not offer an automatic retry if work starts after opening the menu", async () => {
    const original = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(async (...args) => {
      const value = await original(...args);
      if (args[1] === "agent.prompt") status = "working";
      return value;
    });
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("result is unconfirmed");
    expect(sent()).toEqual([["agent.prompt", { target: target.pane, text: "/model" }]]);
  });
  it.each(["/model gpt-6-astra", " /model", "\n/permissions", "/compact"])("rejects busy slash input %s before delivery", text => {
    expect(() => refuseWorkingSlash({ agent_status: "working" }, text)).toThrow(MODEL_BUSY);
    expect(() => refuseWorkingSlash({ agent_status: "idle" }, text)).not.toThrow();
    expect(() => refuseWorkingSlash({ agent_status: "working" }, "Continue with the tests")).not.toThrow();
  });
  it("escapes a missing model row without confirming it", async () => {
    missing = true;
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("row is missing");
    expect(sent().map(call => call[1])).toEqual([{ target: target.pane, text: "/model" }, { target: target.pane, keys: ["escape"] }]);
    expect(stage).toBe("idle");
  });
  it("escapes when cursor movement cannot be verified", async () => {
    stuck = true;
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("verify the terminal selection");
    expect(sent().some(call => JSON.stringify(call).includes('"enter"'))).toBe(false);
    expect(stage).toBe("idle");
  });
  it("walks the quick menu's All models row before the chosen display name", async () => {
    quick = true;
    await expect(switcher.switch(target, { model: astra.id })).resolves.toMatchObject({ ok: true, model: astra.id });
    expect(sent().filter(call => JSON.stringify(call).includes('"enter"'))).toHaveLength(3);
  });
  it("escapes both nested menus if the effort row is missing", async () => {
    missingEffort = true;
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("effort row");
    expect(sent().filter(call => JSON.stringify(call).includes('"escape"'))).toHaveLength(2);
    expect(stage).toBe("idle");
  });
  it("does not claim success from an unchanged footer", async () => {
    wrongFooter = true;
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("status line");
  });
  it("preserves an existing draft", async () => {
    draft = true;
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("draft");
    expect(sent()).toEqual([]);
  });
  it("sends Claude's alias once and verifies its confirmation", async () => {
    expect(await switcher.switch({ ...target, source: "claude" }, { model: "opus" })).toEqual({ ok: true, model: "claude-opus-5-5", name: "Opus 5.5" });
    expect(sent()).toEqual([["agent.prompt", { target: target.pane, text: "/model opus" }]]);
  });
  it("refuses OpenCode clearly without typing a fake command", async () => {
    await expect(switcher.switch({ ...target, source: "opencode" }, { model: "opencode/model" })).rejects.toThrow("/models picker");
    expect(sent()).toEqual([]);
  });
  it("keeps another request out of a model transaction", async () => {
    const first = switcher.switch(target, { model: astra.id });
    await expect(switcher.switch(target, { model: astra.id })).rejects.toThrow("already in progress");
    expect(() => switcher.assertAvailable(target)).toThrow("already in progress");
    await first;
  });
});

it("retains the app-server's default and supported reasoning efforts", () => {
  expect(codexModels({ data: [{ id: astra.id, displayName: astra.name, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "xhigh" }] }] })[0])
    .toMatchObject({ defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "xhigh"] });
});
it("does not mistake history, a prefix model, or a draft for the Codex status line", () => {
  for (const text of ["gpt-6-astra\n›\ngpt-5.6-sol", "›\ngpt-6-astra-other medium", "› gpt-6-astra", "Changed to gpt-6-astra"]) expect(codexModelStatus(text, astra)).toBe(false);
});
it("distinguishes a dim placeholder from a colored draft", () => {
  expect(codexModelStatus("› \x1b[2mAsk Codex to do anything\x1b[0m\ngpt-6-astra medium", astra)).toBe(true);
  expect(codexModelStatus("› \x1b[38;2;80;80;80mA person's draft\x1b[0m\ngpt-6-astra medium", astra)).toBe(false);
});
