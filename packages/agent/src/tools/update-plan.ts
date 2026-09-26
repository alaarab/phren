import type { AgentTool } from "./types.js";

export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  content: string;
  status: PlanItemStatus;
}

let currentPlan: PlanItem[] = [];

export function getPlan(): PlanItem[] {
  return currentPlan;
}

export function clearPlan(): void {
  currentPlan = [];
}

const STATUSES: PlanItemStatus[] = ["pending", "in_progress", "completed"];

export const updatePlanTool: AgentTool = {
  name: "update_plan",
  description: "Create or replace the task plan for the current work. Pass the complete ordered list every time; keep at most one item in_progress. Use it for multi-step tasks so progress is visible.",
  input_schema: {
    type: "object",
    properties: {
      plan: {
        type: "array",
        description: "The complete plan, in order.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Short imperative description of the step." },
            status: { type: "string", enum: STATUSES },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["plan"],
  },
  async execute(input) {
    const raw = Array.isArray(input.plan) ? input.plan : [];
    const plan: PlanItem[] = raw
      .slice(0, 50)
      .map((item) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        const content = String(entry.content ?? "").slice(0, 500);
        const status = STATUSES.includes(String(entry.status) as PlanItemStatus) ? (String(entry.status) as PlanItemStatus) : "pending";
        return { content, status };
      })
      .filter((item) => item.content);
    currentPlan = plan;
    if (plan.length === 0) return { output: "Plan cleared." };
    const done = plan.filter((item) => item.status === "completed").length;
    const active = plan.find((item) => item.status === "in_progress");
    return { output: `Plan updated: ${done}/${plan.length} done${active ? `, now: ${active.content}` : ""}.` };
  },
};
