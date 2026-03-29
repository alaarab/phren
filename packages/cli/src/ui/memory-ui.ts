import {
  createWebUiHttpServer,
  startWebUiServer,
  type WebUiOptions,
  type WebUiStartOptions,
} from "./server.js";
import { renderWebUiPage } from "./page.js";

export { renderPageForTests } from "./page.js";

export function createWebUiServer(phrenPath: string, opts?: WebUiOptions, profile?: string) {
  return createWebUiHttpServer(phrenPath, renderWebUiPage, profile, opts);
}

export async function startWebUi(phrenPath: string, port: number, profile?: string, opts?: WebUiStartOptions): Promise<void> {
  await startWebUiServer(phrenPath, port, renderWebUiPage, profile, opts);
}
