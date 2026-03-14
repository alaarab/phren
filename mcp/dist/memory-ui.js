import { createWebUiHttpServer, startWebUiServer, } from "./memory-ui-server.js";
import { renderWebUiPage } from "./memory-ui-page.js";
export { renderPageForTests } from "./memory-ui-page.js";
export function createWebUiServer(phrenPath, opts, profile) {
    return createWebUiHttpServer(phrenPath, renderWebUiPage, profile, opts);
}
export async function startWebUi(phrenPath, port, profile, opts) {
    await startWebUiServer(phrenPath, port, renderWebUiPage, profile, opts);
}
