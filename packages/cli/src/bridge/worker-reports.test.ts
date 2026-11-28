import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeDispatchIssue } from "./dispatch-issue.js";
import { paneIdentity, snapshot, validateTarget } from "./herdr.js";
import type { Target } from "./protocol.js";
import { noteTurn } from "./turn-records.js";
import { reportWorker, workerPrs } from "./worker-reports.js";

const gh = vi.hoisted(() => vi.fn<(args: string[], options: { input?: string }) => Promise<{ stdout: string; stderr: string }>>());
vi.mock("./probe-processes.js", async original => {
  const actual = await original<typeof import("./probe-processes.js")>();
  return { ...actual, execProbe: (file: string, args: string[], options: { input?: string }) =>
    file === "gh" ? gh(args, options) : actual.execProbe(file, args, options) };
});
vi.mock("./herdr.js", async original => ({
  ...await original<typeof import("./herdr.js")>(), paneIdentity: vi.fn(), snapshot: vi.fn(), validateTarget: vi.fn(),
}));

const fetchForge = vi.fn<typeof fetch>();
const dispatch = "70000000-0000-4000-8000-000000000001";
const terminal = "terminal-worker";
const origin = { server: "default", workspace: "w1", tab: "t1", pane: "p1" };
const target: Target = { ...origin, source: "codex", session: "70000000-0000-4000-8000-000000000002" };
const githubIssue = { repo: "github.com/example/widgets", number: 42 };
const gitboyIssue = { repo: "gitboy.example/example/widgets", number: 42 };
const pull = (number: number) => ({ url: `https://github.com/example/widgets/pull/${number}`, repo: "example/widgets",
  branch: "feat/fix", tests: "fixture evidence", notes: "local report details" });

const issueData = { number: 42, index: 42, title: "Report evidence", state: "open" };
const githubRead = { stdout: JSON.stringify(issueData), stderr: "" };
const githubComment = { stdout: '{"id":1}', stderr: "" };
const postedComments = () => gh.mock.calls.filter(([args]) => args[5] === "POST");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-issue-report-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.stubEnv("GITBOY_HOST", "gitboy.example");
  vi.stubEnv("GITBOY_TOKEN", "fixture-token");
  vi.stubGlobal("fetch", fetchForge);
  gh.mockReset().mockRejectedValue(new Error("Unexpected gh request"));
  fetchForge.mockReset().mockRejectedValue(new Error("Unexpected forge HTTP request"));
  const pane = { pane_id: origin.pane, workspace_id: origin.workspace, tab_id: origin.tab, terminal_id: terminal, agent: target.source };
  vi.mocked(snapshot).mockResolvedValue({ panes: [pane] });
  vi.mocked(paneIdentity).mockResolvedValue(target.session);
  vi.mocked(validateTarget).mockResolvedValue(pane);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

const submit = (id?: string) => noteTurn(target.server, target.pane, {
  event: "UserPromptSubmit", source: target.source, session: target.session, terminal, ...(id ? { dispatch: id } : {}),
});

it("posts each reported PR on the dispatched issue once across concurrent and repeated reports", async () => {
  await writeDispatchIssue(dispatch, githubIssue);
  const turn = (await submit(dispatch))!;
  gh.mockImplementation(async (args) => args[5] === "GET" ? githubRead : githubComment);
  const first = pull(7);
  const second = pull(8);
  const prs = [first, second];
  const data = { origin, prs };
  const responses = await Promise.all([reportWorker(data), reportWorker(data)]);
  for (const response of responses) expect(response).toMatchObject({ ok: true, issueLinks: { linked: true } });
  expect(await reportWorker({ ...data, prs: [{ ...first, url: `${first.url}?tab=files#diff` }, second] }))
    .toMatchObject({ ok: true, issueLinks: { linked: true } });
  expect(postedComments()).toHaveLength(2);
  expect(postedComments().map(([args, options]) => [args[1], args[5], JSON.parse(options.input ?? "")]))
    .toEqual(expect.arrayContaining(prs.map(pr => ["repos/example/widgets/issues/42/comments", "POST", { body: `PR ${pr.url}` }])));
  expect(await workerPrs(target, turn)).toMatchObject([{ ...first, url: `${first.url}?tab=files#diff` }, second]);
  expect(fetchForge).not.toHaveBeenCalled();
});

it("links an explicit gitboy issue and leaves unbound reports forge-free", async () => {
  await submit();
  const pr = pull(7);
  const data = { origin, prs: [pr] };
  expect(await reportWorker(data)).toMatchObject({ ok: true, issueLinks: { linked: false } });
  expect(fetchForge).not.toHaveBeenCalled();
  expect(gh).not.toHaveBeenCalled();
  fetchForge.mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { id: "comment-1" } : issueData));
  expect(await reportWorker({ ...data, issue: `${gitboyIssue.repo}#42` })).toMatchObject({ ok: true, issueLinks: { linked: true } });
  expect(fetchForge).toHaveBeenCalledTimes(2);
  expect(fetchForge).toHaveBeenCalledWith(
    "https://gitboy.example/api/v1/repos/example/widgets/issues/42/comments",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ body: `PR ${pr.url}` }) }),
  );
});

it("retries definite refusals and keeps an ambiguous comment from being sent twice", async () => {
  await submit();
  const data = { origin, prs: [pull(7)], issue: githubIssue };
  gh.mockResolvedValueOnce(githubRead).mockRejectedValueOnce(Object.assign(new Error("fixture"), { stderr: "gh: denied (HTTP 403)" }));
  expect(await reportWorker(data)).toMatchObject({ ok: true, issueLinks: { linked: false, error: expect.stringContaining("denied") } });
  gh.mockResolvedValueOnce(githubRead).mockResolvedValueOnce(githubComment);
  expect(await reportWorker(data)).toMatchObject({ ok: true, issueLinks: { linked: true } });
  const uncertain = { ...data, prs: [pull(8), pull(9)] };
  gh.mockImplementation(async (args, options) => {
    if (args[5] === "GET") return githubRead;
    if (options.input?.includes("/pull/8")) throw new Error("Lost reply");
    return { stdout: '{"id":2}', stderr: "" };
  });
  expect(await reportWorker(uncertain)).toMatchObject({ ok: true, issueLinks: { linked: false, error: expect.stringContaining("did not confirm") } });
  expect(await reportWorker(uncertain)).toMatchObject({ ok: true, issueLinks: { linked: false, error: expect.stringContaining("may already have received") } });
  expect(postedComments()).toHaveLength(4);
});
