---
type: llm
weight: 1
focus: trace
---
PASS if the agent recorded exactly one task in phren for project checkout-api about migrating the auth tests from jest to vitest, and told the user it is queued, without starting the migration itself. FAIL if no task was recorded, it went to another project, or the agent began editing files or carrying out the migration.
