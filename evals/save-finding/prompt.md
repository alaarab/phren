---
schema_version: "1.1"
name: save-finding
tags: [memory, save]
runs: 1
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---
Finally found it: in the checkout-api project the CI cache has to be keyed on the pnpm-lock.yaml hash, otherwise installs silently reuse stale dependencies. Please make sure we remember that next time.
