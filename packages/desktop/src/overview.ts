import { EventEmitter } from "node:events";
import type { RawData, WebSocket } from "ws";
import type {
  Computer,
  ComputerOverview,
  ComputerState,
  CreateOverviewHub,
  HookOverview,
  MergedOverview,
  OverviewHub,
} from "./contract.js";

const OVERVIEW_PATH = "/v1/overview?watchApprovals=1";
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_MS = 60_000; // a socket open this long resets the backoff
const SILENCE_MS = 45_000; // no frame this long terminates and reconnects
const CHANGE_THROTTLE_MS = 200; // coalesce "change" bursts
const CONNECT_TIMEOUT_MS = 20_000; // a connect that never opens counts as a failure

interface Supervisor {
  computer: Computer;
  state: ComputerState;
  error?: string;
  overview?: HookOverview;
  updatedAt?: string;
  socket?: WebSocket;
  backoffMs: number;
  retryTimer?: NodeJS.Timeout;
  silenceTimer?: NodeJS.Timeout;
  stableTimer?: NodeJS.Timeout;
  stopped: boolean;
}

/** Truncate a possibly multi-line SSH/hook error to a short single line. */
function short(message?: string): string {
  if (!message) return "";
  const line = message.split("\n").find((l) => l.trim()) ?? message;
  return line.trim().slice(0, 200);
}

/** A host-key mismatch is the one failure we cannot retry away. */
function isHostKeyError(message?: string): boolean {
  return !!message && /host key|REMOTE HOST IDENTIFICATION/i.test(message);
}

function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export const createOverviewHub: CreateOverviewHub = (computers, ws) => {
  const emitter = new EventEmitter();
  const supervisors: Supervisor[] = computers.map((computer) => ({
    computer,
    state: "connecting",
    backoffMs: BASE_BACKOFF_MS,
    stopped: false,
  }));

  let started = false;
  let lastEmit = 0;
  let trailing: NodeJS.Timeout | undefined;

  function build(): MergedOverview {
    return {
      computers: supervisors.map((s): ComputerOverview => {
        const row: ComputerOverview = { computer: s.computer.name, state: s.state };
        if (s.error !== undefined) row.error = s.error;
        if (s.overview !== undefined) row.overview = s.overview;
        if (s.updatedAt !== undefined) row.updatedAt = s.updatedAt;
        return row;
      }),
    };
  }

  // Leading-edge emit plus one trailing emit inside the throttle window.
  function scheduleChange(): void {
    const since = Date.now() - lastEmit;
    if (since >= CHANGE_THROTTLE_MS) {
      lastEmit = Date.now();
      emitter.emit("change", build());
      return;
    }
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = undefined;
      lastEmit = Date.now();
      emitter.emit("change", build());
    }, CHANGE_THROTTLE_MS - since);
  }

  function clearTimers(sup: Supervisor): void {
    if (sup.retryTimer) clearTimeout(sup.retryTimer);
    if (sup.silenceTimer) clearTimeout(sup.silenceTimer);
    if (sup.stableTimer) clearTimeout(sup.stableTimer);
    sup.retryTimer = sup.silenceTimer = sup.stableTimer = undefined;
  }

  function touch(sup: Supervisor): void {
    if (!sup.silenceTimer) return;
    clearTimeout(sup.silenceTimer);
    sup.silenceTimer = setTimeout(() => reconnect(sup), SILENCE_MS);
  }

  function onFrame(sup: Supervisor, data: RawData): void {
    touch(sup);
    let frame: unknown;
    try {
      frame = JSON.parse(frameText(data));
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const rec = frame as Record<string, unknown>;
    if (rec.type !== "overview") return; // heartbeat/resources: liveness only
    const overview = { ...rec };
    delete overview.type;
    sup.overview = overview as HookOverview;
    sup.updatedAt = new Date().toISOString();
    sup.state = "online";
    sup.error = undefined;
    scheduleChange();
  }

  function attach(sup: Supervisor, socket: WebSocket): void {
    if (sup.stopped) {
      socket.terminate();
      return;
    }
    sup.socket = socket;
    sup.stableTimer = setTimeout(() => {
      sup.backoffMs = BASE_BACKOFF_MS;
    }, STABLE_MS);
    sup.silenceTimer = setTimeout(() => reconnect(sup), SILENCE_MS);

    const finish = (err?: Error): void => {
      if (sup.socket !== socket) return; // already settled
      sup.socket = undefined;
      clearTimers(sup);
      fail(sup, err);
    };
    socket.on("message", (data: RawData) => onFrame(sup, data));
    socket.on("close", () => finish());
    socket.on("error", (err: Error) => finish(err));
  }

  function fail(sup: Supervisor, err: unknown): void {
    if (sup.stopped) return;
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined;
    if (isHostKeyError(message)) {
      sup.state = "verify";
      sup.error = short(message);
      scheduleChange();
      return; // never reconnect a computer whose host key did not verify
    }
    sup.state = "offline";
    sup.error = short(message) || "disconnected";
    scheduleChange();
    scheduleReconnect(sup);
  }

  function scheduleReconnect(sup: Supervisor): void {
    if (sup.stopped || sup.state === "verify" || sup.retryTimer) return;
    const delay = sup.backoffMs * (0.5 + Math.random() * 0.5); // jittered, half to full
    sup.backoffMs = Math.min(sup.backoffMs * 2, MAX_BACKOFF_MS);
    sup.retryTimer = setTimeout(() => {
      sup.retryTimer = undefined;
      connect(sup);
    }, delay);
  }

  function connect(sup: Supervisor): void {
    if (sup.stopped || sup.state === "verify") return;
    sup.state = "connecting";
    scheduleChange();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      fail(sup, new Error("Timed out connecting to the Hook."));
    }, CONNECT_TIMEOUT_MS);
    const settle = (run: () => void): void => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      run();
    };
    try {
      ws(sup.computer, OVERVIEW_PATH).then(
        (socket) => { if (settled) socket.terminate(); else settle(() => attach(sup, socket)); },
        (err: unknown) => settle(() => fail(sup, err)),
      );
    } catch (err) {
      settle(() => fail(sup, err));
    }
  }

  // A silent socket is terminated; its close handler drives the reconnect.
  function reconnect(sup: Supervisor): void {
    const socket = sup.socket;
    if (socket) socket.terminate();
    else fail(sup, undefined);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      for (const sup of supervisors) connect(sup);
    },
    stop(): void {
      for (const sup of supervisors) {
        sup.stopped = true;
        clearTimers(sup);
        const socket = sup.socket;
        sup.socket = undefined;
        if (socket) socket.terminate();
      }
      if (trailing) {
        clearTimeout(trailing);
        trailing = undefined;
      }
      emitter.removeAllListeners();
    },
    current: build,
    on(event, listener): void {
      emitter.on(event, listener);
    },
  };
};
