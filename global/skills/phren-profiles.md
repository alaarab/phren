---
name: phren-profiles
description: Manage machine-to-profile and profile-to-project mappings in phren.
dependencies:
  - git
---
# phren-profiles - Manage your profiles

> **Multi-machine only.** This skill is for users who sync phren across multiple machines and need to control which projects appear where. If you only use one machine, you can skip this -- `phren-sync` handles everything you need.

> Add projects to profiles, move projects between profiles, create new profiles, and check what's in each one.

Manage which projects appear on which machines by editing your profile definitions. Each machine maps to one profile, and each profile is a list of projects.

## Prerequisites

You need a phren repo. The profiles live in `~/.phren/profiles/` and machine mappings live in `~/.phren/machines.yaml`.

```
~/.phren/
  profiles/
    work.yaml
    personal.yaml
  machines.yaml
```

If you don't have a phren repo yet, start with `phren-init`.

## What's a profile?

A profile is a YAML file listing projects for a machine role. Example:

```yaml
name: work
description: Work laptop with company projects
projects:
  - global
  - my-api
  - frontend
```

When you sync on a machine mapped to this profile, only those projects appear. Personal projects stay off work machines.

## How to use it

### "Add a project to a profile"

User says: "add my-project to my work profile"

1. Find the profile file: `~/.phren/profiles/work.yaml`
2. Read it and find the `projects:` list
3. Add the project name if it's not already there
4. Commit the change

### "Create a new profile"

User says: "create a new profile called staging"

1. Create a new file: `~/.phren/profiles/staging.yaml`
2. Fill it with the required structure:

```yaml
name: staging
description: Staging servers and experiments
projects:
  - global
```

3. Ask which projects should be in this new profile (can add more later)
4. Commit the file

### "Show me what's in a profile"

User says: "what's in my personal profile?"

1. Find `~/.phren/profiles/personal.yaml`
2. Read it and display the projects list

### "Move a project between profiles"

User says: "move my-project from personal to work"

1. Find `~/.phren/profiles/personal.yaml` and remove the project
2. Find `~/.phren/profiles/work.yaml` and add the project
3. Commit both changes

### "Set this machine's profile"

User says: "this machine is my work laptop"

1. Get the current machine name: `cat ~/.phren/.machine-id` or `hostname`
2. Ask which profile to use (show available profiles from `~/.phren/profiles/`)
3. Add/update the line in `~/.phren/machines.yaml`: `work-laptop: work`
4. Commit the change
5. Run `phren-sync` to activate

### "List my profiles"

If the user asks what profiles exist:

1. List all files in `~/.phren/profiles/`
2. For each one, read the name and description fields
3. Show which machine is mapped to each profile (from `machines.yaml`)

## After making changes

Always commit to the phren git repo:

```bash
cd ~/.phren
git add profiles/ machines.yaml
git commit -m "update profiles"
git push  # only if remote exists
```

Then suggest running `phren-sync` to activate changes on this machine.

## Related skills

- `phren-sync`: sync your profiles to this machine and activate them
- `phren-init`: create a new project or bootstrap phren from scratch
