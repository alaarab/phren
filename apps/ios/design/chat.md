# Chat activity

One activity row belongs to each source-stamped turn. Transcript preparation
chooses its owner and position, including its placeholder label. A working row
stays at the end under the user message and subsequent tool or assistant rows.
It hides while a question, terminal prompt, password or approval needs an answer.

The initial verb is Thinking. After assistant text it is Responding. An active
tool uses ToolPresentation's decoded card title: Read becomes Reading, Patch
and Write become Editing, and other titles become Running <title>, including
Running Shell. Once tool calls return, Working covers the gap before more text.
Tool results, changes and background notifications do not start tool activity.
Only the current turn's calls choose its verb.

Use Phren's activity arc and muted caption color, with no card chrome. Reduce
Motion leaves a static arc. The clock ticks at 1 Hz in the row alone. Pin the
row to the transcript width and a 24-point caption-scaled height, and reserve a
104-point caption-scaled timer slot with monospaced digits. Seconds becoming
minutes must never change the row frame or move the transcript. Pause the clock
and arc while the scene is inactive. The row is one accessibility element with
children ignored and identifier chat-activity.

On completion, place one quiet line above the final reply: Thought for 27s
without tools, Worked for 1m 12s with tools, or Stopped after 12s for a stopped
turn. This line never spins and uses chat-activity-done. Persisted transcript
startedAt and finishedAt supply the duration on reopening. A missing start or
end gives no completed line. A local submit timestamp only fills the live gap
before the harness acknowledges the turn; it never invents a saved duration.
Completed placeholders retain the same identifier and label.
