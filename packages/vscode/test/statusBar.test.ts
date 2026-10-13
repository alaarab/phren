import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient } from "./test-helpers";

// The vscode stub has no status bar surface; augment it for this suite only.
// `importOriginal` resolves the aliased stub, so spreading keeps every other
// export intact while adding the two members PhrenStatusBar touches.
const { statusItems, makeStatusItem } = vi.hoisted(() => {
  const statusItems: Array<{
    text: string;
    tooltip?: unknown;
    command?: string;
    color?: unknown;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  function makeStatusItem() {
    const item = {
      text: "",
      tooltip: undefined as unknown,
      command: undefined as string | undefined,
      color: undefined as unknown,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
    statusItems.push(item);
    return item;
  }
  return { statusItems, makeStatusItem };
});

vi.mock("vscode", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      ...actual.window,
      createStatusBarItem: vi.fn(() => makeStatusItem()),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
});

// eslint-disable-next-line import/order -- must come after vi.mock for hoisting to apply
import { PhrenStatusBar } from "../src/statusBar";

function tooltipText(item: (typeof statusItems)[number]): string {
  return typeof item.tooltip === "string" ? item.tooltip : "";
}

describe("PhrenStatusBar.initialize: a discovery failure must not stop health polling", () => {
  beforeEach(() => {
    statusItems.length = 0;
    vi.clearAllMocks();
  });

  it("shows the disconnected state with the reason and still runs a health poll when discovery fails", async () => {
    const client = fakeClient({
      listProjects: vi.fn(async () => {
        throw new Error("server down");
      }),
      healthCheck: vi.fn(async () => {
        throw new Error("server down");
      }),
    });

    const bar = new PhrenStatusBar(client);
    await bar.initialize(undefined);
    bar.dispose();

    const item = statusItems[0];
    expect(item.text).toContain("not connected");
    expect(tooltipText(item)).toContain("server down");
    // The failed listProjects() used to abort initialize before this call.
    expect(client.healthCheck).toHaveBeenCalled();
  });

  it("returns to normal when a later health poll succeeds even though discovery failed", async () => {
    const client = fakeClient({
      listProjects: vi.fn(async () => {
        throw new Error("server down");
      }),
      healthCheck: vi.fn(async () => ({ ok: true, data: { syncStatus: "local-only" } })),
    });

    const bar = new PhrenStatusBar(client);
    await bar.initialize(undefined);
    bar.dispose();

    expect(client.healthCheck).toHaveBeenCalled();
    expect(statusItems[0].text).not.toContain("not connected");
  });
});
