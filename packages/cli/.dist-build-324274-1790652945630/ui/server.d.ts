import * as http from "http";
export interface WebUiOptions {
    authToken?: string;
    csrfTokens?: Map<string, number>;
}
export interface WebUiStartOptions {
    autoOpen?: boolean;
    allowPortFallback?: boolean;
    browserLauncher?: (url: string) => Promise<void> | void;
}
export declare function getWebUiBrowserCommand(url: string, platform?: NodeJS.Platform): {
    command: string;
    args: string[];
};
export declare function waitForWebUiReady(url: string, attempts?: number, delayMs?: number): Promise<boolean>;
export declare function createWebUiHttpServer(phrenPath: string, renderPage: (phrenPath: string, authToken?: string, nonce?: string) => string, profile?: string, opts?: WebUiOptions): http.Server;
export declare function startWebUiServer(phrenPath: string, port: number, renderPage: (phrenPath: string, authToken?: string, nonce?: string) => string, profile?: string, opts?: WebUiStartOptions): Promise<void>;
