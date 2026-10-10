// Electron 44 shell: spawn the daemon on the system Node (native node-pty is
// built for Node, not Electron) and show its UI in a BrowserWindow.
import { app, BrowserWindow, Menu, Notification, ipcMain, session, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.resolve(here, "../dist/src/main.js");
const urlPattern = /^Phren desktop: (http:\/\/(?:localhost|127\.0\.0\.1):\d+\/\?token=[0-9a-f]+)$/;

let mainWindow = null;
let daemon = null;
let daemonExited = false;
let daemonStderr = "";
let quitting = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function errorPage(reason, detail) {
  const pre = detail
    ? `<pre style="white-space:pre-wrap;word-break:break-word;background:#141618;padding:16px;border-radius:10px;font:12px ui-monospace,Menlo,monospace">${escapeHtml(detail)}</pre>`
    : "";
  const html = `<!doctype html><meta charset="utf-8"><title>Phren could not start</title>` +
    `<body style="margin:0;background:#1E1E1E;color:#ECEDEE;font-family:system-ui,-apple-system,sans-serif;padding:32px">` +
    `<h1 style="font-size:20px;margin:0 0 12px">Phren could not start</h1>` +
    `<p style="margin:0 0 16px;color:#A4A9B1">${escapeHtml(reason)}</p>${pre}</body>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function baseWindowOptions() {
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#1E1E1E",
    show: false,
    title: "Phren",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } }
      : {}),
  };
}

function showOnReady(win) {
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  return win;
}

function sameOrigin(candidate, origin) {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

/** Subframes may only navigate within the app's localhost family or to about:blank. */
function allowedSubframe(target, port) {
  if (target === "about:blank") return true;
  try {
    const parsed = new URL(target);
    return (
      parsed.protocol === "http:" &&
      parsed.port === port &&
      (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost"))
    );
  } catch {
    return false;
  }
}

function createWindow(url) {
  const win = new BrowserWindow({
    ...baseWindowOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, "preload.cjs"),
    },
  });
  const origin = new URL(url).origin;
  const port = new URL(url).port;
  win.webContents.on("will-navigate", (details) => {
    if (!sameOrigin(details.url, origin)) details.preventDefault();
  });
  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) {
      if (!sameOrigin(details.url, origin)) details.preventDefault();
    } else if (!sameOrigin(details.url, origin) && !allowedSubframe(details.url, port)) {
      details.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler((details) => {
    const referrer = details.referrer && details.referrer.url;
    if (/^https?:\/\//.test(details.url) && referrer && sameOrigin(referrer, origin)) {
      shell.openExternal(details.url);
    }
    return { action: "deny" };
  });
  win.loadURL(url);
  return showOnReady(win);
}

function createErrorWindow(reason, detail) {
  const win = new BrowserWindow(baseWindowOptions());
  win.loadURL(errorPage(reason, detail));
  return showOnReady(win);
}

function showErrorInWindow(reason, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(errorPage(reason, detail));
}

function findNode() {
  if (process.env.PHREN_NODE) return Promise.resolve(process.env.PHREN_NODE);
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    path.join(homedir(), ".local/share/mise/shims/node"),
    path.join(homedir(), ".volta/bin/node"),
    "/usr/bin/node",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) return Promise.resolve(found);
  return loginShellNode();
}

function loginShellNode() {
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lc", "command -v node"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const first = out.split("\n").map((s) => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

/** An app started from the Dock gets a bare PATH; the daemon still needs ssh,
 * herdr and tmux, so put node's own folder and the usual tool folders first. */
function daemonPath_(nodePath) {
  const extra = [path.dirname(nodePath), "/opt/homebrew/bin", "/usr/local/bin", path.join(homedir(), ".local/bin"), "/usr/bin", "/bin"];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...extra, ...current])].join(path.delimiter);
}

function spawnDaemon(nodePath) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(24).toString("hex");
    const child = spawn(nodePath, [daemonPath], {
      env: {
        ...process.env,
        PATH: daemonPath_(nodePath),
        PHREN_DESKTOP_PORT: "0",
        // The token goes over fd 3 (pipe), never the environment, so a child
        // process cannot read it by dumping env.
        PHREN_DESKTOP_TOKEN_FD: "3",
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    daemon = child;
    child.stdio[3]?.end(token);
    daemonStderr = "";
    let settled = false;
    let buffer = "";
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(reason);
    };
    const timer = setTimeout(() => fail(new Error("Timed out after 20 s waiting for the daemon")), 20000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        const match = line.match(urlPattern);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(match[1]);
        }
      }
    });
    // Keep only the tail for the error page.
    child.stderr.on("data", (chunk) => {
      daemonStderr = (daemonStderr + chunk).slice(-4096);
    });
    child.on("error", (err) => fail(err));
    child.on("exit", (code) => {
      daemonExited = true;
      if (!settled) {
        fail(new Error(`The daemon exited before it was ready (code ${code ?? "unknown"})`));
      } else if (!quitting) {
        showErrorInWindow("The daemon stopped.", daemonStderr);
      }
    });
  });
}

function killDaemon() {
  if (!daemon || daemonExited) return;
  try {
    daemon.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    if (!daemonExited) {
      try {
        daemon.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 3000);
  timer.unref?.();
}

function buildMenu() {
  const template = [];
  if (process.platform === "darwin") template.push({ role: "appMenu" });
  template.push({ role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  const fromMainWindow = (event) =>
    mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
  ipcMain.on("phren:badge", (event, n) => {
    if (!fromMainWindow(event) || !Number.isInteger(n) || n < 0 || n > 999) return;
    app.setBadgeCount(n);
  });
  ipcMain.on("phren:notify", (event, payload) => {
    if (!fromMainWindow(event)) return;
    const title = String(payload?.title ?? "").slice(0, 120);
    const body = String(payload?.body ?? "").slice(0, 300);
    const note = new Notification({ title, body });
    note.on("click", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    note.show();
  });
}

/** Only the app's own loopback origin (localhost or 127.0.0.1 at its port) is
 * trusted for permissions; every *.localhost subdomain is not. */
function isAppPermissionOrigin(candidate, port) {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.port === port
    );
  } catch {
    return false;
  }
}

function registerPermissions(port) {
  const granted = (permission) => permission === "notifications" || permission === "clipboard-sanitized-write";
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(granted(permission) && isAppPermissionOrigin(details?.requestingUrl ?? "", port));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return granted(permission) && isAppPermissionOrigin(requestingOrigin, port);
  });
}

async function start() {
  const nodePath = await findNode();
  if (!nodePath) {
    createErrorWindow("Node.js was not found. Install Node or set PHREN_NODE.", "");
    return;
  }
  try {
    const url = await spawnDaemon(nodePath);
    registerPermissions(new URL(url).port);
    createWindow(url);
  } catch (err) {
    createErrorWindow(err.message, daemonStderr);
    daemon = null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    killDaemon();
  });
  app.whenReady().then(() => {
    buildMenu();
    registerIpc();
    start();
  });
}
