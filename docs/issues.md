# Forge issues

Phren's issue layer reads and updates work in GitHub and gitboy repositories. It supports listing, creating, editing, claiming, commenting on, and closing issues. Lists default to open issues and 50 results, with a maximum of 200 results. A list spanning several repositories can return results from reachable repositories alongside errors for the others. Gitboy pages by issue number. Phren reads until it has enough matches or reaches five pages of up to 100 issues per repository, then sorts the matches by last update.

Use a repository reference such as `github.com/example/widgets` or a repository URL. To select a project's issue repository explicitly, set `issues: github.com/example/widgets` in its store's `phren.project.yaml`. Otherwise Phren looks at the project's local checkout, using the same search as the code index. A gitboy origin takes precedence. With a GitHub origin, Phren uses a gitboy repository if the checkout has a `gitboy` remote pointing to one. A bare `owner/name` defaults to GitHub. In the project's `issues` setting, it inherits the forge domain from the checkout when available.

GitHub uses the local `gh` sign-in. Fine-grained GitHub tokens need Issues read permission for listing and viewing issues and Issues write permission for changes.

Gitboy uses the Hook's host credentials or the `GITBOY_HOST` and `GITBOY_TOKEN` pair. Give the token `read:issue` for reading, plus `write:issue` for writes and `read:user` for claiming or listing issues assigned to the signed-in user. Label and assignee changes also require repository write access.

A claim adds `working-on:<computer>` and assigns the signed-in user only if no other computer holds the issue. A competing claim fails with `claimed by <computer>`. To transfer a claim, release it on the holding computer and then claim it on the destination. Release removes that computer's label and keeps the assignee if another computer's claim label appears.

Claim and release serialize across computers using a temporary, uniquely named repository label (`phren:claim-lock:<issue number>`). If a process dies while holding this label, an owner can delete it from the repository after confirming the process has stopped. Make claim changes through Phren to participate in the same coordination.

Issue reads collect Markdown checkboxes throughout the body. Checklist edits replace the last block delimited by `<!-- phren:checklist -->` and `<!-- /phren:checklist -->` outside fenced code. The rest of the body is preserved byte for byte.

## Command line

```bash
phren issue list --project widgets
phren issue list --repo github.com/example/widgets --repo gitboy.example/example/gadgets --state all --assignee me
phren issue show github.com/example/widgets#12
phren issue new --project widgets --title "Tighten the widget" --body "Why it matters." --check "Write the test" --check "Ship it"
phren issue edit github.com/example/widgets#12 --check-done 1 --check-add "Announce it"
phren issue claim github.com/example/widgets#12
phren issue comment github.com/example/widgets#12 "Done in #14."
phren issue close github.com/example/widgets#12 --comment "Shipped."
```

An issue reference (`<ref>`) is `repo#N` (the repository may be `owner/name`, `domain/owner/name` or a URL), a full issue URL such as `https://github.com/example/widgets/issues/12`, or `#N` with `--repo` or `--project`. A bare `owner/name` in `--repo` inherits the project's forge domain when `--project` is also given. `--project` names the project whose `issues:` setting or checkout provides the repository.

`list` reads the `--repo` flags, else the `--project`, else the project around the working directory, else every project with a resolvable repository. `--assignee me` resolves to the signed-in forge user. `--json` prints the machine payload instead of the table (`list` prints `{issues, errors}`, every other subcommand the issue or comment URL). A usage mistake exits 1; a forge failure exits 2 with the forge's message.

`--check-done N` numbers the checklist items in the order `show` prints them. `edit` sends the complete list, so the managed block is rewritten from the current items plus your change. A checkbox written outside the managed block is still read, and is included in the rewritten block.

## MCP tools

`list_issues`, `get_issue`, `create_issue`, `update_issue`, `claim_issue`, `comment_issue` and `close_issue` take a repository (`repo`) or a project (`project`) plus the issue `number`. `list_issues` and `get_issue` are in the core tool profile; the rest are full-profile tools. Their parameters and response shapes are in the [API reference](api-reference.md#issues).

## Dispatch and the owner Inbox

Pass `--issue github.com/example/widgets#12` to `phren dispatch`. The worker brief asks for one summary comment and a closing reference in any PR. `dispatch_report` attaches PR URLs to the issue. Dispatch returns include the issue reference. A worker keeps its issue binding when moved to another Hook. Use `phren owner-inbox add --issue github.com/example/widgets#12 <title>` for a related owner action.
