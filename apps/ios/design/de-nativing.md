# Native control migration

Counts below are Swift call sites: a word-boundary control name followed by an
opening parenthesis or brace. PhrenList and PhrenForm count at their native
implementation, not once per wrapper consumer. This differs from the task's
original inventory. The rows retain every affected file for follow-up work.

All 25 native Toggle calls now use PhrenSwitch. Labelled-row overloads preserve
rich captions, identifiers, 44-point targets and toggle accessibility. Existing
compact trailing switches retain their initializer.

The remaining native controls are migrated in this pass:

- Alerts and confirmationDialogs became phrenDialog at the same full-screen
  root, with the same actions, roles and identifiers. Text-entry alerts
  (Herdr workspace/tab editing, simulator type/URL, graph view naming) became
  small PhrenScreen editor sheets with explicit Save/Cancel so no input is lost.
- Menus and contextMenus became action sheets (commands) or
  PhrenSingleSelectSheet (value choices) opened from a 44-point button that
  keeps the original identifier. A contextMenu gained an explicit visible
  action button; the long press, where it existed, opens the same sheet.
- Pickers became PhrenSingleSelect, segmented Pickers PhrenTextSegment per the
  controls.md recipe, and ordered 3-to-5-value scales PhrenStepSlider
  (terminal cursor style, task priority).
- The three owned searchable modifiers became PhrenSearchField, and ReviewView's
  native `List(selection:)` became a ScrollView with `sessionCard()` rows, a
  plainListSectionLabel caption per section and explicit edit-mode selection.

PhrenList and PhrenForm keep their native List/Form internals. controls.md
forbids silently restyling them: their 36 call sites use swipeActions, onDelete,
listRowInsets/Background, Section headers and footers, and List selection, and
those behaviours would drop without a per-screen migration. Only the one
standalone `List(selection:)` in ReviewView was replaced. The Form and List
counts therefore remain 1 and 2 until each consumer screen migrates with its
list behaviour.

This final pass also migrated workspace order and chat destinations, website
confirmation, the remaining command-output context menu, custom RGB color
editors, and attachment paste. MemoryPanel, TerminalControls, SchedulesView and
ChangesWorkingTreeTab already used phren controls when this pass started.
The explicit external-link-open identifier is preserved on the dialog action;
UI tests find the replacement controls by identifier.

The only remaining native controls in this audit are in LiveSessionsView,
which belongs to another worker, and the retained PhrenForm/PhrenList wrappers.
System photo-library, camera, document-import and sharing services retain their
platform presentation; their launch controls are phren buttons.

Before / after per file (before retains the initial audit inventory; newly
listed files use their count at the start of this pass):

| File | Toggle | alert | confirmationDialog | Menu | contextMenu | Picker | Form | List | searchable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DesignSystem/PhrenTheme.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 2 / 2 | 0 / 0 |
| Features/Agents/AgentChatView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/AgentsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| Features/Agents/ChangesHistoryTab.swift | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChangesTab.swift | 0 / 0 | 1 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChangesWorkingTreeTab.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatAgentSwitcher.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatAttachmentPicker.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatContentSecurity.swift | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatRichText.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatTranscriptRows.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/FileDiffView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/HerdrWorkspacesView.swift | 0 / 0 | 1 / 0 | 1 / 0 | 1 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| Features/Agents/LiveHostEditor.swift | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/LiveSessionsView.swift | 0 / 0 | 3 / 3 | 2 / 2 | 0 / 0 | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 | 2 / 1 |
| Features/Agents/SessionCardContent.swift | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/SimulatorsView.swift | 0 / 0 | 2 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/TerminalControls.swift | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Files/FilesView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Graph/GraphView.swift | 0 / 0 | 2 / 0 | 1 / 0 | 4 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Memory/MemoryPanel.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Notes/VoiceCaptureView.swift | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Projects/AddProjectView.swift | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Projects/ProjectKnobsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Projects/ProjectsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| Features/Review/ReviewView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 |
| Features/Review/TriageView.swift | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Schedules/SchedulesView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/AppearanceSettingsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/ChatSettingsView.swift | 3 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/CustomThemeEditor.swift | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/IntegrationSettingsViews.swift | 7 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/SettingsView.swift | 0 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/SpeechSettingsView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/TerminalAdvancedSettingsView.swift | 6 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/TerminalShortcutSettingsView.swift | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Shared/Components.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Shared/DocumentEditorSheet.swift | 0 / 0 | 1 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Skills/SkillsView.swift | 1 / 0 | 3 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 3 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| Features/Tasks/TasksView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 2 / 0 | 1 / 0 | 8 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

| Control | Before | After |
| --- | ---: | ---: |
| Toggle | 25 | 0 |
| alert | 17 | 3 |
| confirmationDialog | 13 | 2 |
| Menu | 15 | 0 |
| contextMenu | 12 | 1 |
| Picker | 27 | 1 |
| Form | 1 | 1 |
| List | 3 | 2 |
| searchable | 6 | 1 |

Additional native controls omitted from the original inventory:

| File | ColorPicker | PasteButton |
| --- | --- | --- |
| Features/Agents/ChatAttachmentPicker.swift | 0 / 0 | 1 / 0 |
| Features/Settings/CustomThemeEditor.swift | 1 / 0 | 0 / 0 |
| Features/Agents/LiveHostEditor.swift | 1 / 0 | 0 / 0 |
| Features/Projects/ProjectKnobsView.swift | 1 / 0 | 0 / 0 |

ColorPicker: 3 / 0. PasteButton: 1 / 0. All assigned files now have zero native
control calls from this inventory. PhrenForm and PhrenList remain unchanged.
