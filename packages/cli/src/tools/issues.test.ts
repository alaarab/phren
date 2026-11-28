import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeError, IssueListError, type Issue } from "../forge/issues.js";
import { CORE_TOOLS } from "../mcp/profile.js";
import { makeTempDir } from "../test-helpers.js";
import type { McpContext } from "./types.js";
import { register } from "./issues.js";

const forge = vi.hoisted(() => ({
  listAcross: vi.fn(),
  providerFor: vi.fn(),
  parseRepoForProject: vi.fn(),
  repoForProject: vi.fn(),
}));

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

const repo = "github.com/example/widgets";
const other = "gitboy.example/example/gadgets";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    repo,
    number: 12,
    url: `https://${repo}/issues/12`,
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

function fakeProvider() {
  return {
    kind: "github",
    list: vi.fn(),
    get: vi.fn(async () => issue()),
    create: vi.fn(async (input: { repo: string; title: string }) => issue({ number: 13, title: input.title })),
    edit: vi.fn(async () => issue({ title: "Edited" })),
    claim: vi.fn(async () => issue({ labels: ["working-on:Desk"], assignees: ["me"] })),
    comment: vi.fn(async () => ({ url: "https://github.com/example/widgets/issues/12#issuecomment-1" })),
    close: vi.fn(async () => issue({ state: "closed" })),
  };
}

interface Tool { config: { inputSchema: { safeParse: (value: unknown) => { success: boolean } } }; handler: (args: Record<string, unknown>) => unknown }

let tools: Map<string, Tool>;
let provider: ReturnType<typeof fakeProvider>;
let store: { path: string; cleanup: () => void };

beforeEach(() => {
  store = makeTempDir("phren-issues-mcp-");
  tools = new Map();
  provider = fakeProvider();
  forge.listAcross.mockReset();
  forge.listAcross.mockResolvedValue({ issues: [issue()], errors: [] });
  forge.providerFor.mockReset();
  forge.providerFor.mockReturnValue(provider);
  forge.parseRepoForProject.mockReset();
  forge.parseRepoForProject.mockImplementation(async (text: string) => {
    const bare = text.replace(/^https?:\/\//, "");
    return bare === "owner/name" ? repo : bare;
  });
  forge.repoForProject.mockReset();
  forge.repoForProject.mockResolvedValue(repo);
  const ctx: McpContext = {
    phrenPath: store.path,
    profile: "test",
    db: () => { throw new Error("not used"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
  register({ registerTool: (name: string, _config: unknown, handler: unknown) => { tools.set(name, { config: _config as Tool["config"], handler: handler as Tool["handler"] }); } } as never, ctx);
});

afterEach(() => {
  store.cleanup();
});

function schema(name: string) {
  return tools.get(name)!.config.inputSchema;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tools.get(name)!.handler(args) as { content: { text: string }[] };
  return JSON.parse(result.content[0]!.text);
}

describe("registration", () => {
  it("registers the seven issue tools", () => {
    expect([...tools.keys()].sort()).toEqual(["claim_issue", "close_issue", "comment_issue", "create_issue", "get_issue", "list_issues", "update_issue"]);
  });

  it("keeps list_issues and get_issue in the core profile", () => {
    expect(CORE_TOOLS).toContain("list_issues");
    expect(CORE_TOOLS).toContain("get_issue");
    for (const name of ["create_issue", "update_issue", "claim_issue", "comment_issue", "close_issue"]) expect(CORE_TOOLS).not.toContain(name);
  });
});

describe("schemas", () => {
  it("validates list_issues filters", () => {
    expect(schema("list_issues").safeParse({}).success).toBe(true);
    expect(schema("list_issues").safeParse({ repos: ["owner/name"], state: "closed", assignee: "me", label: "bug", search: "x", limit: 200 }).success).toBe(true);
    expect(schema("list_issues").safeParse({ state: "wip" }).success).toBe(false);
    expect(schema("list_issues").safeParse({ limit: 0 }).success).toBe(false);
    expect(schema("list_issues").safeParse({ limit: 201 }).success).toBe(false);
  });

  it("requires a number on the issue refs and a title on create", () => {
    expect(schema("get_issue").safeParse({ repo: "owner/name", number: 12 }).success).toBe(true);
    expect(schema("get_issue").safeParse({ repo: "owner/name" }).success).toBe(false);
    expect(schema("get_issue").safeParse({ repo: "owner/name", number: 0 }).success).toBe(false);
    expect(schema("create_issue").safeParse({ repo: "owner/name", title: "Tighten" }).success).toBe(true);
    expect(schema("create_issue").safeParse({ repo: "owner/name" }).success).toBe(false);
  });

  it("mirrors the checklist and edit fields", () => {
    expect(schema("update_issue").safeParse({ repo: "owner/name", number: 1, checklist: [{ text: "Test it" }], add_labels: ["bug"], remove_labels: ["wip"], state: "closed" }).success).toBe(true);
    expect(schema("update_issue").safeParse({ repo: "owner/name", number: 1, checklist: [{ done: true }] }).success).toBe(false);
    expect(schema("update_issue").safeParse({ repo: "owner/name", number: 1, state: "merged" }).success).toBe(false);
    expect(schema("claim_issue").safeParse({ repo: "owner/name", number: 1, release: true }).success).toBe(true);
    expect(schema("comment_issue").safeParse({ repo: "owner/name", number: 1 }).success).toBe(false);
    expect(schema("close_issue").safeParse({ repo: "owner/name", number: 1 }).success).toBe(true);
  });
});

describe("list_issues", () => {
  it("fans out over repos and passes every filter", async () => {
    forge.listAcross.mockResolvedValue({ issues: [issue(), issue({ repo: other, number: 7 })], errors: [{ repo: other, code: "auth", error: "Sign in to the forge." }] });
    const result = await call("list_issues", { repos: ["owner/name", "gitboy.example/example/gadgets"], state: "all", assignee: "me", label: "bug", search: "widget", limit: 10 });
    expect(result.ok).toBe(true);
    expect(forge.listAcross).toHaveBeenCalledWith({ repos: [repo, other], state: "all", assignee: "me", label: "bug", search: "widget", limit: 10 });
    expect(result.data).toEqual({ repos: [repo, other], issues: [issue(), issue({ repo: other, number: 7 })], errors: [{ repo: other, code: "auth", error: "Sign in to the forge." }] });
    expect(String(result.message)).toContain("github.com/example/widgets#12");
    expect(String(result.message)).toContain(`! ${other}: Sign in to the forge.`);
  });

  it("returns a failed result with the forge code when every repo fails", async () => {
    const failure = { repo, code: "auth" as const, error: "Renew the token." };
    forge.listAcross.mockRejectedValue(new IssueListError([failure]));
    await expect(call("list_issues", { repos: [repo] })).resolves.toMatchObject({
      ok: false, errorCode: "AUTH", data: { issues: [], errors: [failure] },
    });
  });

  it("reads a project's repository", async () => {
    const result = await call("list_issues", { project: "widgets" });
    expect(result.ok).toBe(true);
    expect(forge.repoForProject).toHaveBeenCalledWith("widgets", store.path);
    expect(forge.listAcross).toHaveBeenCalledWith({ repos: [repo], state: "open" });
  });

  it("refuses a list with no repository at all", async () => {
    const result = await call("list_issues", {});
    expect(result).toMatchObject({ ok: false, errorCode: "INVALID_ARGUMENT" });
    expect(forge.listAcross).not.toHaveBeenCalled();
  });

  it("uses the project for a bare owner/name alongside explicit repos", async () => {
    await call("list_issues", { repos: ["owner/name"], project: "widgets" });
    expect(forge.parseRepoForProject).toHaveBeenCalledWith("owner/name", "widgets", store.path);
    expect(forge.listAcross).toHaveBeenCalledWith({ repos: [repo], state: "open" });
  });
});

describe("get_issue", () => {
  it("reads one issue by repository and number", async () => {
    provider.get.mockResolvedValue(issue({ body: "The body.", checklist: [{ text: "Test it", done: true }] }));
    const result = await call("get_issue", { repo: "owner/name", number: 12 });
    expect(result.ok).toBe(true);
    expect(forge.providerFor).toHaveBeenCalledWith(repo);
    expect(provider.get).toHaveBeenCalledWith({ repo, number: 12 });
    expect(String(result.message)).toContain("The body.");
    expect(String(result.message)).toContain("1. [x] Test it");
  });

  it("resolves the repository from a project", async () => {
    const result = await call("get_issue", { project: "widgets", number: 12 });
    expect(result.ok).toBe(true);
    expect(forge.repoForProject).toHaveBeenCalledWith("widgets", store.path);
    expect(provider.get).toHaveBeenCalledWith({ repo, number: 12 });
  });
});

describe("create_issue", () => {
  it("passes the body, checklist and labels through", async () => {
    const result = await call("create_issue", { repo: "owner/name", title: "Tighten", body: "Why.", checklist: ["Test it"], labels: ["bug"] });
    expect(result.ok).toBe(true);
    expect(provider.create).toHaveBeenCalledWith({ repo, title: "Tighten", body: "Why.", checklist: ["Test it"], labels: ["bug"] });
  });

  it("requires a repository or project", async () => {
    const result = await call("create_issue", { title: "Tighten" });
    expect(result).toMatchObject({ ok: false, errorCode: "INVALID_ARGUMENT" });
  });
});

describe("update_issue", () => {
  it("maps the edit onto IssueEdit", async () => {
    const result = await call("update_issue", {
      repo: "owner/name",
      number: 12,
      title: "New",
      body: "Body",
      checklist: [{ text: "Test it", done: true }, { text: "Ship it" }],
      add_labels: ["bug"],
      remove_labels: ["wip"],
      state: "closed",
    });
    expect(result.ok).toBe(true);
    expect(provider.edit).toHaveBeenCalledWith({ repo, number: 12 }, {
      title: "New",
      body: "Body",
      checklist: [{ text: "Test it", done: true }, { text: "Ship it", done: false }],
      addLabels: ["bug"],
      removeLabels: ["wip"],
      state: "closed",
    });
  });

  it("sends only the fields it was given", async () => {
    await call("update_issue", { repo: "owner/name", number: 12, title: "New" });
    expect(provider.edit).toHaveBeenCalledWith({ repo, number: 12 }, { title: "New" });
  });
});

describe("claim_issue", () => {
  it("claims for this computer and can release", async () => {
    await call("claim_issue", { repo: "owner/name", number: 12 });
    expect(provider.claim).toHaveBeenCalledWith({ repo, number: 12 }, "Desk", false);
    await call("claim_issue", { repo: "owner/name", number: 12, release: true });
    expect(provider.claim).toHaveBeenLastCalledWith({ repo, number: 12 }, "Desk", true);
  });
});

describe("comment_issue", () => {
  it("posts one comment and returns its URL", async () => {
    const result = await call("comment_issue", { repo: "owner/name", number: 12, body: "Shipped" });
    expect(result.ok).toBe(true);
    expect(provider.comment).toHaveBeenCalledWith({ repo, number: 12 }, "Shipped");
    expect(result.data).toEqual({ url: "https://github.com/example/widgets/issues/12#issuecomment-1" });
  });
});

describe("close_issue", () => {
  it("closes with an optional comment", async () => {
    const result = await call("close_issue", { repo: "owner/name", number: 12, comment: "Shipped" });
    expect(result.ok).toBe(true);
    expect(provider.close).toHaveBeenCalledWith({ repo, number: 12 }, "Shipped");
    expect(result.data).toMatchObject({ state: "closed" });
  });
});

describe("error mapping", () => {
  it.each([
    ["auth", "AUTH"],
    ["not-found", "NOT_FOUND"],
    ["forbidden", "FORBIDDEN"],
    ["rate-limited", "RATE_LIMITED"],
    ["unavailable", "UNAVAILABLE"],
    ["invalid", "INVALID"],
  ] as const)("maps a forge %s failure to %s", async (code, expected) => {
    provider.get.mockRejectedValue(new ForgeError(code, `The forge refused (${code}).`));
    const result = await call("get_issue", { repo: "owner/name", number: 12 });
    expect(result).toEqual({ ok: false, error: `The forge refused (${code}).`, errorCode: expected });
  });

  it("reports a project with no repository", async () => {
    forge.repoForProject.mockResolvedValue(undefined);
    const result = await call("get_issue", { project: "widgets", number: 12 });
    expect(result).toMatchObject({ ok: false, errorCode: "INVALID_ARGUMENT" });
    expect(String(result.error)).toContain("No issue repository");
  });
});
