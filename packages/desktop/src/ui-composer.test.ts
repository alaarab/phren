import { describe, expect, it } from "vitest";
import {
  attachmentText,
  busyRetryDelay,
  contextPercent,
  deliveryIsFinal,
  draftKey,
  effortLevels,
  isBusyRefusal,
  isSlashCommand,
  modelBody,
  modelRows,
  permissionBody,
  permissionModeLabel,
  promptBody,
  providerLabel,
  settingsBody,
  slashMenu,
  slashSuggestions,
  startsFreshConversation,
  uploadBody,
  uploadName,
  withAttachments,
} from "../ui/chat/composer.js";

describe("slash commands", () => {
  it("recognizes a command only at the start", () => {
    expect(isSlashCommand("/model")).toBe(true);
    expect(isSlashCommand("say /model")).toBe(false);
    expect(isSlashCommand(undefined)).toBe(false);
  });

  it("filters the harness's catalogue as the draft is typed", () => {
    expect(slashSuggestions("claude", "/mo")).toEqual(["/model"]);
    expect(slashSuggestions("claude", "/")).toContain("/compact");
    expect(slashSuggestions("claude", "/model now")).toEqual([]);
    expect(slashSuggestions("unknown", "/m")).toEqual([]);
  });

  it("gives each row its detail text", () => {
    expect(slashMenu("codex", "/diff")).toEqual([{ name: "/diff", detail: "Show the working diff" }]);
  });

  it("flags the commands that replace the conversation", () => {
    expect(startsFreshConversation(" /clear ")).toBe(true);
    expect(startsFreshConversation("/new")).toBe(true);
    expect(startsFreshConversation("/compact")).toBe(false);
  });
});

describe("busy retry policy", () => {
  it("backs off 2, 4, 8, 16, then every 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(busyRetryDelay)).toEqual([2, 4, 8, 16, 30, 30, 30, 30]);
    expect(busyRetryDelay(0)).toBe(0);
  });

  it("recognizes the Hook's mid-turn slash refusal only", () => {
    expect(isBusyRefusal(409, "This agent is working. Slash commands run between turns;")).toBe(true);
    expect(isBusyRefusal(409, "This agent needs input in the terminal first.")).toBe(false);
    expect(isBusyRefusal(500, "This agent is working.")).toBe(false);
  });
});

describe("payload builders", () => {
  const target = { server: "default", pane: "1", source: "claude", session: "s1" };

  it("names a prompt by its delivery id", () => {
    expect(promptBody(target, "hello", "id-1")).toEqual({ target, text: "hello", deliveryId: "id-1" });
  });

  it("sanitizes an upload name to the Hook's schema", () => {
    expect(uploadName("screenshot.png")).toBe("screenshot.png");
    expect(uploadName("../../settings.json")).toBe("____settings.json");
    expect(uploadName("weird/name*?.png")).toBe("weird_name__.png");
    expect(uploadName("")).toBe("image_");
    expect(uploadName("1 (copy).PNG")).toBe("1 (copy).PNG");
  });

  it("carries the base64 bytes and the sanitized name", () => {
    expect(uploadBody(target, "a b/c.png", "QUJD")).toEqual({ target, name: "a b_c.png", data: "QUJD" });
  });

  it("omits an effort the harness does not take", () => {
    expect(modelBody(target, "claude-opus-5")).toEqual({ target, model: "claude-opus-5" });
    expect(modelBody(target, "claude-opus-5", "high")).toEqual({ target, model: "claude-opus-5", effort: "high" });
  });

  it("builds settings and permission bodies", () => {
    expect(settingsBody(target, { fast: true })).toEqual({ target, fast: true });
    expect(permissionBody(target, "plan")).toEqual({ target, mode: "plan" });
  });
});

describe("attachments", () => {
  it("builds the footer the Hook's reader expects", () => {
    expect(attachmentText([])).toBe("");
    expect(attachmentText(["", "/a.png", "/b.jpg"])).toBe("Attached files on this computer:\n/a.png\n/b.jpg");
  });

  it("appends the footer to the prompt", () => {
    expect(withAttachments("look", ["/a.png"])).toBe("look\n\nAttached files on this computer:\n/a.png");
    expect(withAttachments("look", [])).toBe("look");
  });
});

describe("delivery states", () => {
  it("stops polling only at a final state", () => {
    expect(deliveryIsFinal("delivered")).toBe(true);
    expect(deliveryIsFinal("failed")).toBe(true);
    expect(deliveryIsFinal("queued")).toBe(false);
    expect(deliveryIsFinal("unknown")).toBe(false);
  });
});

describe("model catalogue", () => {
  it("normalizes the /v1/models reply", () => {
    const rows = modelRows("claude", { models: [
      { id: "claude-opus-5", name: "Opus 5", description: "Capable", isDefault: true, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
      { id: "" },
      { name: "no id" },
    ] });
    expect(rows).toEqual([{
      id: "claude-opus-5", name: "Opus 5", description: "Capable", isDefault: true, efforts: ["low", "high"], defaultEffort: "high",
    }]);
    expect(modelRows("claude", {})).toEqual([]);
  });

  it("reads a model's effort levels", () => {
    expect(effortLevels({ efforts: ["low", "high"] })).toEqual(["low", "high"]);
    expect(effortLevels(null)).toEqual([]);
  });
});

describe("context ring", () => {
  it("reads a percentage from any status shape", () => {
    expect(contextPercent({ contextPercent: 42 })).toBe(42);
    expect(contextPercent({ context: { percent: 120 } })).toBe(100);
    expect(contextPercent({ settingsState: { contextPercent: -5 } })).toBe(0);
    expect(contextPercent({})).toBeNull();
    expect(contextPercent(null)).toBeNull();
  });
});

describe("misc helpers", () => {
  it("names providers", () => {
    expect(providerLabel("claude")).toBe("Claude");
    expect(providerLabel("opencode")).toBe("OpenCode");
    expect(providerLabel("zzz")).toBe("Agent");
  });

  it("labels permission modes", () => {
    expect(permissionModeLabel("acceptEdits")).toBe("Accept edits");
    expect(permissionModeLabel("bypassPermissions")).toBe("Bypass permissions");
    expect(permissionModeLabel(undefined)).toBe("Mode");
  });

  it("keys a draft by the target", () => {
    expect(draftKey({ source: "claude", server: "default", pane: "1", session: "s1" }))
      .toBe("phren.composer.draft.claude:default:1:s1");
    expect(draftKey({})).toBe("phren.composer.draft.");
  });
});
