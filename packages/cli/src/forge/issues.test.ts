import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProjectConfigField } from "../project-config.js";
import { makeTempDir } from "../test-helpers.js";
import { listAcross, parseRepo, parseRepoForProject, providerFor, repoForProject } from "./issues.js";

const gh = vi.hoisted(() => vi.fn<(args: readonly string[], options: { input?: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>>());
vi.mock("../bridge/probe-processes.js", async importOriginal => {
  const original = await importOriginal<typeof import("../bridge/probe-processes.js")>();
  return {
    ...original,
    execProbe: (file: string, args: string[], options: { input?: string; env: NodeJS.ProcessEnv }) =>
      file === "gh" ? gh(args, options) : original.execProbe(file, args, options),
  };
});

const gitboy = "gitboy.example/example/widgets";
const github = "github.com/example/widgets";
const base = "/api/v1/repos/example/widgets";
const OPEN = "<!-- phren:checklist -->";
const CLOSE = "<!-- /phren:checklist -->";
const fetchForge = vi.fn<typeof fetch>();
const ghJson = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "" });
const ghFailure = (status: number, message = "fixture-token") => Object.assign(new Error("fixture-token"), { stderr: `gh: ${message} (HTTP ${status})` });

const details = {
  title: "Tighten the widget",
  body: "",
  state: "open",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  labels: [],
  assignees: [],
};

beforeEach(() => {
  fetchForge.mockReset();
  fetchForge.mockRejectedValue(new Error("Unexpected forge HTTP request"));
  gh.mockReset();
  gh.mockRejectedValue(new Error("Unexpected gh request"));
  vi.stubGlobal("fetch", fetchForge);
  vi.stubEnv("GITBOY_HOST", "gitboy.example");
  vi.stubEnv("GITBOY_TOKEN", "fixture-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function githubIssueBodyFixture(body: string) {
  gh.mockImplementation(async (args, options) => {
    if (args.includes("PATCH")) body = JSON.parse(options.input ?? "").body;
    return ghJson({ ...details, number: 1, body });
  });
  return providerFor(github);
}

describe("checklists", () => {
  it("reads checkboxes anywhere and rewrites the managed block without changing the rest of the body", async () => {
    const before = "Notes\r\n- [ ] Outside\r\n\r\n";
    const after = "\r\n\r\n  - [X] Also outside\r\nEnd  ";
    const body = before + [OPEN, "- [x] Old step", CLOSE].join("\r\n") + after;
    const provider = githubIssueBodyFixture(body);
    const ref = { repo: github, number: 1 };
    const initial = await provider.get(ref);
    expect(initial.checklist).toEqual([
      { text: "Outside", done: false }, { text: "Old step", done: true }, { text: "Also outside", done: true },
    ]);

    const edited = await provider.edit(ref, { checklist: [{ text: "Ship $widgets", done: true }] });
    expect(edited.body).toBe(before + [OPEN, "- [x] Ship $widgets", CLOSE].join("\r\n") + after);
    expect(edited.checklist).toEqual([
      { text: "Outside", done: false }, { text: "Ship $widgets", done: true }, { text: "Also outside", done: true },
    ]);
  });

  it("appends a block during creation and appends it once when an existing body has no block", async () => {
    const plain = "Keep this spacing.  \n- [ ] Handwritten";
    const gitboyBody = "## Details\n";
    fetchForge.mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      return Response.json({ ...details, ...payload, index: 2, kind: "issue" });
    });
    const created = await providerFor(gitboy).create({ repo: gitboy, title: "Widget", body: gitboyBody, checklist: ["Test it"] });
    expect(created.body).toBe(gitboyBody + `\n${OPEN}\n- [ ] Test it\n${CLOSE}`);

    const provider = githubIssueBodyFixture(plain);
    const ref = { repo: github, number: 1 };
    const first = await provider.edit(ref, { checklist: [{ text: "New step", done: false }] });
    expect(first.body).toBe(plain + `\n\n${OPEN}\n- [ ] New step\n${CLOSE}`);
    const cleared = await provider.edit(ref, { checklist: [] });
    expect(cleared.body).toBe(plain + `\n\n${OPEN}\n${CLOSE}`);
    expect(cleared.checklist).toEqual([{ text: "Handwritten", done: false }]);
  });

  it("preserves a fenced example and the earlier managed block when rewriting the last one", async () => {
    const prefix = ["Notes  ", "  ```markdown", OPEN, "- [ ] Example", CLOSE, "  ```", "",
      OPEN, "- [x] Earlier block", CLOSE, "", "Last block below", ""].join("\r\n");
    const suffix = "\r\n\r\nFooter  ";
    const provider = githubIssueBodyFixture(prefix + [OPEN, "- [ ] Replace", CLOSE].join("\r\n") + suffix);
    const issue = await provider.edit({ repo: github, number: 1 }, { checklist: [{ text: "New", done: true }] });
    expect(issue.body).toBe(prefix + [OPEN, "- [x] New", CLOSE].join("\r\n") + suffix);
  });

  it("appends a block when the only markers appear in a tilde fence", async () => {
    const body = ["~~~markdown", "~~~still code", OPEN, "- [ ] Example  ", CLOSE, "~~~~", "End  "].join("\n");
    const provider = githubIssueBodyFixture(body);
    const issue = await provider.edit({ repo: github, number: 1 }, { checklist: [{ text: "New", done: false }] });
    expect(issue.body).toBe(body + `\n\n${OPEN}\n- [ ] New\n${CLOSE}`);
  });

  it("keeps a new checklist outside an unclosed fence", async () => {
    const body = ["Intro", "````markdown", "```", OPEN, "- [ ] Example", CLOSE].join("\n");
    const provider = githubIssueBodyFixture(body);
    const issue = await provider.edit({ repo: github, number: 1 }, { checklist: [{ text: "New", done: false }] });
    expect(issue.body).toBe(`${OPEN}\n- [ ] New\n${CLOSE}\n\n${body}`);
  });
});

interface ClaimState {
  labels: string[];
  assignees: string[];
}

function gitboyClaimFixture(options: {
  initial?: ClaimState;
  afterFirstRead?: ClaimState;
  afterLabelWrite?: (write: number) => ClaimState | undefined;
} = {}) {
  const labels: { id: string; name: string }[] = [];
  const labelFor = (name: string) => {
    const existing = labels.find(label => label.name === name);
    if (existing) return existing;
    const label = { id: `l${labels.length + 1}`, name };
    labels.push(label);
    return label;
  };
  let attached: typeof labels = [];
  let assignees: { username: string }[] = [];
  const apply = (state: ClaimState | undefined) => {
    if (!state) return;
    attached = state.labels.map(labelFor);
    assignees = state.assignees.map(username => ({ username }));
  };
  apply(options.initial ?? { labels: ["bug", "working-on:old"], assignees: ["previous"] });
  let reads = 0;
  let labelWrites = 0;
  let nextLabelStatus: number | undefined;
  const issue = () => ({ ...details, index: 1, kind: "issue", labels: attached, assignees });
  fetchForge.mockImplementation(async (url, init) => {
    const target = new URL(String(url));
    expect(target.hostname).toBe("gitboy.example");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    const method = init?.method;
    switch (`${method} ${target.pathname}`) {
      case "GET /api/v1/user": return Response.json({ username: "alex" });
      case `GET ${base}/issues/1`: {
        const reply = Response.json(issue());
        if (++reads === 1) apply(options.afterFirstRead);
        return reply;
      }
      case `GET ${base}/labels`: return Response.json(labels);
      case `POST ${base}/labels`: return Response.json(labelFor(payload.name), { status: 201 });
      case `PUT ${base}/issues/1/assignees`:
        assignees = payload.usernames.map((username: string) => ({ username }));
        return Response.json(issue());
      case `PUT ${base}/issues/1/labels`: {
        if (nextLabelStatus) {
          const status = nextLabelStatus;
          nextLabelStatus = undefined;
          return Response.json({}, { status });
        }
        attached = labels.filter(label => payload.label_ids.includes(label.id));
        const reply = Response.json(issue());
        apply(options.afterLabelWrite?.(++labelWrites));
        return reply;
      }
      default: throw new Error(`Unexpected gitboy route ${method} ${target.pathname}`);
    }
  });
  return (status: number) => { nextLabelStatus = status; };
}

function githubClaimFixture() {
  const knownLabels = new Set(["bug", "working-on:old"]);
  let labels = [...knownLabels];
  let assignees = ["previous"];
  gh.mockImplementation(async (args, options) => {
    expect(options.env).toMatchObject({ GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" });
    const [, route] = args;
    if (route === "user") return ghJson({ login: "alex" });
    if (route === "repos/example/widgets/labels" && args.includes("POST")) {
      const { name } = JSON.parse(options.input ?? "");
      knownLabels.add(name);
      return ghJson({ name });
    }
    const name = decodeURIComponent(route.split("/").at(-1) ?? "");
    if (route.startsWith("repos/example/widgets/labels/")) {
      if (!knownLabels.has(name)) throw ghFailure(404);
      return ghJson({ name });
    }
    if (route !== "repos/example/widgets/issues/1") throw new Error(`Unexpected gh route ${route}`);
    if (args.includes("PATCH")) {
      const patch = JSON.parse(options.input ?? "");
      if (patch.labels) labels = patch.labels.filter((label: string) => knownLabels.has(label));
      if (patch.assignees) assignees = patch.assignees;
    }
    return ghJson({ ...details, number: 1, labels: labels.map(name => ({ name })), assignees: assignees.map(login => ({ login })) });
  });
}

describe("claims", () => {
  const ref = { repo: gitboy, number: 1 };
  const deskClaim = { labels: ["bug", "working-on:desk"], assignees: ["alex"] };
  const otherClaim = { labels: ["bug", "working-on:other"], assignees: ["alex"] };

  it.each([[gitboy, gitboyClaimFixture], [github, githubClaimFixture]] as const)("replaces the claim and releases it on %s", async (repo, fixture) => {
    fixture();
    const provider = providerFor(repo);
    const ref = { repo, number: 1 };
    await expect(provider.claim(ref, "desk")).resolves.toMatchObject({
      labels: ["bug", "working-on:desk"],
      assignees: ["alex"],
      claimedBy: { user: "alex", computer: "desk" },
    });
    expect(await provider.claim(ref, "desk", true)).toMatchObject({ labels: ["bug"], assignees: [] });
    expect((await provider.get(ref)).claimedBy).toBeUndefined();
  });

  it("converges when retrying a gitboy claim after the label write fails", async () => {
    gitboyClaimFixture()(503);
    const provider = providerFor(gitboy);
    const ref = { repo: gitboy, number: 1 };
    await expect(provider.claim(ref, "desk")).rejects.toMatchObject({ code: "unavailable" });
    await expect(provider.claim(ref, "desk")).resolves.toMatchObject({ labels: ["bug", "working-on:desk"], assignees: ["alex"] });
  });

  it("writes both parts of a claim even when the initial snapshot already matches", async () => {
    gitboyClaimFixture({ initial: deskClaim, afterFirstRead: { ...otherClaim, assignees: ["riley"] } });
    const provider = providerFor(gitboy);
    await expect(provider.claim(ref, "desk")).resolves.toMatchObject(deskClaim);
    await expect(provider.get(ref)).resolves.toMatchObject(deskClaim);
  });

  it("retries when an overlapping claim changes the assignee after the writes", async () => {
    gitboyClaimFixture({
      afterLabelWrite: write => write === 1 ? { ...deskClaim, assignees: ["riley"] } : undefined,
    });
    const provider = providerFor(gitboy);
    await expect(provider.claim(ref, "desk")).resolves.toMatchObject(deskClaim);
    await expect(provider.get(ref)).resolves.toMatchObject(deskClaim);
  });

  it("reports the competing label when the claim loses both verification reads", async () => {
    gitboyClaimFixture({ afterLabelWrite: write => write <= 2 ? otherClaim : undefined });
    await expect(providerFor(gitboy).claim(ref, "desk")).rejects.toMatchObject({
      code: "invalid", message: expect.stringMatching(/claim conflict.*working-on:other/i),
    });
  });

  it.each([
    { labels: ["bug"], assignees: ["alex"] },
    otherClaim,
  ])("leaves a release with no matching claim unchanged ($labels)", async current => {
    gitboyClaimFixture({ initial: current });
    await expect(providerFor(gitboy).claim(ref, "desk", true)).resolves.toMatchObject(current);
    expect(fetchForge).toHaveBeenCalledTimes(1);
  });

  it("retries release when the claimant and the label reappear after the writes", async () => {
    gitboyClaimFixture({ initial: deskClaim, afterLabelWrite: write => write === 1 ? deskClaim : undefined });
    const provider = providerFor(gitboy);
    const released = { labels: ["bug"], assignees: [] };
    await expect(provider.claim(ref, "desk", true)).resolves.toMatchObject(released);
    await expect(provider.get(ref)).resolves.toMatchObject(released);
  });

  it("reports a release conflict and leaves the other computer's claim intact", async () => {
    gitboyClaimFixture({ initial: deskClaim, afterLabelWrite: write => write === 1 ? otherClaim : undefined });
    const provider = providerFor(gitboy);
    await expect(provider.claim(ref, "desk", true)).rejects.toMatchObject({
      code: "invalid", message: expect.stringMatching(/claim conflict.*working-on:other/i),
    });
    await expect(provider.get(ref)).resolves.toMatchObject(otherClaim);
  });
});

describe("listing and errors", () => {
  it("skips gitboy pull requests and continues across pages until matching issues fill the limit", async () => {
    fetchForge.mockImplementation(async url => {
      const params = new URL(String(url)).searchParams;
      return Response.json(params.get("cursor") === "4"
        ? { items: [{ ...details, index: 3, kind: "issue", body: "Meet the MATCH.", labels: [{ name: "bug" }], assignees: [{ username: "alex" }] }], next_cursor: "3" }
        : { items: [{ ...details, index: 4, kind: "pr", body: "Meet the MATCH.", labels: [{ name: "bug" }], assignees: [{ username: "alex" }] }], next_cursor: "4" });
    });
    const issues = await providerFor(gitboy).list({ repos: [gitboy], assignee: "alex", label: "bug", search: "match", limit: 1 });
    expect(issues.map(issue => issue.number)).toEqual([3]);
    expect(fetchForge).toHaveBeenCalledTimes(2);
  });

  it("returns gitboy matches by updated time and stops after five pages", async () => {
    fetchForge.mockImplementation(async url => {
      const params = new URL(String(url)).searchParams;
      expect(params.get("limit")).toBe("100");
      const index = Number(params.get("cursor") ?? "601") - 1;
      const labels = [600, 597, 595].includes(index) ? [{ name: "bug" }] : [];
      const updated_at = index === 597 ? "2026-02-01T00:00:00Z" : details.updated_at;
      return Response.json({
        items: [{ ...details, index, kind: "issue", labels, updated_at }],
        next_cursor: index > 595 ? String(index) : null,
      });
    });
    const issues = await providerFor(gitboy).list({ repos: [gitboy], label: "bug", limit: 3 });
    expect(issues.map(issue => issue.number)).toEqual([597, 600]);
    expect(fetchForge).toHaveBeenCalledTimes(5);
  });

  it("refuses to edit a gitboy pull request through the shared issue route", async () => {
    fetchForge.mockResolvedValueOnce(Response.json({ ...details, index: 1, kind: "pr" }));
    await expect(providerFor(gitboy).edit({ repo: gitboy, number: 1 }, { title: "Changed" })).rejects.toMatchObject({ code: "not-found" });
    expect(fetchForge).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "auth"], [403, "forbidden"], [404, "not-found"], [429, "rate-limited"], [500, "unavailable"], [503, "unavailable"],
  ])("maps %i on both forges without including raw diagnostics", async (status, code) => {
    fetchForge.mockResolvedValueOnce(Response.json({ message: "fixture-token" }, { status }));
    gh.mockRejectedValueOnce(ghFailure(status));
    for (const repo of [gitboy, github]) {
      const read = providerFor(repo).get({ repo, number: 1 });
      await expect(read).rejects.toMatchObject({ name: "ForgeError", code });
      await expect(read).rejects.not.toThrow("fixture-token");
    }
  });

  it("recognizes GitHub secondary rate limits reported as HTTP 403", async () => {
    gh.mockRejectedValueOnce(ghFailure(403, "You have exceeded a secondary rate limit."));
    await expect(providerFor(github).get({ repo: github, number: 1 })).rejects.toMatchObject({ code: "rate-limited" });
  });

  it("limits mixed-forge fan-out to four and returns successes alongside per-repo errors", async () => {
    let running = 0;
    let peak = 0;
    async function request<T>(value: () => T) {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setImmediate(resolve));
      running--;
      return value();
    }
    gh.mockImplementation(args => request(() => {
      if (args[1].includes("/missing/")) throw ghFailure(404);
      return ghJson([{ ...details, number: 1 }, { ...details, number: 2, pull_request: {} }]);
    }));
    fetchForge.mockImplementation(() => request(() => Response.json({ items: [{ ...details, kind: "issue", index: 1 }], next_cursor: null })));
    const repos = [github, gitboy, ...[2, 3, 4, 5].map(number => `${github}-${number}`), "github.com/example/missing"];
    const listed = await listAcross({ repos: [...repos, github], limit: 4 });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(listed.issues).toHaveLength(4);
    expect(listed.issues.some(issue => issue.repo === gitboy)).toBe(true);
    expect(listed.issues.map(issue => issue.number)).toEqual([1, 1, 1, 1]);
    expect(listed.errors).toEqual([{ repo: "github.com/example/missing", error: expect.any(String) }]);
    expect(gh).toHaveBeenCalledTimes(6);
    expect(fetchForge).toHaveBeenCalledTimes(1);
  });
});

describe("repository resolution", () => {
  it.each([
    ["example/widgets", github],
    ["GITBOY.example/example/widgets", gitboy],
    ["https://gitboy.example/example/widgets.git", gitboy],
    ["git@gitboy.example:example/widgets.git", gitboy],
    ["ssh://git@github.com:2222/example/widgets.git", github],
    ["https://github.com/example/widgets/issues/42#issuecomment-5", github],
  ])("parses %s", (input, expected) => {
    expect(parseRepo(input)).toBe(expected);
  });

  it("rejects malformed references and routes only supported forges", () => {
    expect(() => parseRepo("https://github.com/example")).toThrow("Use owner/name");
    expect(() => providerFor("gitlab.example/example/widgets")).toThrow("Use a github.com or gitboy repository");
  });

  it("uses a supplied default domain only for a bare owner and name", () => {
    expect(parseRepo("example/widgets", "GITBOY.example")).toBe(gitboy);
    expect(parseRepo(`https://${github}.git`, "gitboy.example")).toBe(github);
  });

  it("uses the YAML override, gitboy origin, gitboy remote, GitHub origin and then no repo", async () => {
    const temp = makeTempDir("forge-repo-");
    try {
      const store = path.join(temp.path, "store");
      const project = path.basename(temp.path).toLowerCase();
      const checkout = path.join(temp.path, "checkouts", project);
      mkdirSync(path.join(store, project), { recursive: true });
      mkdirSync(checkout, { recursive: true });
      vi.stubEnv("PROJECTS_DIR", path.dirname(checkout));
      const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { stdio: "ignore" });
      git("init");
      git("remote", "add", "origin", `git@${gitboy.replace("/", ":")}.git`);
      git("remote", "add", "gitboy", "https://gitboy.example/example/moved.git");
      setProjectConfigField(store, project, "issues", "github.com/example/override");
      expect(await repoForProject(project, store)).toBe("github.com/example/override");
      setProjectConfigField(store, project, "issues", "example/short");
      expect(await repoForProject(project, store)).toBe("gitboy.example/example/short");
      setProjectConfigField(store, project, "issues", undefined);
      expect(await repoForProject(project, store)).toBe(gitboy);
      expect(await parseRepoForProject("example/short", project, store)).toBe("gitboy.example/example/short");
      expect(await parseRepoForProject(github, project, store)).toBe(github);
      git("remote", "set-url", "origin", `https://${github}.git`);
      expect(await repoForProject(project, store)).toBe("gitboy.example/example/moved");
      git("remote", "remove", "gitboy");
      expect(await repoForProject(project, store)).toBe(github);
      git("remote", "remove", "origin");
      expect(await repoForProject(project, store)).toBeUndefined();
      expect(await parseRepoForProject("example/widgets", project, store)).toBe(github);
    } finally {
      temp.cleanup();
    }
  });
});
