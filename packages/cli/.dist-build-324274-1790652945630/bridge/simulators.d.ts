import { type Json } from "./protocol.js";
/** The iOS simulators booted on this Mac, from `simctl`; none elsewhere. */
export declare function bootedSimulators(): Promise<Json[]>;
/** A PNG of one booted simulator's screen. */
export declare function simulatorScreenshot(udid: string): Promise<Buffer>;
/** What the phone may ask a simulator to do. Boot, shutdown, launch and
 * URL go through simctl; touches and keys go through the Simulator app's
 * window with UI scripting, which needs Accessibility for the Hook's node. */
export type SimulatorAction = {
    action: "boot" | "shutdown" | "home" | "lock" | "screenshot-ready";
} | {
    action: "launch";
    bundleId: string;
} | {
    action: "openurl";
    url: string;
} | {
    action: "tap";
    x: number;
    y: number;
} | {
    action: "type";
    text: string;
    submit?: boolean;
};
export declare function simulatorAct(udid: string, request: SimulatorAction): Promise<Json>;
/** The apps a simulator has, for the launcher. */
export declare function simulatorApps(udid: string): Promise<Json[]>;
