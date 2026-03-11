# skills/

Cortex slash commands that users invoke with `cortex-<name>` (e.g. `cortex-init`, `cortex-sync`).

Each subdirectory contains a `SKILL.md` file with the full prompt that Claude executes when the skill is invoked. These are global skills shipped with the cortex package -- they work across all projects.

Users interact with this directory when adding custom global skills or reading what built-in skills do. For project-specific skills, use `~/.cortex/<project>/skills/` instead.
