import { hookPost } from "./api.js";

/** Capture the displayed host with the project; never infer it on submit. */
export function projectHostTokenRequest(project, host, token) {
  return {
    route: `/v1/projects/${encodeURIComponent(project)}/git/host-token`,
    body: { token: token.trim(), expectedHost: host.domain },
  };
}

export function hostTokenError(error) {
  if (error?.code === "host-changed") return "The project's remote changed. Reopen to review the new host.";
  if (error?.code === "no-checkout") return "No checkout of this project on this computer.";
  if (error?.reason === "auth") return "The host refused that token.";
  return "Could not connect to the host. Check the token and try again.";
}

export async function connectProjectHost(computer, project, host, token) {
  const { route, body } = projectHostTokenRequest(project, host, token);
  const result = await hookPost(computer, route, body);
  if (!result.ok) throw Object.assign(new Error(hostTokenError(result)), { reason: result.reason });
  return result;
}
