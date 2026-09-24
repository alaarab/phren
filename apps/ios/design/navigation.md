# Tab navigation

Each top-level entry point has one owning tab. Projects has no More button
or More sheet.

| Tab | Entry points |
| --- | --- |
| Projects | Project grid, add project, project search, voice capture and store filter. Hold a project to choose a computer and open an agent. |
| Agents | Live sessions is the tab root. Sessions More opens Skills and Agent instructions, alongside its existing computer and session actions. |
| Tasks | Cross-project tasks and their status, filter, sort and selection controls. |
| Memory | Map and list share the tab root. Map is the memory graph. The header's folder opens Files; its wrench opens Memory maintenance; search stays beside them. |
| Settings | App preferences and connection settings. |

Projects reuses the other tabs' `PhrenNavigationStack`, `navigationTitle`
and `navigationBarTitleDisplayMode(.inline)` header pattern. Add, search
and mic are Phren icon buttons on the title line. The live freshness line
remains immediately below the navigation bar. The grid no longer repeats
the screen title in a section header. The store filter, empty state,
project rows and hold-to-open-agent flow retain their behavior.

Files opens the store's own files; a project's code lives on its Code page.
Memory maintenance opens the existing project maintenance list. Review widget links hand off
to Memory before opening maintenance. These destinations do not live in
Projects' navigation stack.

Contextual project actions remain in their existing screens: a project's
Skills control edits that project's skills, and a session's Explore graph
link opens its project graph, including named saved views. Those are scoped
workflows, not additional top-level shortcuts.

New controls use the [Phren control kit](controls.md). Memory's Files and
maintenance buttons have the identifiers `memory-files` and
`memory-maintenance`; Skills and Agent instructions retain
`sessions-more-sheet:skills` and `sessions-more-sheet:instructions`.
