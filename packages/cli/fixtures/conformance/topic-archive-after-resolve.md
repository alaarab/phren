# myproj - Database

<!-- phren:auto-topic slug=database -->

## Archived 2026-07-20

- [pattern] Postgres advisory locks are held per session, not per transaction <!-- fid:0000e001 --> <!-- created: 2026-06-01 --> <!-- source:human machine:test-machine actor:tester tool:phren-ios --> <!-- phren:status "active" --> <!-- phren:status_updated "2026-08-02" --> <!-- phren:status_reason "contradiction_resolved_keep_a" --> <!-- phren:status_ref "Vacuum cannot reclaim rows an open transaction can still see" -->
  <!-- phren:cite {"created_at":"2026-06-01T09:00:00.000Z"} -->
- Vacuum cannot reclaim rows an open transaction can still see <!-- fid:0000e002 --> <!-- created: 2026-06-02 --> <!-- phren:superseded_by "[pattern] Postgres advisory locks are held per session, not" 2026-08-02 --> <!-- phren:status "superseded" --> <!-- phren:status_updated "2026-08-02" --> <!-- phren:status_reason "contradiction_resolved_keep_a" --> <!-- phren:status_ref "[pattern] Postgres advisory locks are held per session, not" -->
