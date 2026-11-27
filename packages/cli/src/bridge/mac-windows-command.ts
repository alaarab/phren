import { macWindowsEnabled, macWindowsLocalPermissionReport, macWindowsSupported, setMacWindowsEnabled, type MacWindowPermissionState } from "./mac-windows.js";

/** A grant's line: a denied permission and a helper that could not build are different problems. */
function permissionLine(state: MacWindowPermissionState): string {
  if (state.granted) return "granted";
  if (state.unavailable) return `helper unavailable: ${state.unavailable}`;
  return "not granted";
}

/**
 * `phren mac-windows on|off|status`: phone control of this Mac's windows is off
 * by default per computer. `status` also checks the two grants the helpers use
 * (Screen Recording for wincap, Accessibility for wininput) and tells a helper
 * that cannot build apart from one that is merely not trusted.
 */
export async function runMacWindows(args: string[]): Promise<number> {
  const verb = args.find(arg => !arg.startsWith("-"));
  if (verb === "on" || verb === "off") {
    try {
      await setMacWindowsEnabled(verb === "on");
    } catch (error) {
      console.error(`Couldn't write the setting: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    console.log(verb === "on"
      ? "Phone control of this Mac's windows is on. Run `phren mac-windows status` to check its permissions."
      : "Phone control of this Mac's windows is off.");
    return 0;
  }
  if (verb === "status" || verb === undefined) {
    const enabled = await macWindowsEnabled();
    console.log(`Mac windows: ${enabled ? "on" : "off"}`);
    if (!macWindowsSupported()) {
      console.log("Permissions: Mac windows need macOS 14 or later.");
      return 0;
    }
    try {
      const report = await macWindowsLocalPermissionReport();
      console.log(`Screen Recording: ${permissionLine(report.screenRecording)}`);
      console.log(`Accessibility: ${permissionLine(report.accessibility)}`);
      const states = [report.screenRecording, report.accessibility];
      if (states.some(state => state.unavailable)) {
        console.log("A helper could not be built or run. They need Xcode's swiftc; then run `phren mac-windows status` again.");
      } else if (states.some(state => !state.granted)) {
        console.log("Grant the missing permission in System Settings → Privacy & Security (Screen Recording and Accessibility), then run `phren mac-windows status` again.");
      }
    } catch (error) {
      console.log(`Permissions: unknown (${error instanceof Error ? error.message : String(error)})`);
    }
    return 0;
  }
  console.error("Usage: phren mac-windows on|off|status");
  return 1;
}
