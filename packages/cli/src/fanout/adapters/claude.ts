import { uuid, type Adapter } from "./types.js";
export const claude: Adapter = {
  command: "claude",
  argv: o => ["-p", "--output-format", "stream-json", "--verbose", "--model", o.model,
    ...(o.review ? ["--permission-mode", "plan"] : []), ...(o.resume ? ["--resume", o.resume] : []), ...(o.extra ?? [])],
  session: event => uuid(event.session_id),
};
