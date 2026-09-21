# iPhone interaction and design notes

The user's September 8, 2026 screenshots compare Phren with Moshi. The useful
reference is the density and clarity of the interaction, while keeping Phren's
own colors and identity.

The shared control contract, dimensions, accessibility and migration recipes
live in [design/controls.md](design/controls.md). New control surfaces use that
kit; existing screens migrate with their selection and gesture behaviour.

- Give the work most of the screen. A session is a compact title and metadata
  row, with one primary tap to chat. Put terminal, Moshi, graph, and metadata in
  session details instead of repeating a second action row on every card.
- Put sessions across computers directly on Agents. Working and waiting come
  first; name the computer on every row. Connection management belongs below
  the work. Reveal the initial overview together after every computer's first
  response, with an eight-second ceiling for unreachable computers. Preserve
  cached content on return; later refreshes stay independent. Previous state
  must be visibly separate from live activity.
- Connection freshness and counts belong in a quiet inline status area. Herdr
  belongs in the computer toolbar. Neither needs a large promotional tile.
- Keep controls at least 44 points to touch. Reduce padding, duplicate controls,
  and extra rows before reducing text size. Allow rows to grow with Dynamic Type.
- Use exactly one terminal key bar, 48 points high. Esc, Tab, Ctrl, a directional
  pad, shortcuts, Paste, and keyboard visibility cover common input without
  another accessory row. The arrow pad includes centered Enter, Backspace,
  and Clear Line (Ctrl-E then Ctrl-U). A Ctrl hold opens shortcuts without also
  toggling Ctrl. Provider tabs and favorites insert commands without Enter.
  Herdr actions open native navigation for the current computer; they never
  assume a keyboard prefix shared by all servers.
- Slash suggestions are a bounded vertical list above the composer, with command
  names and descriptions. Picking one fills the draft; Send remains explicit.
- Two-finger swipes up open shortcuts; down hides the keyboard. These are local
  gestures, optional in the shortcut panel's gesture settings. Preserve all
  one-finger, pinch, link and selection behavior.
- A finger swipe scrolls. In a mouse-aware TUI such as Herdr, send wheel events;
  in a normal shell, scroll local history. Never reinterpret an ordinary drag as
  remote text selection or cursor-key input.
- Hold to select a word, then drag to extend the local selection. Copy and Paste
  are explicit actions in the standard context menu. Selection itself does not
  change either clipboard or send text to the computer. Paste adds no Enter and
  respects the terminal's bracketed-paste mode.
- Keep tappable terminal controls working, including Herdr's workspace switcher.
  Taps activate controls and explicit or plain web links immediately, with the
  keyboard hidden or visible. Only the keyboard button opens the keyboard;
  reading, selecting, pasting, and tapping must not steal the terminal's space.
  Pinch changes text size and the remote grid, fitting more columns for Herdr's
  sidebar when zoomed out. Tap coordinates must remain correct at every size.
  The graph similarly owns its pan gesture and uses its visible back button.
- Carry the screen background through project controls, including the Skills
  entry and section picker. Avoid unintentional black gutters between them.

Review the actual keyboard-open screen, not just the empty terminal. Test both
scroll directions, hold-and-drag, copy/paste, first-tap controls and links with
the keyboard hidden, pinch in/out, keyboard dismissal, and returning
from another app. Inspect standard and accessibility text sizes. A compact layout
must preserve session identity, freshness checks, and the optional Moshi default.

Moshi references: [keyboard controls](https://getmoshi.app/docs/keyboard) and
[gestures](https://getmoshi.app/docs/gestures). These are interaction references;
Phren uses its own UI and SwiftTerm's public APIs.
