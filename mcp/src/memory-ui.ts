import {
  createWebUiHttpServer,
  startWebUiServer,
  type WebUiOptions,
  type WebUiStartOptions,
} from "./memory-ui-server.js";
import { renderWebUiPage } from "./memory-ui-page.js";

export { renderPageForTests } from "./memory-ui-page.js";

export function createWebUiServer(cortexPath: string, opts?: WebUiOptions, profile?: string) {
  return createWebUiHttpServer(cortexPath, renderWebUiPage, profile, opts);
}

export async function startWebUi(cortexPath: string, port: number, profile?: string, opts?: WebUiStartOptions): Promise<void> {
  await startWebUiServer(cortexPath, port, renderWebUiPage, profile, opts);
}
