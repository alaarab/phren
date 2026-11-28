import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChecklistIndexError } from "../forge/checklist.js";
import { ForgeError, IssueListError, type Issue } from "../forge/issues.js";
import { makeTempDir } from "../test-helpers.js";
import { handleIssueCommand, parseIssueArgs, resolveIssueRef, splitIssueRef } from "./issues.js";

const forge = vi.hoisted(() => ({
  listAcross: vi.fn(),
  providerFor: vi.fn(),
  parseRepoForProject: vi.fn(),
  repoForProject: vi.fn(),
}));
const detectProject = vi.hoisted(() => vi.fn(() => null as string | null));

vi.mock("../forge/issues.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../forge/issues.js")>();
  return {
    ...actual,
    listAcross: forge.listAcross,
    providerFor: forge.providerFor,
    parseRepoForProject: forge.parseRepoForProject,
    repoForProject: forge.repoForProject,
  };
});
vi.mock("../bridge/pair.js", () => ({ computerDisplayName: async () => "Desk" }));
vi.mock("../shared/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../shared/index.js")>()),
  detectProject,
}));

const repo = "github.com/example/widgets";
const other = "gitboy.example/example/gadgets";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    repo,
    number: 12,
    url: `${repo.replace(/^/, "https://")}/issues/12`,
    title: "Tighten the widget",
    body: "",
    state: "open",
    labels: [],
    assignees: [],
    checklist: [],
    updatedAt: "2026-01-02T10:00:00Z",
    createdAt: "2026-01-01T10:00:00Z",
    ...over,
  };
}

function fakeProvider(over: Record<string, unknown> = {}) {
  return {
    kind: "github",
    list: vi.fn(),
    get: vi.fn(async () => issue()),
    create: vi.fn(async (input: { title: string; body?: string; checklist?: string[] }) =>
      issue({ number: 13, title: input.title, body: input.body ?? "" })),
    edit: vi.fn(async (_ref: unknown, edit: { title?: string; state?: "open" | "closed" }) => issue({ title: edit.title ?? "Tighten the widget" })),
    comment: vi.fn(async () => ({ url: "https://github.com/example/widgets/issues/12#issuecomment-1" })),
    claim: vi.fn(async (_ref: unknown, _computer: string, release = false) =>
      issue(release ? {} : { labels: ["working-on:Desk"], assignees: ["me"] })),
    close: vi.fn(async () => issue({ state: "closed" })),
    ...over,
  };
}

let out: string[];
let err: string[];
let store: { path: string; cleanup: () => void };

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(args.join(" ")); });
  store = makeTempDir("phren-issues-cli-");
  forge.listAcross.mockReset();
  forge.listAcross.mockResolvedValue({ issues: [], errors: [] });
  forge.providerFor.mockReset();
  forge.providerFor.mockReturnValue(fakeProvider());
  forge.parseRepoForProject.mockReset();
  forge.parseRepoForProject.mockImplementation(async (text: string) => text.replace(/^https?:\/\//, ""));
  forge.repoForProject.mockReset();
  forge.repoForProject.mockResolvedValue(repo);
  detectProject.mockReset();
  detectProject.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.cleanup();
});

describe("argument parsing", () => {
  it("takes values, =values, repeatable flags, booleans and --", () => {
    const parsed = parseIssueArgs(["#12", "--repo", "owner/name", "--state=all", "--repo", "other/name", "--json", "--", "--not-a-flag"]);
    expect(parsed.positionals).toEqual(["#12", "--not-a-flag"]);
    expect(parsed.flags.get("--repo")).toEqual(["owner/name", "other/name"]);
    expect(parsed.flags.get("--state")).toEqual(["all"]);
    expect(parsed.flags.get("--json")).toEqual(["true"]);
  });

  it("refuses a flag without a value", () => {
    expect(() => parseIssueArgs(["--repo"])).toThrow("--repo needs a value.");
  });
});

describe("issue references", () => {
  it("splits repo#N, full URLs and bare #N", () => {
    expect(splitIssueRef("owner/name#12")).toEqual({ repo: "owner/name", number: 12 });
    expect(splitIssueRef("https://github.com/example/widgets/issues/12")).toEqual({ repo: "https://github.com/example/widgets", number: 12 });
    expect(splitIssueRef("https://github.com/example/widgets/issues/12#issuecomment-3")).toEqual({ repo: "https://github.com/example/widgets", number: 12 });
    expect(splitIssueRef("https://gitboy.example/example/widgets#7")).toEqual({ repo: "https://gitboy.example/example/widgets", number: 7 });
    expect(splitIssueRef("#4")).toEqual({ number: 4 });
  });

  it.each(["12", "#0", "owner/name#", "", "owner/name"])("refuses %j", text => {
    expect(() => splitIssueRef(text)).toThrow();
  });

  it("defaults a bare owner/name to the project's forge domain", async () => {
    await resolveIssueRef("owner/name#3", { project: "widgets", store: store.path });
    expect(forge.parseRepoForProject).toHaveBeenCalledWith("owner/name", "widgets", store.path);
  });

  it("reads #N with --repo or --project", async () => {
    await resolveIssueRef("#3", { repo: "owner/name", store: store.path });
    expect(forge.parseRepoForProject).toHaveBeenCalledWith("owner/name", undefined, store.path);
    forge.parseRepoForProject.mockClear();
    await expect(resolveIssueRef("#3", { project: "widgets", store: store.path })).resolves.toEqual({ repo, number: 3 });
    expect(forge.repoForProject).toHaveBeenCalledWith("widgets", store.path);
    expect(forge.parseRepoForProject).not.toHaveBeenCalled();
  });

  it("refuses #N with neither --repo nor --project", async () => {
    await expect(resolveIssueRef("#3", { store: store.path })).rejects.toThrow("--repo or --project");
  });
});

describe("list", () => {
  it("passes the filters and repositories to listAcross", async () => {
    forge.listAcross.mockResolvedValue({ issues: [issue({ labels: ["bug"], assignees: ["me"] })], errors: [{ repo: other, code: "auth", error: "Sign in to the forge." }] });
    const code = await handleIssueCommand(["list", "--repo", "github.com/example/widgets", "--repo", "gitboy.example/example/gadgets", "--state", "all", "--assignee", "me", "--label", "bug", "--search", "widget", "--limit", "5"], store.path);
    expect(code).toBe(0);
    expect(forge.listAcross).toHaveBeenCalledWith({
      repos: [repo, other],
      state: "all",
      assignee: "me",
      label: "bug",
      search: "widget",
      limit: 5,
    });
    expect(out.join("\n")).toContain("github.com/example/widgets");
    expect(out.join("\n")).toContain("#12");
    expect(out.join("\n")).toContain("Tighten the widget");
    expect(out.join("\n")).toContain(`! ${other}: Sign in to the forge.`);
  });

  it("prints JSON for machines", async () => {
    forge.listAcross.mockResolvedValue({ issues: [issue()], errors: [] });
    const code = await handleIssueCommand(["list", "--project", "widgets", "--json"], store.path);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ issues: [issue()], errors: [] });
    expect(forge.listAcross.mock.calls[0]![0]).toMatchObject({ repos: [repo], state: "open" });
  });

  it.each([false, true])("exits 2 for a fully failed list (%j)", async asJson => {
    const failure = { repo, code: "rate-limited" as const, error: "Try again later." };
    forge.listAcross.mockRejectedValue(new IssueListError([failure]));
    expect(await handleIssueCommand(["list", "--repo", repo, ...(asJson ? ["--json"] : [])], store.path)).toBe(2);
    if (asJson) expect(JSON.parse(out.join("\n"))).toEqual({ issues: [], errors: [failure] });
    else {
      expect(out).toEqual([]);
      expect(err).toEqual([`! ${repo}: Try again later.`]);
    }
  });

  it("defaults to the project around the working directory", async () => {
    detectProject.mockReturnValue("widgets");
    const code = await handleIssueCommand(["list"], store.path);
    expect(code).toBe(0);
    expect(forge.listAcross).toHaveBeenCalledWith({ repos: [repo], state: "open" });
  });

  it("asks for --repo when no project has an issue repository", async () => {
    const code = await handleIssueCommand(["list"], store.path);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Pass --repo.");
  });

  it.each([["--state", "wip"], ["--limit", "0"], ["--bogus", "x"]])("refuses %j", async (...args) => {
    const code = await handleIssueCommand(["list", ...args], store.path);
    expect(code).toBe(1);
    expect(forge.listAcross).not.toHaveBeenCalled();
  });
});

describe("show", () => {
  it("reads one issue and prints its body and checklist", async () => {
    const provider = fakeProvider({
      get: vi.fn(async () => issue({ body: "The body.", checklist: [{ text: "Test it", done: true }, { text: "Ship it", done: false }] })),
    });
    forge.providerFor.mockReturnValue(provider);
    const code = await handleIssueCommand(["show", "github.com/example/widgets#12"], store.path);
    expect(code).toBe(0);
    expect(forge.providerFor).toHaveBeenCalledWith(repo);
    expect(provider.get).toHaveBeenCalledWith({ repo, number: 12 });
    expect(out.join("\n")).toContain("The body.");
    expect(out.join("\n")).toContain("1. [x] Test it");
    expect(out.join("\n")).toContain("2. [ ] Ship it");
  });

  it("refuses extra positional arguments", async () => {
    expect(await handleIssueCommand(["show", "github.com/example/widgets#12", "extra"], store.path)).toBe(1);
  });
});

describe("new", () => {
  it("opens an issue with a body, checklist and labels", async () => {
    const provider = fakeProvider();
    forge.providerFor.mockReturnValue(provider);
    const code = await handleIssueCommand(["new", "--project", "widgets", "--title", "Tighten the widget", "--body", "Why.", "--check", "Test it", "--label", "bug"], store.path);
    expect(code).toBe(0);
    expect(provider.create).toHaveBeenCalledWith({ repo, title: "Tighten the widget", body: "Why.", checklist: ["Test it"], labels: ["bug"] });
    expect(out.join("\n")).toContain("Created github.com/example/widgets#13");
  });

  it("requires a repository and a title", async () => {
    expect(await handleIssueCommand(["new", "--title", "T"], store.path)).toBe(1);
    expect(await handleIssueCommand(["new", "--repo", "owner/name"], store.path)).toBe(1);
  });
});

describe("edit", () => {
  it("ticks a checklist item by position and appends a step", async () => {
    const provider = fakeProvider();
    forge.providerFor.mockReturnValue(provider);
    const code = await handleIssueCommand(["edit", "github.com/example/widgets#12", "--check-done", "2", "--check-add", "Announce it"], store.path);
    expect(code).toBe(0);
    expect(provider.edit).toHaveBeenCalledWith({ repo, number: 12 }, {
      checklistChanges: { done: [2], added: ["Announce it"] },
    });
  });

  it("passes title and body without reading the issue first", async () => {
    const provider = fakeProvider();
    forge.providerFor.mockReturnValue(provider);
    expect(await handleIssueCommand(["edit", "github.com/example/widgets#12", "--title", "New", "--body", "Body"], store.path)).toBe(0);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.edit).toHaveBeenCalledWith({ repo, number: 12 }, { title: "New", body: "Body" });
  });

  it("refuses an out-of-range step and a no-op edit", async () => {
    forge.providerFor.mockReturnValue(fakeProvider({
      edit: vi.fn(async () => { throw new ChecklistIndexError(2, 1); }),
    }));
    expect(await handleIssueCommand(["edit", "github.com/example/widgets#12", "--check-done", "2"], store.path)).toBe(1);
    expect(await handleIssueCommand(["edit", "github.com/example/widgets#12"], store.path)).toBe(1);
  });
});

describe("claim", () => {
  it("claims for this computer and releases it", async () => {
    const provider = fakeProvider();
    forge.providerFor.mockReturnValue(provider);
    expect(await handleIssueCommand(["claim", "github.com/example/widgets#12"], store.path)).toBe(0);
    expect(provider.claim).toHaveBeenCalledWith({ repo, number: 12 }, "Desk", false);
    expect(out.join("\n")).toContain("Claimed for Desk:");
    expect(await handleIssueCommand(["claim", "github.com/example/widgets#12", "--release"], store.path)).toBe(0);
    expect(provider.claim).toHaveBeenLastCalledWith({ repo, number: 12 }, "Desk", true);
  });
});

describe("comment and close", () => {
  it("posts the text as one comment", async () => {
    const provider = fakeProvider();
    forge.providerFor.mockReturnValue(provider);
    expect(await handleIssueCommand(["comment", "github.com/example/widgets#12", "Done", "and", "shipped"], store.path)).toBe(0);
    expect(provider.comment).toHaveBeenCalledWith({ repo, number: 12 }, "Done and shipped");
  });

  it("requires comment text", async () => {
    expect(await handleIssueCommand(["comment", "github.com/example/widgets#12"], store.path)).toBe(1);
  });

  it("closes with an optional comment", async () => {
    const provider = fakeProvider();
    forge.providerFor.mockReturnValue(provider);
    expect(await handleIssueCommand(["close", "github.com/example/widgets#12", "--comment", "Shipped"], store.path)).toBe(0);
    expect(provider.close).toHaveBeenCalledWith({ repo, number: 12 }, "Shipped");
    expect(out.join("\n")).toContain("Closed github.com/example/widgets#12");
  });
});

describe("exit codes", () => {
  it("returns 2 when the forge refuses", async () => {
    forge.providerFor.mockReturnValue(fakeProvider({
      get: vi.fn(async () => { throw new ForgeError("not-found", "The forge repository or issue was not found."); }),
    }));
    const code = await handleIssueCommand(["show", "github.com/example/widgets#12"], store.path);
    expect(code).toBe(2);
    expect(err.join("\n")).toBe("The forge repository or issue was not found.");
  });

  it("returns 2 for a rejected repository reference", async () => {
    forge.parseRepoForProject.mockRejectedValue(new ForgeError("invalid", "Use a github.com or gitboy repository."));
    const code = await handleIssueCommand(["show", "nonsense#3"], store.path);
    expect(code).toBe(2);
  });

  it("returns 1 for an unknown subcommand", async () => {
    const code = await handleIssueCommand(["frobnicate"], store.path);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("phren issue <list|show|new|edit|claim|comment|close>");
  });
});
