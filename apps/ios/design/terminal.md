# Terminal paste and gestures

Paste accepts text and images. Text follows the terminal's existing keystroke
path without adding Return. A clipboard image uses the same preparation and
Hook upload as a picked attachment, then inserts the uploaded path and a space
at the current cursor. Upload failures remain visible and do not insert a path.
The person finishes the prompt and presses Return.

Double tap invokes the same paste action. The single tap waits for double tap
to fail so pasting cannot also click a remote control. A hold selects text;
selection dragging, one-finger scrolling, pinch resizing and two-finger
shortcuts keep their existing gesture precedence. Double tap during an active
selection does not paste. Gesture settings describe the paste action.

Agent chat uses its system image paste and attachment picker. Its composer has
no separate clipboard icon.
