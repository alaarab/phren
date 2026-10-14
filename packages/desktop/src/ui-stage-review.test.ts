import { describe, expect, it, vi } from "vitest";
// @ts-expect-error stage.js is plain ESM without type declarations
import { createStaging } from "../ui/changes/stage.js";

const file = (path: string, extra = {}) => ({ path, status: "M", staged: false, binary: false, countsComplete: true, ...extra });
const files = () => Array.from({ length: 101 }, (_, i) => file(i === 0 ? "config.txt" : `file-${i}.txt`));
function setup(entries = files()) {
  const status = { repository: "/repo", files: entries, truncated: false, totalFiles: entries.length };
  const state = { status, busy: null, confirm: null as any, error: "" };
  const postStage = vi.fn().mockResolvedValue({ ok: true });
  const readStatus = vi.fn().mockImplementation(async () => state.status);
  const staging = createStaging(state, {
    scopeBody: (body = {}) => ({ target: { pane: "p" }, ...body }), repo: () => state.status.repository,
    render: vi.fn(), announce: vi.fn(), refresh: vi.fn(), postStage, readStatus,
  });
  return { state, staging, postStage, readStatus };
}

describe("reviewed staging selection", () => {
  it("refuses Stage all when status omits the 501st file", () => {
    const { state, staging, postStage } = setup(Array.from({ length: 500 }, (_, i) => file(`file-${i}`)));
    state.status.truncated = true; state.status.totalFiles = 501;
    staging.stageAll();
    expect(state.error).toMatch(/1 more file/);
    expect(state.confirm).toBeNull();
    expect(postStage).not.toHaveBeenCalled();
  });

  it("stages a single file while Discard confirmation is open", async () => {
    const { state, staging, postStage } = setup([file("app.ts")]);
    state.confirm = { kind: "discard", path: "app.ts" };
    staging.stage([state.status.files[0]]);
    await vi.waitFor(() => expect(postStage).toHaveBeenCalledWith(expect.objectContaining({ paths: ["app.ts"] })));
    expect(postStage.mock.calls[0][0]).not.toHaveProperty("confirmBulk");
  });

  it("keeps bulk staging waiting while another confirmation is open", () => {
    const { state, staging, postStage } = setup([file("assets/", { directory: true, status: "?" })]);
    const discard = { kind: "discard", path: "app.ts" };
    state.confirm = discard;
    staging.stageAll();
    staging.stage(state.status.files);
    expect(state.confirm).toBe(discard);
    expect(postStage).not.toHaveBeenCalled();
  });

  it.each([
    ["directory replacement", (entries: ReturnType<typeof files>) => [file("config.txt", { status: "D" }), ...entries.slice(1), file("config.txt/", { status: "?", directory: true })]],
    ["binary replacement", (entries: ReturnType<typeof files>) => [file("config.txt", { binary: true }), ...entries.slice(1)]],
    ["new member", (entries: ReturnType<typeof files>) => [...entries, file("new.txt")]],
    ["removed member", (entries: ReturnType<typeof files>) => entries.slice(1)],
  ])("reopens review without staging after %s", async (_label, change) => {
    const { state, staging, postStage, readStatus } = setup();
    staging.stageAll();
    state.status = { ...state.status, files: change(state.status.files) };
    await staging.confirm();
    expect(postStage).not.toHaveBeenCalled();
    expect(readStatus).toHaveBeenCalled();
    expect(state.confirm?.detail).toMatch(/changed.*review/i);
    expect(state.confirm.plan.paths).toEqual(state.status.files.map((entry) => entry.path));
  });

  it("refuses a confirmation whose fresh status is truncated", async () => {
    const { state, staging, postStage } = setup();
    staging.stageAll();
    state.status.truncated = true; state.status.totalFiles = 102;
    await staging.confirm();
    expect(postStage).not.toHaveBeenCalled();
    expect(state.error).toMatch(/1 more file/);
    expect(state.confirm).toBeNull();
  });

  it("stages the unchanged reviewed manifest after a fresh read", async () => {
    const { state, staging, postStage, readStatus } = setup();
    staging.stageAll();
    await staging.confirm();
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(postStage).toHaveBeenCalledWith(expect.objectContaining({ paths: state.status.files.map((entry) => entry.path), confirmBulk: true, expectedRepository: "/repo" }));
  });
});
