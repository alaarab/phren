// Updates from the repository's latest GitHub release, through the
// latest-mac.yml / latest-linux.yml / latest.yml files electron-builder
// publishes there. The AppImage and the Windows (NSIS) install download an
// update and install it on restart. macOS installs
// only an update signed with a Developer ID (Squirrel.Mac checks), so an
// unsigned build offers the release page instead. With a window open the
// offer is the titlebar's update chip (`showInUi`), with the release notes
// (packages/desktop/CHANGELOG.md's section) as What's new; without one, a dialog.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const RELEASES = "https://github.com/alaarab/phren/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function developerIdSigned() {
  if (process.platform !== "darwin") return Promise.resolve(false);
  const bundle = path.resolve(process.execPath, "../../..");
  return new Promise((resolve) => {
    execFile("codesign", ["-dv", "--verbose=2", bundle], (err, _stdout, stderr) => {
      resolve(!err && /Authority=Developer ID Application/.test(String(stderr)));
    });
  });
}

/** The release notes as plain lines: electron-updater hands over the GitHub
 * release body as HTML (or a list of notes); tags, the install line and blanks go. */
export function noteLines(notes) {
  const text = Array.isArray(notes) ? notes.map((n) => n?.note ?? "").join("\n") : String(notes ?? "");
  return text
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|h\d|ul|ol)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Install:/i.test(line))
    .slice(0, 12);
}

let applyUpdate = () => {};

/** The update chip's button: "restart" installs a downloaded update, "download" opens the release page. */
export function runUpdateAction(kind) { applyUpdate(kind); }

export async function startUpdates({ app, dialog, shell, parentWindow, showInUi = () => false }) {
  if (!app.isPackaged || process.env.PHREN_DESKTOP_UPDATES === "off") return;
  if (process.platform === "linux" && !process.env.APPIMAGE) return;
  if (!["linux", "darwin", "win32"].includes(process.platform)) return;
  // NSIS checks a signature only when the build names a publisher, which an unsigned one does not.
  const install = process.platform === "linux" || process.platform === "win32" || (await developerIdSigned());
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = install;
  autoUpdater.autoInstallOnAppQuit = install;
  let offered = null;
  applyUpdate = (kind) => {
    if (kind === "restart" && install) autoUpdater.quitAndInstall();
    else if (kind === "download") shell.openExternal(RELEASES);
  };

  const ask = (options) => {
    const win = parentWindow();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };

  autoUpdater.on("update-available", async (info) => {
    if (install || offered === info.version) return;
    offered = info.version;
    if (showInUi({ version: info.version, current: app.getVersion(), notes: noteLines(info.releaseNotes), action: "download" })) return;
    const { response } = await ask({
      type: "info",
      message: `Phren ${info.version} is available`,
      detail: `You have ${app.getVersion()}. This build cannot update itself; download the new one from GitHub.`,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(RELEASES);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    if (offered === info.version) return;
    offered = info.version;
    if (showInUi({ version: info.version, current: app.getVersion(), notes: noteLines(info.releaseNotes), action: "restart" })) return;
    const { response } = await ask({
      type: "info",
      message: `Phren ${info.version} is ready`,
      detail: "Restart to update now, or it installs the next time you quit.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("error", (err) => console.error(`Update check failed: ${err?.message ?? err}`));

  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, CHECK_EVERY_MS).unref?.();
}
