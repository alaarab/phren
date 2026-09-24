import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { registerMachineCommands } from "../src/commands/machine-commands";
import { fakeExtensionContext } from "./test-helpers";

function handlerFor(commandId: string): (...args: unknown[]) => unknown {
  const call = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === commandId);
  if (!call) throw new Error(`"${commandId}" was never registered`);
  return call[1] as (...args: unknown[]) => unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("machine-commands: uninstall confirmation", () => {
  it("says the store is deleted before asking, and a cancel does nothing", async () => {
    registerMachineCommands(fakeExtensionContext());
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);

    await handlerFor("phren.uninstall")();

    const [message, options, button] = vi.mocked(vscode.window.showWarningMessage).mock.calls[0] as unknown as [string, { modal: boolean }, string];
    expect(message).toContain("/store");
    expect(message).toMatch(/delete/i);
    expect(options.modal).toBe(true);
    expect(button).toMatch(/delete store/i);
    expect(vscode.window.withProgress).not.toHaveBeenCalled();
  });
});
