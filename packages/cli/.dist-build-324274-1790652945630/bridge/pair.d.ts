export declare const PAIR_PORT = 47291;
export declare function newPairingCode(): string;
/** Codes are typed as ABC-234 or abc234; both mean the same code. */
export declare function normalizeCode(code: string): string;
export declare function pairingProof(code: string, label: "phone" | "computer", ...parts: string[]): string;
/** OpenSSH's SHA256 fingerprint of a public key line, as the phone computes it. */
export declare function keyFingerprint(publicKeyLine: string): string | undefined;
export declare function hostFingerprint(file?: string): Promise<string | undefined>;
/** Addresses the phone can try, best first: Tailscale name and address, then LAN IPv4. */
export declare function pairingHosts(): Promise<string[]>;
/** The name people call this computer: macOS's Computer Name, else the host name. */
export declare function computerDisplayName(): Promise<string>;
export interface PairingOffer {
    hosts: string[];
    port: number;
    user: string;
    sshPort: number;
    fingerprint?: string;
    code: string;
    name: string;
}
/** The QR payload; the phone opens phren://pair links from the camera too. */
export declare function pairingURL(offer: PairingOffer): string;
export interface Paired {
    device: "ios" | "android";
    name?: string;
    publicKey: string;
}
export interface PairingSession {
    port: number;
    done: Promise<Paired>;
    close(): void;
}
/** Listen for one phone. Resolves once its key is authorized; rejects on timeout or too many bad proofs. */
export declare function startPairing(options: {
    code: string;
    user: string;
    sshPort: number;
    fingerprint?: string;
    name: string;
    port?: number;
    timeoutMs?: number;
    sshDirectory?: string;
}): Promise<PairingSession>;
export declare const PAIR_USAGE = "phren pair [--minutes <1-30>] [--port <n>] [--no-install]";
export declare function runPair(args: string[], version: string): Promise<number>;
