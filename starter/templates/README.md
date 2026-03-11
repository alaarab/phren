# starter/templates/

Project templates bundled in the npm package, used by `npx cortex init --template <name>`.

Each subdirectory (frontend, library, monorepo, python-project) contains pre-filled project files (CLAUDE.md, summary.md, tasks.md, FINDINGS.md) with sensible defaults for that project type. When a user runs init with `--template`, these files are copied into their `~/.cortex/<project>/` directory.

Users interact with this directory indirectly through the `--template` flag during init. To add a new template type, create a subdirectory here with the standard project files.
