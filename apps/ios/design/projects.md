# Projects

The Projects tab starts with LiveStatusBar, any current action error and the
Projects grid. Cards show the project name, store when needed, ownership
badges and finding, task and note counts. There is no Explore section above
the grid and no Agent setup or maintenance section below it.

The inline title shares its row with Add project, project search and the
quick-capture mic for writable projects. Store filtering remains available
when multiple stores exist. Projects has no More button: Memory owns Files,
the graph and Memory maintenance; Agents owns Live sessions, Skills and Agent
instructions. See [tab navigation](navigation.md). The store sheet uses the shared
radio choice rows. Project search uses PhrenSearchField. Empty stores keep
the connect-computer and add-project overlay.

The project detail band has four equal columns, each with an icon above a
single-line title, a 52-point height and space below the inline title. Project
name colors use the same eight-color palette as computers, plus the custom
color wheel and hex field. Knobs use PhrenStepSlider with visible stops, a
current-value label and a reset glyph for overrides.

## Hold to open an agent

A short tap on a project still opens its detail page. A 0.4-second hold with
a light haptic opens a PhrenActionSheet titled "Open on computer · project ·
store". Project and store appear once in that header. Rows show the computer's
name and saved color dot, Working or Idle, and its session count for this
store/project. Offline computers remain visible and disabled, with the
connection or verification reason and last-seen time when available.

Reachable computers precede unreachable computers; each group sorts by most
recent use, then name with stable identity as the tie-breaker. Successful
launches record use by store, project and computer. Opening or cancelling the
launch editor does not record use. Existing session activity provides recency
when available. A first "Open on Desk" shortcut names the last computer used
for that project, retaining its disabled state and reason if it is offline.
A single computer still gets a chooser. No known checkout shows an explanation.

More than eight computers adds PhrenSearchField beneath the stationary header.
It searches names and status captions; the list fits content until the shared
85% cap, then scrolls. Fifty computers must not require scrolling to find one.
All rows keep `project-agent-sheet:store:project:hostID`; the shortcut is
`project-agent-sheet:recent` and search is `project-agent-sheet:search`.

Checkout matching uses SessionOverviewMonitor, the store's machine registry,
saved directory mappings and matched live sessions. Session counts and recency
keep store identity when two stores contain the same project name. Opening the
chooser starts the shared overview if needed, so connection state updates live.

Project detail and Project sessions keep computer chips. Short taps retain
their session/workspace route. Holding a computer offers its project names,
store and status beneath an "Open project on Desk" header. Session cards retain
the same project computer chooser on hold. Every hold target exposes the
custom accessibility action Open agent.

Selecting an enabled row presents LaunchSessionView with store, project and
preferredHostID. The preferred computer stays selected when discovery finishes.
Harness, model and final launch remain in that screen. The chooser itself does
not create an agent.

## Verification

ProjectsTests captures the grid, inline header, the project computer
chooser, the computer project chooser and the launch screen. It checks both
short-tap navigation and the 0.4-second hold route. WorkflowTests reaches
Files through Memory. LaunchSessionTests covers the subsequent launch flow.

SelectionSheetTests covers the 22-option multi-select, search-independent chips
and Done count, short-card density, and the 50-computer chooser's recency,
reachability, search and unavailable reasons. App unit tests cover filtering,
selection preservation, counts, ordering and store-scoped recency.
