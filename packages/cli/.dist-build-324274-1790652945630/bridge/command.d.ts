import { type Json } from "./protocol.js";
export declare function runBridge(args: string[], version: string): Promise<number>;
/** Doctor's push check, from the running Hook's own capability: a Hook that
 * loaded apns.json and its key, or one whose phones registered through the
 * push relay, offers `approvalPush`. */
export declare function approvalPushCheck(helper: Json): {
    configured: boolean;
    warning?: string;
};
