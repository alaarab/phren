# Sync conflicts across computers

Your phren store is a Git repository, usually at `~/.phren`. Each computer has its own copy. To share memory, connect those copies to the same remote repository. Without a remote, memory stays on that computer.

A commit saves changes in the store's history. A pull brings in changes from the remote. A push sends your saved changes there. You can keep working offline. Other computers receive your changes after a successful push and pull.

## When sync happens

With managed sync and lifecycle hooks enabled, phren pulls at session start. It saves and pushes store changes after an agent response. Before bringing in remote changes, it commits pending local store edits.

If Phren Hook is running, it also syncs stores every five minutes by default, even without an active agent session. Readonly and pull-only stores receive changes but are not pushed automatically. Optional checks while the MCP server runs are separate and off by default. Enable those with `phren config pull-interval 60` for checks every minute.

Run `phren store sync` to pull changes now. Ask your agent to push store changes to send yours. Project-local stores inside a source repository use that repository's normal Git workflow instead of managed store sync.

## When two computers change the same thing

Changes to different files or different parts of a file usually combine without help. When changes overlap, phren uses the rules below. “Incoming” means the copy arriving from the remote during this pull. It does not necessarily mean the most recently edited copy.

| What changed | What phren does |
| --- | --- |
| Findings in `FINDINGS.md` | Keeps additions from both computers. A finding removed or archived on one stays removed if the other left it unchanged. An edit replaces an unchanged copy. If both computers change a finding's text differently, both versions remain. If one removes it and the other edits it, the edited version remains. |
| Daily notes in `notes/` | Combines changes per note. Keeps new notes from both computers. An edit replaces an unchanged note. A removal stays removed if the other left the note unchanged. If one removes it and the other edits it, the edit stays. If both edit it differently, phren combines both sets of lines, so review the result. Removing a day's file still allows new or edited notes from the other computer to survive. |
| Tasks in `tasks.md` | Combines changes per task. Keeps additions from both computers. A removal stays removed if the other left the task unchanged. If both change a task, a completed copy wins first, then an edit wins over a removal. Otherwise the incoming copy wins. Repeated task IDs are collapsed to one copy, preferring completed, then Active, then the copy with the most text. Independent changes to who owns a task and what it depends on combine; both task histories are kept. |
| `summary.md` | The generated “What phren knows” block takes the incoming block when present. Otherwise it keeps the local block. Handwritten text combines when the changes fit together. **If handwritten text conflicts, phren takes the whole incoming file, including its handwritten paragraph.** Later summary generation refreshes the generated block; it does not recover the overwritten paragraph. |
| Topic archives in `reference/topics/` | Keeps both sets of conflicting lines outside the generated “Now” block. The incoming “Now” block wins when present; otherwise the local block stays. |
| Archived tasks in `.config/task-archive/` | Combines both lists. A repeated task takes the incoming version. Repeated task IDs are collapsed. |
| `review.md`, `truths.md`, and files in `journal/` | Keeps both sets of conflicting lines. You may need to tidy the combined text. |
| `.config/maintenance-writer.json` | Takes the incoming copy. This file records which computer handles background maintenance. |
| Config and policy files, agent instructions, skills, and other files | If Git cannot combine the changes, phren stops the sync and names the files. It does not choose settings for you. This includes retention, workflow, and index policies. The protection for concurrent policy saves on one computer does not resolve conflicts across computers. |

For findings, tasks, and notes, if the usual merge cannot be used, phren tries to keep both sets of conflicting lines. The result may need cleanup. For files it knows how to handle, deleting the whole file on one computer while editing it on another keeps the edited file. Daily notes use the per-note rules above instead.

## What you see

Most memory conflicts resolve automatically. The combined files appear locally and can be pushed to the other computers. Sync records which files it resolved in `.runtime/background-sync.log` inside the store.

If any file cannot be resolved, phren cancels the whole attempted combination. Your local commits remain. The remote keeps its copy. Sync does not publish a partial result. `phren store sync` reports `NEEDS MANUAL RESOLUTION` and the file names. `phren status` and `phren doctor` show sync problems. Session start can also warn about a failed sync.

## Fix a conflict that sync could not resolve

Run `phren doctor` first to see the reason. `phren doctor --fix` can retry sync and repair repeated task IDs, but it cannot choose between conflicting settings or instructions.

For a file conflict, work in the affected store, not your project's source folder. Replace `~/.phren` below if the error names another store. Avoid editing the same store from agents while fixing it.

1. Run `cd ~/.phren`, then `git status`. If phren reports an unfinished Git operation, finish or cancel it using the command in the error. A failed cleanup may require `git merge --abort`.
2. Run `git pull --no-rebase` to bring the conflict back for you to resolve.
3. Open each file named by Git. Choose the text or settings you want to keep. Remove the lines starting with `<<<<<<<`, `=======`, and `>>>>>>>`. Check the other combined memory files too.
4. Run `git add <file>` for each resolved file. Run `git status` to check that none remain unresolved. Then run `git commit` and `git push`.
5. Run `phren store sync` on the other computer to receive the fix.

You can ask your agent to do these steps with your chosen settings. For overwritten summary text, ask it to recover the paragraph from the store's earlier commits and save the version you want. Sync preserves local commit history and keeps an extra pre-sync history backup for 14 days when both computers have new commits.
