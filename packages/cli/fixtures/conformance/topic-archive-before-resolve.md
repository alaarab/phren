# myproj - Database

<!-- phren:auto-topic slug=database -->

## Archived 2026-07-20

- [pattern] Postgres advisory locks are held per session, not per transaction <!-- fid:0000e001 --> <!-- created: 2026-06-01 --> <!-- source:human machine:test-machine actor:tester tool:phren-ios --> <!-- conflicts_with: "Vacuum cannot reclaim rows an open transaction can still see" --> <!-- phren:contradicts "Vacuum cannot reclaim rows an open transaction can still see" --> <!-- phren:status "contradicted" --> <!-- phren:status_updated "2026-07-01" --> <!-- phren:status_reason "conflicts_with" --> <!-- phren:status_ref "Vacuum cannot reclaim rows an open transaction can still see" -->
  <!-- phren:cite {"created_at":"2026-06-01T09:00:00.000Z"} -->
- Vacuum cannot reclaim rows an open transaction can still see <!-- fid:0000e002 --> <!-- created: 2026-06-02 --> <!-- conflicts_with: "[pattern] Postgres advisory locks are held per session, not" --> <!-- phren:contradicts "[pattern] Postgres advisory locks are held per session, not" --> <!-- phren:status "contradicted" --> <!-- phren:status_updated "2026-07-01" --> <!-- phren:status_reason "conflicts_with" --> <!-- phren:status_ref "[pattern] Postgres advisory locks are held per session, not" -->
