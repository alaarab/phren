// Updates from the repository's latest GitHub release, through the
// latest-mac.yml / latest-linux.yml files electron-builder publishes there.
// The AppImage downloads an update and installs it on restart. macOS installs
// only an update signed with a Developer ID (Squirrel.Mac checks), so an
// unsigned build offers the release page instead.
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

export async function startUpdates({ app, dialog, shell, parentWindow }) {
  if (!app.isPackaged || process.env.PHREN_DESKTOP_UPDATES === "off") return;
  if (process.platform === "linux" && !process.env.APPIMAGE) return;
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const install = process.platform === "linux" || (await developerIdSigned());
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = install;
  autoUpdater.autoInstallOnAppQuit = install;
  let offered = null;

  const ask = (options) => {
    const win = parentWindow();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };

  autoUpdater.on("update-available", async (info) => {
    if (install || offered === info.version) return;
    offered = info.version;
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
