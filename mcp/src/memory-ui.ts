import {
  createReviewUiHttpServer,
  startReviewUiServer,
  type ReviewUiOptions,
} from "./memory-ui-server.js";
import { renderReviewUiPage } from "./memory-ui-page.js";

export { renderPageForTests } from "./memory-ui-page.js";

export function createReviewUiServer(cortexPath: string, opts?: ReviewUiOptions, profile?: string) {
  return createReviewUiHttpServer(cortexPath, renderReviewUiPage, profile, opts);
}

export async function startReviewUi(cortexPath: string, port: number, profile?: string): Promise<void> {
  await startReviewUiServer(cortexPath, port, renderReviewUiPage, profile);
}
