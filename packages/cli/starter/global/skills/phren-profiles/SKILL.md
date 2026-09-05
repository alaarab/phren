---
name: phren-profiles
description: Manage machine-to-profile and profile-to-project mappings in phren. Multi-machine users only.
dependencies:
  - git
---
# /phren-profiles

A profile is a YAML file in `~/.phren/profiles/` with a `projects:` list. `machines.yaml` maps machine names to profiles. On each machine, phren links only the projects in that machine's profile. Single-machine users can ignore all of this.

## Look

```bash
phren config machines                  # machine → profile
phren config profiles                  # profile → projects
```

## Change

- **Move this machine to a profile:** `phren profile switch <name>` (then `phren init -y` to relink).
- **Add a project to a profile:** edit `~/.phren/profiles/<name>.yaml`, add the project name under `projects:`, commit.
- **New profile:** copy an existing YAML, rename `name:`, set its `projects:`, commit. Then map a machine to it.
- **Register a project that is on this machine but not linked:** `phren add <path>`.

Commit and push the store after changes (`/phren-sync` push), so the other machines pick them up.

## Conversational shortcuts

"add X to my work profile", "what's on this machine?", "switch to personal" all map to the commands above. Show the YAML you changed.
