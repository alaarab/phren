# Forge issues

Work lives in forge issues: gitboy.dev for private repositories, GitHub for
public ones. Create, claim and comment with `phren issue` or the `create_issue`,
`claim_issue` and `comment_issue` MCP tools; a pull request that says
`Closes <repo>#N` closes its issue. The full guide ships with the issues layer.

## Retired tasks: what still writes

Phren tasks are retired in 0.4.0. The task tools, commands and Hook routes are
read-only. These paths still touch `tasks.md`, on purpose:

- Phone store-file sync (`POST /v1/store/file`, `/v1/store/delete`) writes or removes `tasks.md` as an ordinary store file.
- `phren_admin(action: "import_project")` with `overwrite` restores a project export, including its `tasks.md`.
- Background archiving of old Done entries still trims `tasks.md`.
