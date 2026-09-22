# Native control migration

Counts below are Swift call sites: a word-boundary control name followed by an
opening parenthesis or brace. PhrenList and PhrenForm count at their native
implementation, not once per wrapper consumer. This differs from the task's
original inventory. The rows retain every affected file for follow-up work.

All 25 native Toggle calls now use PhrenSwitch. Labelled-row overloads preserve
rich captions, identifiers, 44-point targets and toggle accessibility. Existing
compact trailing switches retain their initializer.

The baseline and post-switch Xcode builds both stopped during package manifest
resolution: this environment denies nested sandbox-exec. Writable caches and
local checkouts did not remove that restriction. Under the build condition,
dialog, menu, picker, form/list and search replacement stops here. Switch syntax
parses, but the app still needs type checking in the orchestrator's build.

Before / after per file:

| File | Toggle | alert | confirmationDialog | Menu | contextMenu | Picker | Form | List | searchable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DesignSystem/PhrenTheme.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 2 / 2 | 0 / 0 |
| Features/Agents/AgentChatView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/AgentsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Features/Agents/ChangesHistoryTab.swift | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChangesTab.swift | 0 / 0 | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatAgentSwitcher.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatContentSecurity.swift | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatRichText.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/ChatTranscriptRows.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/FileDiffView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/HerdrWorkspacesView.swift | 0 / 0 | 1 / 1 | 1 / 1 | 1 / 1 | 2 / 2 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| Features/Agents/LiveHostEditor.swift | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/LiveSessionsView.swift | 0 / 0 | 3 / 3 | 2 / 2 | 0 / 0 | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 | 2 / 2 |
| Features/Agents/SessionCardContent.swift | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/SimulatorsView.swift | 0 / 0 | 2 / 2 | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Agents/TerminalControls.swift | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Files/FilesView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Graph/GraphView.swift | 0 / 0 | 2 / 2 | 1 / 1 | 4 / 4 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Notes/VoiceCaptureView.swift | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Projects/AddProjectView.swift | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Projects/ProjectsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 1 / 1 |
| Features/Review/ReviewView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 |
| Features/Review/TriageView.swift | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/AppearanceSettingsView.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/ChatSettingsView.swift | 3 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/CustomThemeEditor.swift | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/IntegrationSettingsViews.swift | 7 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/SettingsView.swift | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/SpeechSettingsView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/TerminalAdvancedSettingsView.swift | 6 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Settings/TerminalShortcutSettingsView.swift | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Shared/Components.swift | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Shared/DocumentEditorSheet.swift | 0 / 0 | 1 / 1 | 1 / 1 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Features/Skills/SkillsView.swift | 1 / 0 | 3 / 3 | 2 / 2 | 0 / 0 | 0 / 0 | 3 / 3 | 0 / 0 | 0 / 0 | 1 / 1 |
| Features/Tasks/TasksView.swift | 1 / 0 | 0 / 0 | 0 / 0 | 2 / 2 | 1 / 1 | 8 / 8 | 0 / 0 | 0 / 0 | 0 / 0 |

| Control | Before | After |
| --- | ---: | ---: |
| Toggle | 25 | 0 |
| alert | 17 | 17 |
| confirmationDialog | 13 | 13 |
| Menu | 15 | 15 |
| contextMenu | 12 | 12 |
| Picker | 27 | 27 |
| Form | 1 | 1 |
| List | 3 | 3 |
| searchable | 6 | 6 |
