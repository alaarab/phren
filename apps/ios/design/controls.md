# Phren control kit

Phren owns the shape, density and interaction of its controls. Moshi is the
reference for how much useful work fits on a phone; PhrenTheme supplies the
colors. Controls live in `Phren/DesignSystem/PhrenControls.swift`. Swift files
share the app module, so moving PhrenSwitch out of PhrenChrome preserves its
existing name and call sites. Schedule-specific fields remain in
`Features/Schedules/ScheduleControls.swift`.

This is the migration contract. Chat question rows, Project Knobs and the
Schedules editor use it now. Tasks, Skills, Agents, Settings and Graph migrate
screen by screen. Existing PhrenList, PhrenForm and phrenRow wrappers still
contain native list/form behaviour; they are not the replacement kit.

## Shared measurements and behaviour

- Spacing is `PhrenTheme.Space`: xs 4, small 8, medium 12, large 16,
  section 24 points. Radii are small 10, questionOption 12, medium 14,
  large 18, pill 1000. All measurements below are points.
- A height of 44 or 48 is a **minimum** unless explicitly called a visual
  dimension. Text can make a row taller. Every tap target is at least 44 by
  44, including a button whose visible circle is only 32 wide.
- Text uses PhrenTypography: body for fields and option titles, subheadline
  semibold for compact headers, caption for supporting text, monoSubheadline
  for numbers/code. No fixed text sizes, scaling caps or minimumScaleFactor.
- Normal text is `text`, supporting text `textMuted` or `textSecondary`.
  Screen is `bg`; cards `surface`; fields `surfaceRaised`. Selection uses
  `cyan` (radio/check) or `accent` (segments). Destructive actions use `danger`.
  White switch knobs and a black modal scrim are deliberate exceptions.
- Disabled controls retain their current selection and show 0.45 opacity.
  SwiftUI's disabled environment also prevents activation and supplies the
  disabled accessibility state. Disable a whole group while saving, or an
  individual option when unavailable. An unavailable stored selection is
  preserved until the user chooses a supported value.
- Switching/segment and presentation animations use 0.18-second easing.
  Reduce Motion removes animation and the sheet's finger-following offset;
  the same dismiss gesture still works. Selection rows and steppers change
  immediately. No continuous decorative animation.
- `phrenIdentifier("screen-control:stable-id")` is a thin wrapper around
  accessibilityIdentifier. Use domain IDs, not translated labels, array
  positions or values that change on selection. Each independently presented
  surface supplies its own prefix. Existing screen identifiers are preserved.
  Parent containers do not replace identifiers on their interactive children.
- A Button provides the button trait; decorative glyphs are hidden. Selected
  choices add `.isSelected`. Text, captions and optional badges remain part
  of the row's spoken label. Supply a meaningful switch/icon label; never
  make an SF Symbol name the spoken name. Scaffolds preserve child elements.

## PhrenSwitch

Purpose: a Boolean preference or enabled state. Use it as trailing content in
an ordinary labelled row. `PhrenSwitch(isOn: $enabled, label: "Enabled")`.

Geometry: 44 by 26 capsule, centred inside a 44 by 44 Button; white 22-point
knob, horizontal offsets -9 and +9. Off uses surfaceRaised; on uses
accentSolid. Disabled on/off preserve the knob position at 0.45 opacity.
There is no destructive switch state: destructive operations require an
explicit action and, when appropriate, a dialog.

Accessibility: button plus `.isToggle`, supplied label and `On`/`Off` value.
Identifier: `screen-switch:setting`, for example `schedule-enabled` at the
existing editor call site. The label is external to the fixed visual switch;
put long labels above it at accessibility sizes. The target never shrinks.

## PhrenOptionRow

Purpose: the radio row used for every single choice, and the check row for
multiple choices. ChatQuestionOptionRow is now an adapter over this control,
retaining its code preview and busy state.

Geometry: 44 minimum height, 12 padding, 10 between leading slots, 22-wide
radio/check and optional glyph slots (18-point symbols), 4 between title and caption. Radius 12;
the chat adapter retains its existing radius 10. `glyph` accepts a custom
view such as AgentProviderGlyph or a host color dot; `icon` accepts an SF
Symbol. `trailing` accepts a passive badge, and `detail` a preview. Slots must
not contain buttons or other competing actions.

Normal: surfaceRaised, text title, textMuted caption, textDim empty circle
or square. Selected: cyan mark, cyan at 0.1 fill, 1-point cyan at 0.5 stroke.
Disabled: the same selected/unselected drawing at 0.45 opacity, no activation.
Destructive: not a choice state; use an action row with a destructive role.

Accessibility: one Button, selected trait when checked, combined title,
caption and badge. Chat explicitly adds the preview as the accessibility
value because the preview's scroller would otherwise lose it. Identifier:
`screen-option:value-id` (existing examples: `schedule-computer:Desk`,
`schedule-harness:codex`, `schedule-model:default`).

Dynamic Type: title/caption wrap without a line cap. A trailing badge moves
below the text at accessibility sizes. Glyphs have reserved layout space;
never pad a title with spaces or position a badge over its text.

## PhrenOptionGroup<Value: Hashable>

Purpose: select exactly one typed value. Optional values are supported:
`nil` can mean “Inherit global”, “Any priority” or “Harness default”.
PhrenOption carries stable string `id`, typed `value`, title, optional caption
and icon, optional spoken segment label, and `isEnabled`.

Geometry/tokens/states: PhrenOptionRow radio rows, 8 apart, no outer box.
Choose the row already selected and it stays selected. Disabled or missing
options do not change the binding. No selection is invented if the current
value is absent. IDs and values must be unique within a group. Destructive
state is not applicable.

Accessibility: contained row Buttons, individual selected/disabled traits.
`identifier` is a prefix; children are `prefix:option.id`, for example
`controls-single:diff`. A PhrenGroup header names the choice.
Dynamic Type follows the wrapping row; the group grows vertically.

## PhrenMultiOptionGroup<Value: Hashable>

Purpose: bind independent choices to `Set<Value>`, including an empty set.
Tapping an enabled member inserts/removes only that value. Other members,
including temporarily unavailable selections, survive. Callers enforce any
business rule such as requiring at least one weekday before Save.

Geometry/tokens/states: the same 44-minimum rows and 8 spacing as the single
group, with square check marks. Selected and disabled may coexist.
Destructive state is not applicable. A disabled group never changes its set.

Accessibility: Buttons with selected trait; no misleading “choose one” label.
Identifier: `screen-multi:option.id`. Dynamic Type wraps and grows as above.
Schedules keeps its specialised wrapping day chips for its compact weekday
set; a general filter list uses this group.

## PhrenMultiSelect<Value: Hashable>

Purpose: a compact multi-select filter. The trigger is a 44-minimum pill that
summarizes chosen values ("All kinds", "Findings, Tasks"). Memory's Kinds and
Projects filters use it. Present `.phrenMultiSelectSheet` at the full-screen
root so the scrim covers navigation and tabs. Optional `leading` content keeps
Memory's store chooser above the option rows.

Geometry: the trigger is a surfaceRaised capsule with 12 horizontal padding
and a 9-point chevron. The centered surface card has radius 18, width up to
360, 16 padding and 12 between sections. It fits its content up to 600 points
or 85% of available height, whichever is smaller. Only overflowing rows scroll;
four kinds must not stretch into an otherwise empty full-height card.

Option rows are 40 minimum height, 4 apart, with 12 horizontal and 6 vertical
padding. This dense list is the exception to the general 44-point minimum.
Titles and captions wrap at larger text sizes. A small trailing check replaces
the empty checkbox; selected rows retain cyan at 0.1 fill and the 1-point cyan
at 0.5 outline. Unavailable rows retain selection, dim and cannot change.

With more than eight options, PhrenSearchField sits above the rows. Search
matches words in titles and captions without changing the selection. All and
None are 44-point text targets on that same line, or right-aligned on a line
of their own for a short list. Bulk actions apply to the whole option set,
preserve unavailable selections, and disable when they would make no change.
`requiresSelection` prevents both chip removal and None from clearing the
last current option. Unknown stored values survive edits but do not count.

Chosen options stay above the list as removable cyan chips, in option order.
The chip strip scrolls horizontally so many selections do not consume the
card. Chips remain visible while searching; each has a 44-point removal target
and speaks "Remove <title>". Done reads "Done (N)" with the count of chosen
current options, independent of search results. An empty set still uses the
trigger's `allLabel`; the owning filter decides what an empty set means.
The binding changes live; backdrop, Escape and Done dismiss without a commit.

Accessibility: the trigger speaks its summary, the modal focuses its title,
and selected rows retain the selected trait. Existing identifiers survive:
`rowPrefix:optionId`, `rowPrefix-done`, `rowPrefix-sheet`. Additional targets are
`rowPrefix-search`, `rowPrefix-all`, `rowPrefix-none` and
`rowPrefix-chip:optionId`. Reduce Motion removes the presentation animation.

## PhrenTextSegment<Value: Hashable>

Purpose: a short mutually exclusive mode such as Changes' List/Diff or a
field's duration unit. Uses PhrenOption values and a selection binding.

Geometry: 44 by 44 minimum pills, 12 horizontal and 4 vertical label padding,
6 between optional icon and text, 4 between pills, 2 outer padding. Outer
surface radius 18; selected pill is a capsule. Inside a field that draws its
own raised surface (the duration unit) the segment is `bare`: no outer padding
or box, so the field stays one shape. Text is subheadline medium.
Normal is textMuted on clear; selected is accent over accent at 0.16;
disabled is 0.45 opacity. Destructive state is not applicable.

Accessibility: each pill is a Button with selected trait, its title or
`accessibilityLabel` (for example “Hours” for “h”). Identifier:
`screen-segment:item.id`, including `schedule-duration-unit:h`.
Dynamic Type: the horizontal group measures its full labels; if it will not
fit, it becomes a vertical stack. Accessibility sizes always stack. Long
labels wrap in that stack; pills are never squeezed into tiny targets.

## PhrenIconButton

Purpose: open actions or perform a compact command. This is the visible
32-point icon button specified for Menu replacements.

Geometry: 32-point surfaceRaised circle within a 44 by 44 rectangular hit
area; 18-point symbol. Normal uses accent; destructive uses
danger; either can be disabled at 0.45 opacity. Selected state is not
applicable; a stateful icon supplies its state in its label.

Accessibility: Button, explicit human label; identifier
`screen-action:verb` or `screen-actions:item-id`. Dynamic Type does not change
the hit area; no text is squeezed into the circle. Use a text action if its
meaning cannot be expressed clearly by the glyph and spoken label.

## PhrenActionSheet and its action model

Purpose: choose an action or a toolbar picker's value on a custom bottom
surface. Present with `.phrenActionSheet(isPresented:title:actions:identifier:)`.
Attach the modifier outside the screen's NavigationStack/TabView, or to its
full presentation root, so its scrim covers navigation and tab controls too.
Do not attach it to a row, toolbar item or a scrolling child. An editor
already presented as a screen owns its own full-root presenter.

Geometry: black 0.5 scrim across the safe areas; card uses surface, radius 18,
8 outer margin, maximum width 560, maximum height 85% of available safe-area
height. A 32 by 4 handle has 8 top space. Header has 48 minimum height, 16
leading/6 trailing padding and a 44 close target. Rows have 48 minimum
height, 12 padding, 22-wide glyph slot, 12 glyph/text gap, 4 caption gap,
4 between rows, 8 horizontal/bottom inset, radius 12. Small menus fit their
content; long menus scroll under the stationary header.

`PhrenActionSheet.Action` aliases PhrenControlAction: stable `id`, title,
optional icon/caption, role (`normal`, `destructive`, `cancel`), isEnabled,
optional isSelected, dismisses (default true), and handler. A nil isSelected
is a command; a Boolean is a radio choice drawn by PhrenOptionRow, including
its selection tint and traits. Choice rows are not destructive commands.
Ordinary command text is text; destructive command text/glyph is danger.
Disabled rows keep their text and state at 0.45 opacity and never execute.

An enabled action dismisses **before** calling its handler, so it can open a
dialog or route to a screen. `dismisses: false` keeps a filter choice open;
the owner updates its binding and supplies the current row selection. The
model does not infer selection or retain a copy of the owner's state.
Independent multi-choice filters should use a PhrenScreen of PhrenGroups
with PhrenMultiOptionGroup, rather than a flat radio action sheet.

Dismiss by tapping the backdrop, Close, accessibility Escape, or dragging
the header downward more than 80 points (or projected end more than 160).
Dragging the rows scrolls; it does not fight the dismiss gesture. Passive
dismissal changes the binding only and runs no action handler.

Accessibility: modal trait, initial focus on the header, background hidden
and untappable while presented, Close and Escape always available. Rows are
Buttons; selected rows use the shared radio trait. Identifiers:
`screen-sheet`, `screen-sheet:action.id`, `screen-sheet:close`,
`screen-sheet:scroll`. Reserve `close` and `scroll` from action IDs.
Dynamic Type: title and captions wrap, rows grow, and overflow scrolls.
Reduce Motion eliminates both presentation motion and drag offset animation.
This uses no UIKit sheet, detents, system grabber or menu chrome.

A searchable chooser may pass `searchPlaceholder` to `phrenActionSheet`.
Its PhrenSearchField stays below the fixed header, filters action titles and
captions, and uses `screen-sheet:search`. No matches gets an explicit empty
state. Ordinary action menus do not show search.

Action rows may supply `iconColor` for a semantic glyph, such as the computer
color dot in the Projects launch chooser. The title and caption retain their
normal text colors; the glyph stays decorative for accessibility.

## PhrenDialog

Purpose: an acknowledgement or a decision with one to three actions.
Present with `.phrenDialog(isPresented:title:message:actions:identifier:)`
at the same full-screen root as an action sheet. It is a centred card,
not an alert or a confirmationDialog.

Geometry: surface card, radius 18, maximum width 360, 16 outer and inner
margins, 12 between title/message/actions. Title is subheadline semibold;
message is body textSecondary. Actions stack vertically, 8 apart, with 44
minimum height, 12 horizontal/8 vertical padding and radius 12 on
surfaceRaised. Normal action text is accent, destructive is danger, disabled
is 0.45 opacity. Selection is not meaningful for a dialog action.

The initializer requires one to three actions. Give destructive decisions
an explicit safe action such as Keep. Backdrop taps do nothing. Accessibility
Escape dismisses without running a handler; explicit cancel-role buttons
run their supplied handler. Dismissal does not perform the destructive
operation. Do not model an unavoidable action as a dialog.

Accessibility: modal trait, focus on the title, title header trait, message
readable separately, labelled action Buttons, background hidden and blocked.
Identifiers: `screen-dialog`, `screen-dialog:action.id`,
`screen-dialog:scroll`. Dynamic Type wraps all text, increases button height,
and scrolls the card contents if the screen cannot fit them. Reduce Motion
removes its opacity animation. A text-entry alert becomes a small PhrenScreen
editor with a labelled plain text field and explicit Save/Cancel; it must not
lose its input by replacing the alert with a message-only dialog.

## PhrenStepperField

Purpose: a bounded integer with explicit decrease/increase controls.
Requires title, binding, ClosedRange and identifier; step defaults to 1.
Non-positive steps behave as 1; arithmetic overflow clamps to the bound.

Geometry: 44 minimum buttons, 44 minimum value width/height, 8 between
minus/value/plus, 12 between title and controls. Body title, monoSubheadline
monospaced digits. Buttons use PhrenIconButton. Normal value is text; a
button disables at its bound. Whole-field disabled is 0.45 opacity and
cannot adjust through touch or accessibility. Selected/destructive states
are not applicable. Changing the number is immediate.

Accessibility: labelled adjustable container with current numeric value and
increment/decrement actions, plus labelled Decrease/Increase buttons.
Identifiers: `screen-stepper:field`, followed by `:minus`, `:value`, `:plus`.
Dynamic Type: at accessibility sizes the title moves above the controls;
the number sizes to its digits. Choose a sensible bounded range for the
screen's available width rather than abbreviating a meaningful value.

## PhrenScreen

Purpose: the scrolling editor/settings scaffold. `PhrenScreen { ... }`
contains a ScrollView and leading VStack with 16 margins on every edge and
24 between groups, on bg. The eager stack deliberately keeps edited fields
alive while scrolling; large data lists use LazyVStack explicitly.

Normal is the only visual state; selection/destructive are not scaffold
states. Applying disabled passes it to child controls. Accessibility preserves
children. Identifier: `screen-scroll` (existing `schedule-editor-scroll`).
Dynamic Type makes content taller and the screen scrolls. Keyboard dismissal
is a caller choice, such as `.scrollDismissesKeyboard(.interactively)`.

## PhrenGroup

Purpose: replace a Form Section without grouped system chrome.
`PhrenGroup("Caption", identifier: "screen-group:kind") { ... }` is a
leading VStack with 8 between its caption and children. The caption calls
plainListSectionLabel: caption semibold, textMuted, uppercase, tracking 0.6,
14 leading and 8 top inset. There is no additional enclosing card.

Normal is the only visual state. Disabled passes to children; selection and
destructive are not group states. Caption has the header trait and wraps
at all text sizes. `identifier` identifies the caption; explicit stable
IDs are preferred to the convenience fallback `phren-group:<caption>`.
Group footnotes are ordinary wrapping caption text after the control.

## PhrenRow

Purpose: a navigation/action label with leading SF Symbol, title, generic
trailing content and optional chevron. Wrap it in a plain Button or
NavigationLink; the row itself does not create a second tap action.

Geometry: 44 minimum height, 12 horizontal/8 vertical padding, 22 glyph
slot, 12 outer gap and 8 title/trailing gap; surface fill, radius 12.
Title is body text; glyph textSecondary; trailing caption textMuted;
chevron caption textDim. Disabled uses 0.45 opacity. Selection and destructive
are not navigation states; use option rows or action sheets for those.

Accessibility: the outer Button/NavigationLink supplies its trait; glyph
and chevron are decorative. Passive trailing metadata joins its label.
For a row containing an independent switch, use no enclosing Button and
set `chevron: false`. Identifier on the actionable wrapper:
`screen-row:destination`, for example `project-schedules-row`.
Dynamic Type: title wraps; trailing content moves below at accessibility
sizes with a 4 gap. Never overlay text on the title.

## PhrenTimeField

Purpose: 24-hour numeric input instead of a time wheel. Two numeric fields,
colon, 4 gaps, 12 horizontal padding, raised radius-12 surface. Each field
is at least 44 wide/tall; width scales from 44 with subheadline Dynamic Type.
monoSubheadline digits. Normal uses text; invalid input adds a danger caption;
commit clamps hour 0...23 and minute 0...59. Disabled prevents editing.
Selected means keyboard focus, not a choice mark; destructive is inapplicable.

Accessibility: Time container with Hour and Minute fields. Identifier on the
container: `screen-time:field`; identify child fields by their spoken labels
within that container. Rows grow with text; no fixed text height. The editor
moves its leading label above the field at accessibility sizes.

## PhrenDurationField

Purpose: an interval number plus min/h/d units, minimum 5 minutes. Number
width scales from 54, minimum height 44, unit pills are PhrenTextSegment;
4 gap, 8 horizontal inset, surfaceRaised and radius 12.

Normal uses monoSubheadline text; selected unit uses the segment tint;
invalid/too-small input gets a danger caption and clamps on commit. Disabled
blocks input; destructive is inapplicable. Accessibility labels are Interval,
Interval amount, Minutes/Hours/Days. Container identifier:
`screen-duration:field`; the Schedules unit IDs are
`schedule-duration-unit:min`, `:h`, `:d`. Multiple instances should be scoped
by their container identifier in UI tests. At accessibility sizes number and
units stack vertically; no number field has a fixed height.

## PhrenDateField

Purpose: a Gregorian date and time for one-off schedules. Numeric date input
normalises to YYYY-MM-DD, followed by hour and minute with 4 gaps. Date
minimum width 112, hour/minute widths scale from 44, all heights minimum 44;
8 horizontal inset, raised radius-12 surface, monoSubheadline digits.

Normal uses text; invalid input shows a danger caption. Commit clamps valid
numeric components or restores the last valid date. Focus is the only
selected state; disabled prevents edits; destructive is inapplicable.
Accessibility: Date and time container, Date/Hour/Minute field labels.
Identifier: `screen-date:field`. At accessibility sizes the date moves above
the time pair; its digits retain their full width.

## PhrenCodeField

Purpose: a multiline prompt/code input. monoSubheadline text on surfaceRaised,
radius 12, 16 padding, minimum height 88; grows from 1 to 12 lines then scrolls.
Normal/focused use the same quiet field fill, disabled prevents editing,
destructive is inapplicable. Business validation belongs below the field in
a danger caption. Identifier: `screen-code:field` (existing `schedule-prompt`);
accessibility label is the supplied prompt. Dynamic Type expands line heights
and the enclosing editor scrolls; no fixed pixel height clips the text.

## PhrenSearchField

Purpose: a one-line search input, the Memory tab's field. Requires a text
binding and an identifier; takes a placeholder, an optional owner focus
(`FocusState<Bool>.Binding`) for dismissing the keyboard, and an onSubmit.

Geometry: 44 minimum height, 12 leading inset, 8 between the 15-point
magnifier and the field, raised radius-12 surface. Body text, cyan caret,
`.webSearch` keyboard, search return key, no autocorrection. A 44 by 44
clear button (`xmark.circle.fill`, textMuted) appears once there is text and
takes the trailing inset. Normal is the only visual state besides disabled
(0.45 opacity, no input); focus is the keyboard, not a drawn state;
destructive is inapplicable.

Accessibility: the text field carries the identifier itself (a field has no
children to hide): `screen-search`, for example `memory-search`; the clear
button is `screen-search:clear` with the label "Clear search". Dynamic Type
grows the row; the clear target never shrinks.

## PhrenChipRow<Value: Hashable>

Purpose: choose exactly one of a short, flat set drawn as chips: Memory's
scope (All, one per project) and its content filter (All, Findings, Tasks,
Topics). Takes PhrenOption items, a selection binding and an identifier
prefix; `tint` gives the selected chip a color per value (the selected
project uses sessionProject), `raised` draws unselected chips on
surfaceRaised for a `surface` panel, `wraps` forces wrapping.

Geometry: one horizontal row that scrolls without an indicator, 8 between
chips; each chip is a capsule 32 tall with 12 horizontal padding inside a
44 minimum target. Subheadline medium text, optional 11-point leading icon.
Normal is textSecondary on surface (or surfaceRaised); selected is the tint
over the tint at 0.16; disabled is 0.45 opacity. Selecting the selected
chip keeps it. Changing the selection scrolls that chip into view (0.18
easing, none under Reduce Motion). Destructive is inapplicable.

Accessibility: each chip is a Button with its title, the selected trait when
chosen; identifiers `prefix:option.id` (`memory-scope:ledger`,
`memory-filter:tasks`). At accessibility sizes the row becomes
`PhrenFlowLayout` rows of chips, so long project lists wrap instead of
hiding; titles wrap inside a chip rather than truncating.

`PhrenFlowLayout` is the leading-aligned wrapping layout behind the row and
behind the Memory rows' meta chips at accessibility sizes.

## Existing chrome and list composition

PhrenIconSegment remains for short icon modes (5 timing modes in Schedules).
Each symbol target is at least 44 by 44, 4 apart, with 3 outer padding on
surface; selected accent at 0.16 fill and accent symbol, otherwise textMuted.
Its spoken labels carry the meaning and selected traits carry state.
Identifier pattern: `screen-icon-segment:kind`; existing Schedules identifies
the group as `schedule-every:<kind>`. No destructive segment state.

PhrenChip (caption2 medium, 7 horizontal/3 vertical padding, capsule) and
PhrenCountBadge (caption2 semibold digits, 7 horizontal/1 vertical padding)
are passive metadata, never tiny tap targets. Chips use semantic chipColor
at 0.14 fill; counts use surfaceRaised/textSecondary. Neither has an interactive
selected/disabled/destructive state. Let chips wrap as a group; don't place
long prose in their single-line labels. Identifier patterns when needed:
`screen-chip:kind`, `screen-count:kind`.

PhrenMetadataHeader is for a title, short subtitle and chips (6 vertical gap,
8 title/trailing gap), and PhrenIconRow for compact file/metadata summaries
(22 glyph slot, 8 gap, 12 horizontal/9 vertical padding, radius 10). They
retain their existing limited-line metadata treatment; use wrapping PhrenRow
and PhrenGroup for form/navigation text. They are passive unless wrapped in
an explicit 44-minimum action. Identifier patterns: `screen-header:item-id`,
`screen-metadata:item-id`. IconRow selection uses accent at 0.16 fill; destructive
actions belong in the sheet. Caller-owned disabled wrappers disable taps.

Data lists are ScrollView + LazyVStack(spacing: 6) with 16 side margins;
each content row gets 12 padding and `sessionCard()` (surface, radius 14,
no border/separator). Each section label uses plainListSectionLabel, optionally
with PhrenCountBadge. Rows grow with text. Label ID `screen-section:kind`,
row ID `screen-item:stable-id`. Preserve navigation, refresh, search and
selection explicitly; list-only modifiers do not work in a ScrollView.

## Native replacements and consumer recipes

| Native control/pattern | Phren replacement |
|---|---|
| `Form { Section(...) { ... } }` | `PhrenScreen { PhrenGroup("Caption") { ... } }`; caption footnotes remain wrapping text |
| Grouped/plain `List`, `PhrenList` | ScrollView + LazyVStack of `sessionCard()` rows, `plainListSectionLabel()` captions and optional counts |
| `Picker` in content | PhrenOptionGroup radio rows, including an explicit nil option when supported |
| Segmented `Picker` | PhrenTextSegment for text modes; PhrenIconSegment for short labelled icon modes |
| `Picker` in a toolbar | Labelled PhrenIconButton or a 44-minimum value button opens PhrenActionSheet; map values to actions with isSelected and binding setters |
| `Toggle` | Labelled PhrenRow with no chevron and PhrenSwitch trailing |
| `DatePicker` | PhrenDateField / PhrenTimeField; no wheel or calendar popover |
| `Stepper` | PhrenStepperField with explicit range and step |
| `Menu` | PhrenActionSheet opened from PhrenIconButton (32 visible, 44 target) |
| `contextMenu` | Explicit row actions icon opening PhrenActionSheet; optional long press may open the same sheet, never be the only entry point |
| `alert` | PhrenDialog; text-entry alerts use a PhrenScreen editor |
| `confirmationDialog` | PhrenDialog with specific destructive and safe action labels |
| `swipeActions` / `onDelete` | Custom slide/reveal with 44-minimum actions plus an explicit action-sheet route; Schedules already has 72-wide custom actions and in-row delete confirmation |
| `List(selection:)`, edit selection | PhrenMultiOptionGroup for filters, or row check slots and caller-owned Set of stable IDs for data rows |
| `onMove` / EditButton | Explicit Move up/Move down actions in the row sheet; a drag implementation may supplement them |

Tasks: keep the status/count trigger at 44 minimum; its sheet has Active,
Backlog and Done radio actions. Filters open a PhrenScreen with groups for
priority, age, project and store; optional “Any”/“All” values remain explicit.
Sort has its own action sheet. Selection actions keep their current Set and
permission checks; unavailable/busy actions disable. Swipe and sheet actions
must call the same handlers, including confirmation for destructive work.

Skills: navigation rows carry scope/store metadata; Enabled uses PhrenSwitch;
move destinations use an option group; delete/conflict messages use dialogs.
Agents: preserve sessionCard density, quiet section labels, live freshness
and independent pin/action targets when changing the scrolling container.
Settings: Boolean preferences become switches, cursor/platform modes text
segments, language and destination choices radio groups/sheets. Reordering
must gain explicit accessible actions before native lists are removed.
Graph: keep pan/zoom in the renderer; store/project/content choices use
sheets, connection depth a bounded stepper, and node deletion a dialog.
Saving a named view remains a text editor with Save/Cancel.

This commit does not silently restyle PhrenList or PhrenForm: doing so would
lose swipe, editing, selection and onMove behaviour at their existing callers.
Migrate those behaviours along with each screen.

## Fixture and verification

Debug `--controls-fixture` opens directly, without store bootstrap or live
connections. Pages are `switches`, `options`, `segments`, `fields`,
`navigation`, `presentations`, selected by `--controls-page <page>` or the
44-point previous/next controls. Every new control's meaningful normal,
selected, disabled and destructive states appears; inapplicable states are
called out above. The fixture also exercises glyphs, long labels, inherited
chat previews, schedule fields, and existing list/card vocabulary.

`--controls-accessibility` forces accessibility5 instead of the reproducible
large default. `--controls-reduce-motion` removes motion.
`--controls-presentation sheet|dialog|long-sheet|long-dialog` opens a modal
immediately. Long variants must keep the final action reachable by scrolling.

PhrenTests/ControlsKitTests covers optional/inherit single selection,
idempotent radio taps, independent set toggles, unavailable/removed choices,
action row identity/metadata, disabled actions, dismissal ordering and
stay-open actions. PhrenUITests/ControlsKitTests captures each fixture page
and presentation at Large and AX5 with Reduce Motion, and exercises selection,
disabled rows, sheet-to-dialog handoff, drag/backdrop dismissal and 44-point
row targets. Screenshots are retained as test attachments.

The orchestrator must build and run these tests and the existing Knobs
and ScheduleEditor UI tests. Inspect the resulting screenshots on a narrow
phone, then check VoiceOver focus/escape and keyboard-open field layouts.
Swift, xcodebuild and simulator tests cannot be run in the implementation
worktree; static review is not a claim of compilation or visual validation.

## PhrenSingleSelect

The single-choice sibling of `PhrenMultiSelect`: the same pill button and
sheet, one check mark, closes on choice. Rows accept a glyph, a title, a
caption and a trailing chip. Used for the schedule editor's computer,
harness and model, the chat `/model` picker and the launch flow's computer
chooser. Ids: `<identifier>` on the button, `<identifier>:<value>` on rows,
and `<identifier>-loading` on the loading row unless the owner supplies its
own `loadingIdentifier` (the chat picker's `model-loading`).

## PhrenStepSlider

A single choice over an ordered enumeration drawn as a slider: a 3pt track,
one dot per option, the chosen option's title under its dot in text color and
the rest muted, the thumb 18pt (22pt while dragging). A tap lands on the
nearest detent; a press (120 ms) then a drag slides the thumb with a selection
tick per detent; a plain drag is left to the list so a swipe that starts on the
slider still scrolls. The end titles hug the edges so nothing clips. Used for
the project knobs. Accessibility: one adjustable element whose value is the
current title.


## Chat prompt cards

Chat approvals and questions share the provider header ("Codex asks", "Claude
asks"), full title and explanation, a separate monospaced command line, and
PhrenOptionRow radio choices. Provider-supplied labels and order are preserved.
Terminal choices send their own keys; held permissions send their own decisions.
Without supplied choices, the order is Approve, Allow for this project, Allow
everywhere, Deny. Grant choices are disabled when the Hook cannot grant that
scope. Conductor grants are options in the same list, before Deny.

Terminal access is the small header action. Details expand through
PhrenDisclosure, a plain 44-point Button and inline content with an expanded or
collapsed accessibility value. Chat retains `chat-approval` and the
`chat-approval-approve`, `chat-approval-deny`, `chat-approval-allow-project` and
`chat-approval-allow-everywhere` row identifiers. The compact approval card used
outside chat keeps its existing presentation.

Project controls use equal columns in ProjectControlLayout: icon over one-line
title, 52-point height, matching centered dividers, 8 points below the navigation
bar. Values remain in each control's accessibility value. LiveSessionsTests
checks the band frame and four equal cell widths and attaches a screenshot.

## Terminal prompt cards

A terminal choice uses the provider's asking sentence and actual answer keys.
Option labels and descriptions are separate Text elements: the label uses the
row's body weight, and the description wraps below it in the supporting color.
The options retain their full height. Only long question text may fade and
show Show all; that control stays above the first option. Expansion preserves
the selected answer. Multi-question forms retain their full-sheet reading flow.

A held permission keeps structured arguments in a folded PhrenDisclosure named
Action details. JSON is never the asking sentence. A matching terminal dialog
supplies its own options and keys; an unresolved terminal permission offers
Open terminal instead of invented Yes/No answers.
