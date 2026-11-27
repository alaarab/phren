import { macWindowPermissions, macWindowsEnabled, setMacWindowsEnabled } from "./mac-windows.js";

/**
 * `phren mac-windows on|off|status`: phone control of this Mac's windows is off
 * by default per computer. `status` also runs the two permission checks the
 * helpers use (Screen Recording for wincap, Accessibility for wininput).
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
    if (process.platform !== "darwin") {
      console.log("Permissions: macOS only.");
      return 0;
    }
    try {
      const permissions = await macWindowPermissions();
      console.log(`Screen Recording: ${permissions.screenRecording ? "granted" : "not granted"}`);
      console.log(`Accessibility: ${permissions.accessibility ? "granted" : "not granted"}`);
      if (!permissions.screenRecording || !permissions.accessibility) {
        console.log("Grant them in System Settings → Privacy & Security (Screen Recording and Accessibility), then run `phren mac-windows status` again.");
      }
    } catch (error) {
      console.log(`Permissions: unknown (${error instanceof Error ? error.message : String(error)})`);
    }
    return 0;
  }
  console.error("Usage: phren mac-windows on|off|status");
  return 1;
}
