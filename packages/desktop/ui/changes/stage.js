import { stagePlan } from "./util.js";

// Staging lifecycle shared by the row action and the inline bulk review.
export function createStaging(state, { scopeBody, repo, render, postStage, readStatus, announce, refresh }) {
  function selection(status, paths) {
    if (!paths) return status.files || [];
    return (status.files || []).filter((file) => paths.some((path) =>
      file.path === path || file.path.startsWith(path.replace(/\/$/, "") + "/")));
  }

  function review(plan, body, all, detail) {
    state.confirm = { kind: "stage", plan, body, all, detail };
  }

  function stage(files, all = false) {
    if (state.busy || (all && state.confirm)) return;
    const plan = stagePlan(files, all ? state.status : undefined);
    if (state.confirm && plan.confirm) return;
    state.error = plan.error;
    if (plan.error) { render(); return; }
    if (!plan.paths.length) return;
    const body = scopeBody({ paths: plan.paths, expectedRepository: repo() });
    if (plan.confirm) { review(plan, body, all); render(); }
    else return sendStage(plan, body, false, all);
  }

  async function sendStage(plan, body, confirmed = false, all = false) {
    if (state.busy) return;
    const request = state.confirm;
    state.busy = "stage"; render();
    try {
      if (confirmed) {
        const { paths, expectedRepository, ...scope } = body;
        const status = await readStatus(scope);
        if (state.confirm !== request) return;
        if (status.repository !== expectedRepository) throw new Error("The repository changed. Select the files again.");
        state.status = status;
        const current = stagePlan(selection(status, all ? null : paths), status);
        if (current.error) throw new Error(current.error);
        if (JSON.stringify(current.manifest) !== JSON.stringify(plan.manifest)) {
          state.error = "";
          review(current, { ...body, paths: current.paths }, all, "The selection changed. Review the new listing before staging.");
          return;
        }
      }
      await postStage({ ...body, ...(confirmed ? { confirmBulk: true } : {}) });
      state.error = ""; state.confirm = null;
      announce();
      await refresh();
    } catch (e) {
      // A stale status may miss a directory or an untracked binary. Refresh
      // the listing before offering review, rather than authorizing old paths.
      if (!confirmed && e.status === 409 && /confirmBulk=true/.test(e.message)) {
        try {
          const { paths, expectedRepository, ...scope } = body;
          const status = await readStatus(scope);
          if (status.repository !== expectedRepository) throw new Error("The repository changed. Select the files again.");
          state.status = status;
          const current = stagePlan(selection(status, all ? null : paths), status);
          if (current.error) throw new Error(current.error);
          review(current, { ...body, paths: current.paths }, all, "Review the refreshed selection before staging.");
          state.error = "";
        } catch (error) { state.confirm = null; state.error = error.message || String(error); }
      } else { state.confirm = null; state.error = e.message || String(e); }
    } finally { state.busy = null; render(); }
  }

  return {
    stage,
    stageAll: () => stage(state.status?.files || [], true),
    confirm: () => sendStage(state.confirm.plan, state.confirm.body, true, state.confirm.all),
  };
}
