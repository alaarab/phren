# myproj - Database

<!-- phren:auto-topic slug=database -->

## Archived 2026-07-20

- [pattern] Postgres advisory locks are held per session, not per transaction <!-- fid:0000e001 --> <!-- created: 2026-06-01 --> <!-- source:human machine:test-machine actor:tester tool:phren-ios --> <!-- phren:superseded_by "Use pg_advisory_xact_lock for transaction-scoped locks" 2026-08-02 --> <!-- phren:status "superseded" --> <!-- phren:status_updated "2026-08-02" --> <!-- phren:status_reason "superseded_by" --> <!-- phren:status_ref "Use pg_advisory_xact_lock for transaction-scoped locks" -->
  <!-- phren:cite {"created_at":"2026-06-01T09:00:00.000Z"} -->
- Vacuum cannot reclaim rows an open transaction can still see <!-- fid:0000e002 --> <!-- created: 2026-06-02 --> <!-- phren:status "active" --> <!-- phren:status_updated "2026-06-02" -->
