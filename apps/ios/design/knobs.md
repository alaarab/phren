# Knobs: screen design

The project's Knobs screen (`ProjectKnobsView`, opened from the project
page's Knobs cell; the cell is `project-knobs-row`, the screen marker is
`project-knobs`) sets the per-project overrides the CLI reads from
`phren.project.yaml`, plus the phone-local name colour. It is the plain list
composition from [controls.md](controls.md): no `Form`, `List`, `Picker`,
`Toggle`, `Menu` or `Stepper` anywhere.

Components (all existing):

| Component | Where it lives | Used for |
|---|---|---|
| `sessionCard()` | SessionCardContent.swift | every row: a flat rounded fill, no border, no separators |
| `plainListSectionLabel()` | SessionCardContent.swift | the category headers |
| `PhrenSingleSelect` | PhrenControls.swift | each enumeration: a 44pt pill that opens a check-row sheet |
| `PhrenColorDotRow` | PhrenControls.swift | the name colour dots |
| `PhrenDialog` | PhrenControls.swift | the Reset confirmation |

Tokens through `PhrenTheme` and `PhrenTypography` only. Rows are 12pt padded,
44pt minimum and grow with text; at accessibility sizes a row's control moves
below its title and caption.

## Sections and rows

Header: our own sheet header, title "Knobs", trailing "Done" only
(`sheet-done`), because every change is saved as it is made. Below it a
`ScrollView` (`knobs-scroll`) with a `LazyVStack(spacing: 6)` and 14pt side
margins on `PhrenTheme.bg`. Categories are `plainListSectionLabel()` headers
with ids `knobs-section:<kind>`:

- **Findings**: Finding sensitivity.
- **Proactivity**: Proactivity, Proactivity for findings, Proactivity for
  tasks (the base level and its two scoped overrides).
- **Tasks**: Task mode.
- **Appearance**: Name colour.

Each knob is one `sessionCard()` row with its title, a one-line caption of
what it affects, and its control:

- **Enumerations** (all five YAML knobs) use `PhrenSingleSelect`: pill id
  `knob:<key>`, sheet rows `knob:<key>:<value>`. The first row is always
  "Inherit global" (nil), which removes the key so the global setting
  applies; the sheet closes on the choice.
- **Name colour** is the title and caption above a `PhrenColorDotRow`
  (ids `knob:nameColour:<colour>`). It saves to phone-local defaults and
  never reaches the file.

Every knob on the screen today is an enumeration, so the drop-down is the
only control in use. The row shape also carries the kit's other two: a number
knob would show a phren stepper (two 44pt buttons and a monospaced value) and
a boolean knob a `PhrenSwitch` trailing.

## Reset

A final card after the sections, id `knobs-reset`: title "Reset" in
`PhrenTheme.danger`, caption "Clear every override for this project". Tapping
it opens a `phrenDialog` (`knobs-reset-dialog`) with "Reset"
(destructive, `knobs-reset-dialog:reset`) and "Keep" (`knobs-reset-dialog:keep`).
Reset clears all five overrides through the same per-change write and
restores the default name colour.

## Persistence

Unchanged: every control change rewrites the five scalar lines through
`PendingOp.setProjectKnobs`, carrying the `phren.project.yaml` content the
screen opened with as the conflict check. Values, keys and file format are
the same as before this rebuild.
