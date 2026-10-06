import { z } from "zod";
import { type RequestKind } from "./approval-summary.js";
/** A phone registered through the phren push relay: the relay knows where to
 * deliver, and `key` (32 bytes, base64url) encrypts what the notification says
 * so only the phone reads it. The phone made the key and sent it over SSH. */
declare const relaySchema: z.ZodObject<{
    url: z.ZodString;
    relayId: z.ZodString;
    secret: z.ZodString;
    key: z.ZodString;
}, z.core.$strip>;
declare const deviceSchema: z.ZodObject<{
    deviceID: z.ZodString;
    hostID: z.ZodString;
    token: z.ZodOptional<z.ZodString>;
    relay: z.ZodOptional<z.ZodObject<{
        url: z.ZodString;
        relayId: z.ZodString;
        secret: z.ZodString;
        key: z.ZodString;
    }, z.core.$strip>>;
    environment: z.ZodEnum<{
        development: "development";
        production: "production";
    }>;
    kinds: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        approval: "approval";
        scheduleBlocked: "scheduleBlocked";
        scheduleFailed: "scheduleFailed";
        scheduleFinished: "scheduleFinished";
        scheduleStarted: "scheduleStarted";
    }>>>;
}, z.core.$strip>;
export type PushDevice = z.infer<typeof deviceSchema>;
export interface ApprovalPush {
    binding: string;
    provider: string;
    question: boolean;
    expiresAt: string;
    project?: string;
    computer?: string;
    request?: string;
    requestKind?: RequestKind;
}
export interface FanoutBlockedPush {
    job: string;
    label: string;
    provider: string;
    reason: string;
}
export type SchedulePushKind = "scheduleStarted" | "scheduleFinished" | "scheduleFailed" | "scheduleBlocked";
export interface SchedulePush {
    kind: SchedulePushKind;
    scheduleId: string;
    project: string;
    name: string;
    computer: string;
    runId: string;
    status: "running" | "finished" | "needs-you" | "failed" | "blocked";
    reason?: string;
    route?: string;
}
export interface SchedulePushResult {
    notified: boolean;
    reason?: string;
}
export declare function scheduleCollapseId(kind: SchedulePushKind, runId: string): string;
export declare function approvalPushPayload(value: ApprovalPush, host?: string): Record<string, unknown>;
export declare function fanoutBlockedPushPayload(value: FanoutBlockedPush): Record<string, unknown>;
export declare function schedulePushPayload(value: SchedulePush): Record<string, unknown>;
/** What `phren bridge doctor` prints when the Hook has no APNs sender. */
export declare function apnsSetupSteps(configFile?: string): string;
/** The capability a phone reads: a Hook with its own APNs key sends direct;
 * one whose phones registered through the relay sends through it. */
export declare function approvalPushCapability(status: {
    configured: boolean;
    direct?: boolean;
}): "direct-apns" | "relay" | undefined;
export declare function upsertPushDevice(devices: PushDevice[], value: unknown): PushDevice[];
/** The relay refuses ciphertext longer than this (it keeps the APNs payload under 4 KB). */
export declare const RELAY_MAX_CIPHERTEXT = 2800;
/** What the phone's notification extension shows, encrypted with the phone's
 * key: ChaCha20-Poly1305, base64url of nonce (12) + ciphertext + tag (16), the
 * layout CryptoKit's `ChaChaPoly.SealedBox(combined:)` reads. A long body is
 * shortened until it fits the relay's limit. */
export declare function relayCiphertext(key: string, payload: Record<string, unknown>, nonce?: NonSharedBuffer): string;
/** Signs a relay send: base64url HMAC-SHA256 of `${timestamp}.${body}` under the phone's send secret. */
export declare function relaySignature(secret: string, timestamp: string, body: string): string;
type RelayRegistration = z.infer<typeof relaySchema>;
/** "gone" means the relay (Apple) no longer knows the phone: stop sending until it registers again. */
export type RelayResult = "sent" | "failed" | "gone";
export declare function sendThroughRelay(relay: RelayRegistration, payload: Record<string, unknown>, headers: {
    expiration: string;
    collapseId: string;
}, fetcher?: typeof fetch, now?: () => number): Promise<RelayResult>;
/** Direct Hook -> APNs delivery. Apple receives only a short-lived opaque
 * binding; conversation identity, action id, command and SSH key stay local. */
export declare class ApprovalPushService {
    private devices;
    private sender?;
    private readonly devicesFile;
    start(): Promise<void>;
    /** Phones this Hook can reach: through the relay, or direct with its own key. */
    private get reachable();
    get available(): boolean;
    get status(): {
        supported: boolean;
        configured: boolean;
        direct: boolean;
        devices: number;
        relay: number;
    };
    register(value: unknown): Promise<void>;
    /** One phone: the relay when it registered through one, otherwise direct. */
    private send;
    notify(value: ApprovalPush): Promise<boolean>;
    /** A headless worker whose permission the plugin refused. Approval-registered
     * phones already accept agent alerts; the payload carries the reason so the
     * notification is actionable on its own. */
    notifyFanoutBlocked(value: FanoutBlockedPush): Promise<boolean>;
    notifySchedule(value: SchedulePush): Promise<SchedulePushResult>;
}
export {};
