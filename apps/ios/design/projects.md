# Projects

The Projects tab starts with LiveStatusBar, any current action error and the
Projects grid. Cards show the project name, store when needed, ownership
badges and finding, task and note counts. There is no Explore section above
the grid and no Agent setup or maintenance section below it.

The toolbar keeps Add project, More, store filtering when multiple stores
exist, project search and the quick-capture mic for writable projects.
More is a PhrenActionSheet with Files, Memory graph, Live sessions, Skills,
Agent instructions and Memory maintenance. The store sheet uses the shared
radio choice rows. Project search uses PhrenSearchField. Empty stores keep
the connect-computer and add-project overlay.

## Hold to open an agent

A short tap on a project still opens its detail page. A 0.4-second
LongPressGesture with a light haptic opens a PhrenActionSheet titled with
the project name. Each known checkout computer has an Open agent on Desk
style row and its saved color dot. A single computer still gets a chooser.
No known checkout shows an explanation instead of guessing a destination.

Checkout matching uses SessionOverviewMonitor, the store's machine registry,
saved directory mappings and matched live sessions. Store identity remains
part of the match, including when two stores share a project name.

The project detail header and Project sessions show computer chips. Their
short tap opens project sessions from the detail header, or that computer's
workspaces from Project sessions. A hold shows that computer's projects with
an Open agent on Desk row for each. Session cards offer the same computer
chooser on hold while retaining their normal chat or terminal tap action.
Every hold target exposes the custom accessibility action Open agent.

Selecting a row presents LaunchSessionView with its store, project and
preferredHostID. The chosen computer stays selected when discovery finishes.
Harness, model and the final launch remain in the existing launch screen.
The chooser does not create an agent itself.

## Verification

ProjectsTests captures the grid, More destinations, the project computer
chooser, the computer project chooser and the launch screen. It checks both
short-tap navigation and the 0.4-second hold route. WorkflowTests reaches
Files through More. LaunchSessionTests covers the subsequent launch flow.
