import { describe, expect, it } from "vitest";
import { HealthAlerts, MAX_PER_HOUR, REPEAT_AFTER_MS } from "./machine-health-alerts.js";
import type { HealthFinding } from "./machine-health.js";
import { machineHealthPushPayload } from "./push.js";

const HOUR = 3_600_000;
const f = (id: string, severity: HealthFinding["severity"] = "high"): HealthFinding => ({ id, check: "swap", severity, title: id, detail: "d", fix: "x" });

describe("machine health alerts", () => {
  it("pushes a high finding once while it stands, and again only after it clears for long enough", () => {
    const sent: string[] = [];
    const alerts = new HealthAlerts(async finding => { sent.push(finding.id); });
    alerts.observe([f("swap"), f("uptime", "warn")], 0);
    alerts.observe([f("swap")], HOUR);
    alerts.observe([], 2 * HOUR);
    alerts.observe([f("swap")], 3 * HOUR);
    expect(sent).toEqual(["swap"]);
    alerts.observe([], 4 * HOUR);
    alerts.observe([f("swap")], REPEAT_AFTER_MS + 1);
    expect(sent).toEqual(["swap", "swap"]);
  });

  it("caps pushes per hour and retries the held ones later", () => {
    const sent: string[] = [];
    const alerts = new HealthAlerts(async finding => { sent.push(finding.id); });
    const many = Array.from({ length: MAX_PER_HOUR + 2 }, (_, i) => f(`gpu:${i}`));
    alerts.observe(many, 0);
    expect(sent).toHaveLength(MAX_PER_HOUR);
    alerts.observe(many, HOUR);
    expect(sent).toEqual(many.map(x => x.id));
  });

  it("builds a push that names the computer and opens Resources", () => {
    const payload = machineHealthPushPayload({ computer: "mini", id: "disk", title: "5 GB free", detail: "Builds fail.", fix: "Free space." }, "6f1c0e8e-0000-4000-8000-000000000001");
    expect(payload).toMatchObject({ aps: { alert: { title: "mini: 5 GB free", body: "Builds fail. Free space." }, category: "PHREN_HEALTH" },
      phren: { kind: "machineHealth", host: "6f1c0e8e-0000-4000-8000-000000000001", id: "disk", route: "resources" } });
  });
});
