---
type: llm
weight: 1
focus: trace
---
PASS if the agent saved one finding to project checkout-api that states both the rule (key the CI cache on the pnpm-lock.yaml hash) and why (otherwise installs reuse stale dependencies), and then told the user it was saved. FAIL if nothing was saved, the finding went to a different project, or it drops the reason.
