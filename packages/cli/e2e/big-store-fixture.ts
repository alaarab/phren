import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A realistic, sizeable set of services that reference each other, so the
// knowledge graph forms cross-project edges and spreads out (instead of the
// pathological tight clusters a trivial fixture produces).
export const BIG_STORE_PROJECTS = [
  "api-gateway",
  "auth-service",
  "web-frontend",
  "mobile-app",
  "data-pipeline",
  "billing-service",
  "search-service",
  "notifications",
  "infra-platform",
  "ml-platform",
];

const TAGS = ["decision", "pitfall", "pattern", "tradeoff", "architecture", "bug"];

const TOPICS = [
  "redis caching", "jwt authentication", "rate limiting", "database indexing",
  "retry with backoff", "circuit breaker", "schema migration", "feature flags",
  "distributed tracing", "queue backpressure", "connection pooling", "cursor pagination",
  "idempotency keys", "webhook delivery", "token rotation", "horizontal sharding",
  "cold start latency", "memory leak", "deadlock detection", "timeout tuning",
];

const DETAIL: Record<string, string> = {
  "redis caching": "cache hot keys with a 300s TTL and stampede protection",
  "jwt authentication": "verify RS256 tokens at the edge and refresh on rotation",
  "rate limiting": "use a sliding-window counter keyed by tenant and route",
  "database indexing": "add a partial index on status to avoid full table scans",
  "retry with backoff": "exponential backoff with jitter, capped at five attempts",
  "circuit breaker": "open after five consecutive failures, half-open after 30s",
  "schema migration": "run expand-then-contract migrations behind a flag",
  "feature flags": "evaluate flags server-side and cache the ruleset per request",
  "distributed tracing": "propagate the trace context across async boundaries",
  "queue backpressure": "shed load when the consumer lag exceeds a threshold",
  "connection pooling": "size the pool to cores times two and validate on borrow",
  "cursor pagination": "paginate by opaque cursor instead of offset for stability",
  "idempotency keys": "store idempotency keys for 24h to dedupe retried writes",
  "webhook delivery": "deliver at-least-once with signed payloads and replay",
  "token rotation": "rotate signing keys daily with an overlap window",
  "horizontal sharding": "shard by tenant id with consistent hashing",
  "cold start latency": "warm the runtime and lazy-load heavy dependencies",
  "memory leak": "an unbounded cache leaked memory until eviction was added",
  "deadlock detection": "order lock acquisition to avoid cross-resource deadlocks",
  "timeout tuning": "set client timeouts below the upstream server timeout",
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function findingsFor(project: string, others: string[]): string {
  const lines = [`# ${project} FINDINGS`, "", "## 2026-04-12", ""];
  const count = 18 + (hash(project) % 10); // 18–27 findings
  for (let i = 0; i < count; i++) {
    const seed = hash(project) + i;
    const tag = TAGS[seed % TAGS.length];
    const topic = TOPICS[(seed * 7) % TOPICS.length];
    const other = others[(seed * 3) % others.length];
    // Mention another project by its exact token name to create a graph edge.
    const mention = i % 2 === 0 ? ` This path talks to ${other} over gRPC.` : "";
    lines.push(`- [${tag}] ${project} ${topic}: ${DETAIL[topic]}.${mention}`);
  }
  lines.push("");
  return lines.join("\n");
}

function referenceDocs(project: string): Array<{ file: string; body: string }> {
  return [
    { file: "architecture.md", body: `# ${project} architecture\n\nServices, data stores, and the request path for ${project}.\n` },
    { file: "runbook.md", body: `# ${project} runbook\n\nHow to deploy, roll back, and debug ${project} in production.\n` },
    { file: "api/endpoints.md", body: `# ${project} endpoints\n\nThe public HTTP and gRPC endpoints exposed by ${project}.\n` },
    { file: "decisions/adr-001.md", body: `# ADR-001 (${project})\n\nWhy ${project} chose its storage engine and caching strategy.\n` },
  ];
}

function tasksFor(project: string): string {
  return [
    `# ${project} tasks`,
    "",
    "## Active",
    "",
    `- [ ] Harden ${project} rate limiter under burst load`,
    `- [ ] Add tracing spans to ${project} write path`,
    "",
    "## Queue",
    "",
    `- [ ] Migrate ${project} to cursor pagination`,
    `- [ ] Backfill ${project} idempotency keys`,
    `- [ ] Tune ${project} connection pool size`,
    "",
    "## Done",
    "",
    `- [x] Roll out ${project} circuit breaker`,
    "",
  ].join("\n");
}

/** Write a large, cross-linked store under `phrenDir` and register the projects in the work profile. */
export function seedBigStore(phrenDir: string, profile = "work"): void {
  // Admin so any governance gates pass.
  fs.mkdirSync(path.join(phrenDir, ".config"), { recursive: true });
  fs.writeFileSync(
    path.join(phrenDir, ".config", "access-control.json"),
    JSON.stringify({ admins: ["playwright-admin", os.userInfo().username], maintainers: [], contributors: [], viewers: [] }, null, 2) + "\n",
  );

  for (const project of BIG_STORE_PROJECTS) {
    const others = BIG_STORE_PROJECTS.filter((p) => p !== project);
    const dir = path.join(phrenDir, project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.md"), `# ${project}\n\n${project} is a core service in the platform. It owns its data and exposes HTTP/gRPC APIs.\n`);
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), `# ${project}\n\nConventions and entry points for working in ${project}.\n`);
    fs.writeFileSync(path.join(dir, "FINDINGS.md"), findingsFor(project, others));
    fs.writeFileSync(path.join(dir, "tasks.md"), tasksFor(project));
    for (const ref of referenceDocs(project)) {
      const refPath = path.join(dir, "reference", ref.file);
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      fs.writeFileSync(refPath, ref.body);
    }
  }

  // Register every project in the profile so the web UI / graph discover them.
  fs.mkdirSync(path.join(phrenDir, "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(phrenDir, "profiles", `${profile}.yaml`),
    `projects:\n${BIG_STORE_PROJECTS.map((p) => `  - ${p}`).join("\n")}\n`,
  );
}

/** Realistic search queries that hit findings across many projects. */
export const BIG_STORE_QUERIES: string[] = [
  "redis caching ttl",
  "jwt authentication rotation",
  "rate limiting sliding window",
  "database indexing partial index",
  "retry with backoff jitter",
  "circuit breaker half-open",
  "schema migration expand contract",
  "feature flags server-side",
  "distributed tracing context",
  "queue backpressure consumer lag",
  "connection pooling validate on borrow",
  "cursor pagination opaque",
  "idempotency keys dedupe",
  "webhook delivery at-least-once",
  "token rotation signing keys",
  "horizontal sharding tenant",
  "cold start latency warm",
  "memory leak unbounded cache",
  "deadlock lock ordering",
  "timeout tuning upstream",
  "billing-service idempotency",
  "auth-service token rotation",
  "search-service indexing",
  "api-gateway rate limiting",
  "ml-platform cold start",
  "data-pipeline backpressure",
  "notifications webhook delivery",
  "infra-platform tracing",
  "mobile-app pagination",
  "web-frontend feature flags",
];
