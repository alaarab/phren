# skills/

Phren slash commands that users invoke with `phren-<name>` (e.g. `phren-init`, `phren-sync`).

Each subdirectory contains a `SKILL.md` file with the full prompt that Claude executes when the skill is invoked. These are global skills shipped with the phren package -- they work across all projects.

Users interact with this directory when adding custom global skills or reading what built-in skills do. For project-specific skills, use `~/.phren/<project>/skills/` instead.
