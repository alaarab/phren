import { createHash } from "node:crypto";
import { readFileSync, watch as watchFs, type FSWatcher } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { logger } from "../logger.js";
import { validateTarget } from "./herdr.js";
import { git, gitRoot } from "./projects.js";
import { BridgeError, errorCode, type Json, targetFromURL } from "./protocol.js";
import { gitRepository } from "./server-pane-routes.js";

export const GIT_WATCH_DEBOUNCE_MS = 1_000;
export const GIT_WATCH_PING_MS = 20_000;
export const GIT_WATCH_POLL_MS = 3_000;
export const GIT_WATCH_GRACE_MS = 30_000;
export const GIT_WATCH_MAX = 16;

export interface GitWatchClient {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  once(event: "close" | "error", listener: () => void): unknown;
}

export interface GitWatchOptions {
  platform?: NodeJS.Platform;
  pollMs?: number;
  debounceMs?: number;
  pingMs?: number;
  graceMs?: number;
  maxWatchers?: number;
  now?: () => number;
}

interface Subscriber {
  client: GitWatchClient;
  ping?: NodeJS.Timeout;
}

interface CheckoutWatcher {
  root: string;
  subscribers: Set<Subscriber>;
  idleSince: number | undefined;
  stopTimer: NodeJS.Timeout | undefined;
  debounceTimer: NodeJS.Timeout | undefined;
  pending: boolean;
  closed: boolean;
  failure?: unknown;
  ready: Promise<void>;
  close: () => void;
}

interface StartedWatch {
  ready: Promise<void>;
  close: () => void;
}

function gitDirectory(root: string): string {
  const dotGit = path.join(root, ".git");
  try {
    const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (link) return path.resolve(root, link[1].trim());
  } catch { return dotGit; }
  return dotGit;
}

function isNoise(name: string): boolean {
  return name === ".git/objects" || name.startsWith(".git/objects/")
    || name === ".git/logs" || name.startsWith(".git/logs/");
}

function startNative(root: string, onChange: () => void, onError: (error: unknown) => void): StartedWatch {
  const handles: FSWatcher[] = [];
  const rootWatch = watchFs(root, { recursive: true }, (_event, filename) => {
    const name = filename;
    if (name && isNoise(name)) return;
    onChange();
  });
  rootWatch.on("error", onError);
  handles.push(rootWatch);
  const gitDir = gitDirectory(root);
  const externalGitDir = gitDir !== path.join(root, ".git");
  try {
    const indexWatch = watchFs(gitDir, (_event, filename) => {
      const name = filename;
      if (name === "index" || name === "HEAD") onChange();
    });
    indexWatch.on("error", onError);
    handles.push(indexWatch);
  } catch (error) {
    if (externalGitDir) {
      for (const handle of handles) handle.close();
      throw error;
    }
  }
  return { ready: Promise.resolve(), close: () => { for (const handle of handles) handle.close(); } };
}

function startPolling(root: string, onChange: () => void, onError: (error: unknown) => void, pollMs: number): StartedWatch {
  let stopped = false, timer: NodeJS.Timeout | undefined, current: string | undefined;
  const read = async () => createHash("sha256")
    .update(await git(root, "--no-optional-locks", "status", "--porcelain=v2", "-z"))
    .digest("hex");
  const tick = async () => {
    if (stopped) return;
    try {
      const next = await read();
      if (current !== undefined && next !== current) onChange();
      current = next;
    } catch (error) {
      stopped = true;
      onError(error);
      return;
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, pollMs);
  };
  const ready = read().then(value => {
    current = value;
    if (!stopped) timer = setTimeout(() => { void tick(); }, pollMs);
  }, error => {
    stopped = true;
    throw error;
  });
  return {
    ready,
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export class GitWatch {
  private readonly watchers = new Map<string, CheckoutWatcher>();
  private closed = false;
  private readonly platform: NodeJS.Platform;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly pingMs: number;
  private readonly graceMs: number;
  private readonly maxWatchers: number;
  private readonly now: () => number;

  constructor(options: GitWatchOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pollMs = options.pollMs ?? GIT_WATCH_POLL_MS;
    this.debounceMs = options.debounceMs ?? GIT_WATCH_DEBOUNCE_MS;
    this.pingMs = options.pingMs ?? GIT_WATCH_PING_MS;
    this.graceMs = options.graceMs ?? GIT_WATCH_GRACE_MS;
    this.maxWatchers = options.maxWatchers ?? GIT_WATCH_MAX;
    this.now = options.now ?? Date.now;
  }

  async stream(client: GitWatchClient, url: URL): Promise<void> {
    try {
      if (this.closed) return;
      const target = targetFromURL(url);
      const pane = await validateTarget(target);
      if (this.closed) return;
      const cwd = await gitRepository(pane, target, url.searchParams.get("child") ?? undefined, url.searchParams.get("worktree") ?? undefined);
      if (this.closed) return;
      await this.watch(client, cwd);
    } catch (error) {
      if (!this.closed) this.fail(client, error);
    }
  }

  async watch(client: GitWatchClient, cwd: string): Promise<void> {
    try {
      if (this.closed) return;
      const root = await gitRoot(cwd);
      if (this.closed) return;
      if (!root) throw new BridgeError(409, "This pane is not in a Git repository.", { code: "git-not-repository" });
      await this.attach(client, root);
    } catch (error) {
      if (!this.closed) this.fail(client, error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const watcher of [...this.watchers.values()]) {
      for (const subscriber of watcher.subscribers) if (subscriber.ping) clearInterval(subscriber.ping);
      watcher.subscribers.clear();
      this.stop(watcher);
    }
  }

  private send(client: GitWatchClient, frame: Json): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    try { client.send(JSON.stringify(frame)); return true; }
    catch { return false; }
  }

  private fail(client: GitWatchClient, error: unknown): void {
    const code = errorCode(error) ?? "git-watch-failed";
    const message = error instanceof Error ? error.message : "This checkout cannot be watched.";
    this.send(client, { type: "error", code, message });
    client.close(1011);
  }

  private failWatcher(watcher: CheckoutWatcher, error: unknown): void {
    if (watcher.closed) return;
    watcher.failure = error;
    const code = errorCode(error) ?? "git-watch-failed";
    const message = error instanceof Error ? error.message : "This checkout cannot be watched.";
    logger.warn("git-watch", `watch failed for ${watcher.root}: ${message}`);
    const subscribers = [...watcher.subscribers];
    watcher.subscribers.clear();
    for (const subscriber of subscribers) {
      if (subscriber.ping) clearInterval(subscriber.ping);
      subscriber.ping = undefined;
      this.send(subscriber.client, { type: "error", code, message });
      try { subscriber.client.close(1011); } catch { continue; }
    }
    this.stop(watcher);
  }

  private async attach(client: GitWatchClient, root: string): Promise<void> {
    if (this.closed || client.readyState !== WebSocket.OPEN) return;
    const watcher = await this.ensure(root);
    if (this.closed || watcher.closed) { this.stop(watcher); return; }
    if (client.readyState !== WebSocket.OPEN) { this.idle(watcher); return; }
    const subscriber: Subscriber = { client };
    watcher.subscribers.add(subscriber);
    watcher.idleSince = undefined;
    if (watcher.stopTimer) { clearTimeout(watcher.stopTimer); watcher.stopTimer = undefined; }
    subscriber.ping = setInterval(() => {
      if (!this.send(client, { type: "ping" })) this.detach(watcher, subscriber);
    }, this.pingMs);
    const leave = () => this.detach(watcher, subscriber);
    client.once("close", leave);
    client.once("error", leave);
  }

  private detach(watcher: CheckoutWatcher, subscriber: Subscriber): void {
    if (!watcher.subscribers.delete(subscriber)) return;
    if (subscriber.ping) clearInterval(subscriber.ping);
    subscriber.ping = undefined;
    this.idle(watcher);
  }

  private idle(watcher: CheckoutWatcher): void {
    if (watcher.subscribers.size || watcher.stopTimer || watcher.closed) return;
    watcher.idleSince = this.now();
    watcher.stopTimer = setTimeout(() => {
      watcher.stopTimer = undefined;
      if (!watcher.subscribers.size) this.stop(watcher);
    }, this.graceMs);
  }

  private async ensure(root: string): Promise<CheckoutWatcher> {
    if (this.closed) throw new BridgeError(503, "The Hook is shutting down.", { code: "git-watch-closed" });
    const existing = this.watchers.get(root);
    if (existing) {
      await existing.ready;
      if (this.closed) throw new BridgeError(503, "The Hook is shutting down.", { code: "git-watch-closed" });
      if (existing.closed) throw this.closedError(existing);
      return existing;
    }
    if (this.watchers.size >= this.maxWatchers) {
      const idle = [...this.watchers.values()]
        .filter(watcher => watcher.subscribers.size === 0 && watcher.idleSince !== undefined)
        .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))[0];
      if (!idle) throw new BridgeError(503, `This Hook is already watching ${this.maxWatchers} checkouts.`, { code: "too-many-watchers" });
      this.stop(idle);
    }
    if (this.closed) throw new BridgeError(503, "The Hook is shutting down.", { code: "git-watch-closed" });
    const watcher = this.create(root);
    this.watchers.set(root, watcher);
    try { await watcher.ready; }
    catch (error) { this.stop(watcher); throw error; }
    if (this.closed) { this.stop(watcher); throw new BridgeError(503, "The Hook is shutting down.", { code: "git-watch-closed" }); }
    if (watcher.closed) { this.stop(watcher); throw this.closedError(watcher); }
    return watcher;
  }

  private closedError(watcher: CheckoutWatcher): BridgeError {
    if (watcher.failure instanceof BridgeError) return watcher.failure;
    const message = watcher.failure instanceof Error ? watcher.failure.message : "This checkout cannot be watched.";
    return new BridgeError(503, message, { code: "git-watch-failed" });
  }

  private create(root: string): CheckoutWatcher {
    const watcher: CheckoutWatcher = {
      root, subscribers: new Set(), idleSince: undefined, stopTimer: undefined,
      debounceTimer: undefined, pending: false, closed: false, failure: undefined,
      ready: Promise.resolve(), close: () => {},
    };
    let started: StartedWatch;
    try {
      started = this.platform === "linux"
        ? startPolling(root, () => this.changed(watcher), error => this.failWatcher(watcher, error), this.pollMs)
        : startNative(root, () => this.changed(watcher), error => this.failWatcher(watcher, error));
    } catch (error) {
      throw new BridgeError(503, "This checkout cannot be watched.", { code: "git-watch-failed", cause: error instanceof Error ? error.message : String(error) });
    }
    watcher.ready = started.ready;
    watcher.close = () => {
      if (watcher.closed) return;
      watcher.closed = true;
      started.close();
      if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
      watcher.debounceTimer = undefined;
    };
    return watcher;
  }

  private changed(watcher: CheckoutWatcher): void {
    if (watcher.closed) return;
    watcher.pending = true;
    if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
    watcher.debounceTimer = setTimeout(() => {
      watcher.debounceTimer = undefined;
      if (!watcher.pending) return;
      watcher.pending = false;
      const at = new Date(this.now()).toISOString();
      for (const subscriber of watcher.subscribers) this.send(subscriber.client, { type: "changed", at });
    }, this.debounceMs);
  }

  private stop(watcher: CheckoutWatcher): void {
    if (this.watchers.get(watcher.root) === watcher) this.watchers.delete(watcher.root);
    if (watcher.stopTimer) { clearTimeout(watcher.stopTimer); watcher.stopTimer = undefined; }
    watcher.close();
  }
}
