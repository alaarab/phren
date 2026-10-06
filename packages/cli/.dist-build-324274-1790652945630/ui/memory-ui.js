import { createWebUiHttpServer, startWebUiServer, } from "./server.js";
import { renderWebUiPage } from "./page.js";
export { renderPageForTests } from "./page.js";
export function createWebUiServer(phrenPath, opts, profile) {
    return createWebUiHttpServer(phrenPath, renderWebUiPage, profile, opts);
}
export async function startWebUi(phrenPath, port, profile, opts) {
    await startWebUiServer(phrenPath, port, renderWebUiPage, profile, opts);
}
