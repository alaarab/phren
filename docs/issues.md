# Forge issues

Phren's issue layer reads and updates work in GitHub and gitboy repositories. It supports listing, creating, editing, claiming, commenting on, and closing issues. Lists default to open issues and 50 results, with a maximum of 200 results. A list spanning several repositories can return results from reachable repositories alongside errors for the others. Gitboy pages by issue number. Phren reads until it has enough matches or reaches five pages of up to 100 issues per repository, then sorts the matches by last update.

Use a repository reference such as `github.com/example/widgets` or a repository URL. To select a project's issue repository explicitly, set `issues: github.com/example/widgets` in its store's `phren.project.yaml`. Otherwise Phren looks at the project's local checkout, using the same search as the code index. A gitboy origin takes precedence. With a GitHub origin, Phren uses a gitboy repository if the checkout has a `gitboy` remote pointing to one. A bare `owner/name` defaults to GitHub. In the project's `issues` setting, it inherits the forge domain from the checkout when available.

GitHub uses the local `gh` sign-in. Fine-grained GitHub tokens need Issues read permission for listing and viewing issues and Issues write permission for changes.

Gitboy uses the Hook's host credentials or the `GITBOY_HOST` and `GITBOY_TOKEN` pair. Give the token `read:issue` for reading, plus `write:issue` for writes and `read:user` for claiming or listing issues assigned to the signed-in user. Label and assignee changes also require repository write access.

A claim assigns the issue to the signed-in user and replaces any `working-on:<computer>` label. Release acts only on the matching computer's label and clears the associated assignment. Phren verifies both changes with a fresh read and retries once on a conflict. Issue reads collect Markdown checkboxes throughout the body. Checklist edits replace the last block delimited by `<!-- phren:checklist -->` and `<!-- /phren:checklist -->` outside fenced code. The rest of the body is preserved byte for byte.
