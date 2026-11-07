// Explicit preview data. No credentials, real project data or network requests.
export function createFixture(hostKind = "github") {
  const gitboy = hostKind === "gitboy";
  const base = gitboy ? "https://gitboy.dev/phren-owner/phren" : "https://github.com/phren-owner/phren";
  const createdAt = new Date(Date.now() - 95_000).toISOString();
  const runs = [
    { id: "42", number: 42, title: "Show CI runs on desktop", workflow: gitboy ? "Pipeline" : "CI", branch: "feature/forge", sha: "a83fe21", actor: "phren-owner", status: "running", createdAt, webUrl: `${base}/${gitboy ? "pipelines" : "actions/runs"}/42` },
    { id: "41", number: 41, title: "Keep project navigation focused", workflow: gitboy ? "Pipeline" : "CI", branch: "main", sha: "e147a82", actor: "phren-owner", status: "failed", createdAt, finishedAt: new Date(Date.parse(createdAt) + 65_000).toISOString(), webUrl: `${base}/${gitboy ? "pipelines" : "actions/runs"}/41` },
  ];
  let reads = 0;
  return {
    preview: true, hostName: gitboy ? "gitboy" : "GitHub", cadence: 5000,
    async runs() { return { items: runs }; },
    async detail(id) {
      const run = runs.find((r) => r.id === id);
      const jobStatus = id === "41" ? "failed" : reads >= 3 ? "success" : "running";
      return { run: { ...run, status: jobStatus }, jobs: [
        { id: `${id}-build`, name: "Build", status: "success", startedAt: createdAt, finishedAt: new Date(Date.parse(createdAt) + 24_000).toISOString(), webUrl: run.webUrl, steps: [{ name: "Checkout", status: "success" }, { name: "Compile", status: "success" }] },
        { id: `${id}-test`, name: "Test", status: jobStatus, startedAt: createdAt, webUrl: run.webUrl, steps: [{ name: "Install dependencies", status: "success" }, { name: "Run tests", status: jobStatus }] },
      ] };
    },
    async log(runId, jobId) {
      reads++;
      const finished = runId === "41" || jobId.endsWith("build") || reads >= 3;
      const text = "\x1b[36mPreparing runner…\x1b[0m\nCheckout a83fe21\nLiteral output: <img src=x onerror=alert(1)>\n\x1b[32mDependencies ready\x1b[0m\n" +
        Array.from({ length: Math.min(reads, 3) }, (_, i) => `Test batch ${i + 1} passed\n`).join("") +
        (finished ? runId === "41" ? "\x1b[31mError: assertion failed\x1b[0m\n" : "\x1b[32mJob complete\x1b[0m\n" : "Waiting for next batch…\n");
      if (finished && runId === "42") runs[0].status = "success";
      return { text: !gitboy && !finished ? "" : text, finished };
    },
  };
}
