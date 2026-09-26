---
type: fixed
expect:
  query: string
---
◆ phren · 2 results for "{{input.query}}"

[checkout-api/FINDINGS.md] (findings) mem:checkout-api/FINDINGS.md
- Deploys of checkout-api go through the BLUE-HERON pipeline, and database migrations must run before the canary step: running them after the canary took checkout down on 2026-08-14. <!-- fid:a1b2c3d4 --> <!-- created: 2026-08-15 -->

[checkout-api/FINDINGS.md] (findings) mem:checkout-api/FINDINGS.md
- The payment webhook retries for 72 hours with exponential backoff, so handlers must be idempotent on event id. <!-- fid:e5f6a7b8 --> <!-- created: 2026-07-02 -->
