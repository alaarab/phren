---
name: profiles
description: Manage machine-to-profile and profile-to-project mappings in cortex.
dependencies:
  - git
---
# /cortex-profiles - Manage profiles and machine mappings

> Keep `machines.yaml` and `profiles/*.yaml` clean and accurate.

Use this when you need to:

- map a machine to a profile
- add/remove projects from a profile
- audit what each machine is currently using

## Usage

```text
/cortex-profiles
/cortex-profiles map <machine> <profile>
/cortex-profiles add-project <profile> <project>
/cortex-profiles remove-project <profile> <project>
```

## Commands

```bash
# View current mappings
npx @alaarab/cortex config machines
npx @alaarab/cortex config profiles

# Safe updates
npx @alaarab/cortex shell
# then use:
#   :machine map <hostname> <profile>
#   :profile add-project <profile> <project>
#   :profile remove-project <profile> <project>
```

## Notes

- Prefer the shell commands above for edits; they keep formatting consistent.
- If a machine is missing from `machines.yaml`, add it before running `cortex link`.
