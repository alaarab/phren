import { describe, expect, it } from "vitest";
import type { PendingServerRequest } from "./codex-app-server.js";
import { appServerApproval, appServerDecision, conductorCall, opencodePermissionReply } from "./agent-hook-asks.js";

const request = (method: string, params: Record<string, unknown> = {}): PendingServerRequest => ({ requestId: 1, method, params });

describe("appServerApproval", () => {
  it("builds a Bash card from the command, cwd and reason an app-server request carries", () => {
    expect(appServerApproval(request("item/commandExecution/requestApproval",
      { command: "rm -rf build", cwd: "/tmp/work", reason: "cleanup" })))
      .toEqual({ tool: "Bash", input: { command: "rm -rf build", cwd: "/tmp/work", reason: "cleanup" } });
  });

  it("drops fields the request omits or gives the wrong type", () => {
    expect(appServerApproval(request("item/commandExecution/requestApproval", { command: 42, cwd: null, reason: "" })))
      .toEqual({ tool: "Bash", input: {} });
  });

  const cases: [name: string, method: string, params: Record<string, unknown>, expected: unknown][] = [
    ["a delete change with a grant root and reason", "item/fileChange/requestApproval",
      { changes: [{ path: "/tmp/work/a.ts", kind: { type: "delete" } }, { path: 7, kind: { type: "add" } }], grantRoot: "/tmp/work", reason: "remove" },
      { tool: "apply_patch", input: { patch: "*** Delete File: /tmp/work/a.ts", grantRoot: "/tmp/work", reason: "remove" } }],
    ["a permission request", "item/permissions/requestApproval",
      { permissions: { network: { enabled: true } }, reason: "network" },
      { tool: "Permissions", input: { permissions: { network: { enabled: true } }, reason: "network" } }],
    ["a permission request with no permissions payload", "item/permissions/requestApproval", {},
      { tool: "Permissions", input: { permissions: {} } }],
    ["a question that stays in the pane", "item/tool/requestUserInput", { questions: [] }, undefined],
    ["an MCP elicitation that stays in the pane", "mcpServer/elicitation/request", {}, undefined],
  ];
  it.each(cases)("handles %s", (_name, method, params, expected) => {
    expect(appServerApproval(request(method, params))).toEqual(expected);
  });
});

describe("appServerDecision", () => {
  const cases: [name: string, pending: PendingServerRequest, allow: boolean, expected: unknown][] = [
    ["accepts a command", request("item/commandExecution/requestApproval"), true, { decision: "accept" }],
    ["declines a command", request("item/commandExecution/requestApproval"), false, { decision: "decline" }],
    ["grants the requested permissions for the turn", request("item/permissions/requestApproval",
      { permissions: { network: { enabled: true } } }), true, { permissions: { network: { enabled: true } }, scope: "turn" }],
    ["grants nothing for a permissions request missing its payload", request("item/permissions/requestApproval"), true,
      { permissions: {}, scope: "turn" }],
    ["refuses a permissions request with no grant", request("item/permissions/requestApproval",
      { permissions: { network: { enabled: true } } }), false, { permissions: {}, scope: "turn" }],
  ];
  it.each(cases)("%s", (_name, pending, allow, expected) => {
    expect(appServerDecision(pending, allow)).toEqual(expected);
  });
});

describe("conductorCall", () => {
  const cases: [name: string, tool: string, input: unknown, expected: unknown][] = [
    ["a bare dispatch", "dispatch", {}, { action: "dispatch" }],
    ["a dotted dispatch with placement", "phren.dispatch", { project: "demo", computer: "mac-mini" },
      { action: "dispatch", project: "demo", computer: "mac-mini" }],
    ["a double-underscore MCP dispatch", "mcp__phren__dispatch", { project: "demo" }, { action: "dispatch", project: "demo" }],
    ["phren_admin carrying hand_off", "mcp__phren__phren_admin", { action: "hand_off", computer: "mac-mini" },
      { action: "hand_off", computer: "mac-mini" }],
    ["a phren_admin with no conductor action", "phren_admin", { action: "approve" }, undefined],
    ["a phren_admin with a malformed payload", "phren_admin", null, undefined],
    ["an unrelated tool", "Bash", { project: "demo" }, undefined],
  ];
  it.each(cases)("recognizes %s", (_name, tool, input, expected) => {
    expect(conductorCall(tool, input)).toEqual(expected);
  });

  it("omits placement fields that are not strings", () => {
    expect(conductorCall("dispatch", { project: 7, computer: null })).toEqual({ action: "dispatch" });
  });
});

describe("opencodePermissionReply", () => {
  const cases: [name: string, decision: unknown, expected: unknown][] = [
    ["a plain approval", "approve", "once"],
    ["a denial", "deny", "reject"],
    ["a project grant", "allow-project", "always"],
    ["an everywhere grant", "allow-everywhere", "always"],
    ["an unknown decision", "always", undefined],
    ["a malformed decision", { decision: "approve" }, undefined],
  ];
  it.each(cases)("maps %s", (_name, decision, expected) => {
    expect(opencodePermissionReply(decision)).toBe(expected);
  });
});
