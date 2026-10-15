import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../ui/api.js", async original => ({ ...await original<object>(), hookPost: hooks.post }));
vi.mock("../ui/shown.js", () => ({ isShown: () => true, watchShown: () => () => {} }));
vi.mock("../ui/shell/merge-when-green.js", () => ({ onArmedChange: () => () => {}, isArmed: () => false }));
import { openChanges } from "../ui/changes.js";

// Only the DOM operations used to draw the real Changes view; requests and
// refresh ordering remain under the production controller.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = ""; textContent = ""; value = "";
  onclick?: () => void; oninput?: () => void;
  constructor(public tagName = "DIV") {}
  set innerHTML(_value: string) { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); return child; }
  setAttribute() {}
  querySelector() { return null; }
  contains() { return false; }
  addEventListener() {}
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetAllMocks(); });

it("submits the host shown by the visible Connect card while a refresh has newer host data", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag.toUpperCase()), getElementById: () => true, activeElement: null, visibilityState: "visible" });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const hostA = { kind: "gitlab", name: "GitLab", domain: "gitlab.example.com", apiHost: "api-a.example", supported: true };
  const hostB = { ...hostA, apiHost: "api-b.example" };
  let shownHost = hostA;
  let finishStatus: ((value: unknown) => void) | undefined;
  let holdStatus = false;
  const status = { repository: "/repo", branch: "feature", files: [] };
  hooks.post.mockImplementation(async (_computer, route) => {
    if (route === "/v1/git/status") return holdStatus ? new Promise(resolve => { finishStatus = resolve; }) : status;
    if (route === "/v1/git/pulls") return { host: shownHost, available: false, reason: "auth" };
    if (route === "/v1/git/host-token") return { ok: false, reason: "auth" };
    return {};
  });
  const root = new Element();
  const view = openChanges(root, { computer: "Desk", child: { target: { source: "claude", session: "chat" } } });
  try {
    await vi.advanceTimersByTimeAsync(0);
    view.showView("pulls");
    await vi.advanceTimersByTimeAsync(0);
    expect(root.all().some(node => node.textContent === "Sends the token to api-a.example")).toBe(true);
    const input = root.all().find(node => node.tagName === "INPUT")!;
    input.value = "private-token"; input.oninput!();
    const connect = root.all().find(node => node.textContent === "Connect")!;
    shownHost = hostB;
    holdStatus = true;
    const refreshing = view.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(finishStatus).toBeDefined();
    // The old card is still visible while /status is pending, although /pulls
    // has already replaced the controller's mutable host with B.
    connect.onclick!();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.post.mock.calls.find(([, route]) => route === "/v1/git/host-token")?.[2])
      .toMatchObject({ token: "private-token", expectedHost: "api-a.example" });
    finishStatus!(status); await refreshing;
  } finally { view.close(); }
});
