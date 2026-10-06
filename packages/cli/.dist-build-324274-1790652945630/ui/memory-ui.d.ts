import { type WebUiOptions, type WebUiStartOptions } from "./server.js";
export { renderPageForTests } from "./page.js";
export declare function createWebUiServer(phrenPath: string, opts?: WebUiOptions, profile?: string): import("node:http").Server<typeof import("node:http").IncomingMessage, typeof import("node:http").ServerResponse>;
export declare function startWebUi(phrenPath: string, port: number, profile?: string, opts?: WebUiStartOptions): Promise<void>;
