/**
 * Vitest globalSetup — runs once in the main process before any test workers spawn.
 *
 * Builds mcp/dist if it is missing so every fork sees a complete, consistent
 * dist artifact before tests begin. Individual subprocess helpers can still
 * repair a missing artifact later under a lock if some test mutates dist.
 *
 * `pretest` in package.json already calls `npm run build`, so in normal `npm test`
 * runs this is a fast no-op check. It is the safety net for:
 *   - `vitest run` called directly (no pretest hook)
 *   - Watch mode re-runs where pretest does not re-fire
 *   - CI environments that skip npm lifecycle scripts
 */
export declare function teardown(): Promise<void>;
export declare function setup(): Promise<void>;
