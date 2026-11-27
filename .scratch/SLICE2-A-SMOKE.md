# Slice 2 A · native `wincap stream` smoke

Build the helper from one Swift file on a Mac with macOS 14 or later.

```bash
swiftc -typecheck packages/cli/src/bridge/native/wincap.swift
swiftc -O -o .scratch/wincap packages/cli/src/bridge/native/wincap.swift
.scratch/wincap check
.scratch/wincap list
```

Expect `check` to exit 0 with the Screen Recording grant and 3 without it.
Use `.scratch/wincap prompt` if needed, then grant access in System Settings.
Pick an on-screen, static, low-detail window, such as a blank TextEdit document
with no blinking insertion point. Its longest side must be at least 480 native
pixels. Keep it visible while stepping through the prompts.

```bash
python3 .scratch/macwin-record-smoke.py .scratch/wincap <id> h264
python3 .scratch/macwin-record-smoke.py .scratch/wincap <id> hevc
```

The Python 3 reader uses only the standard library. It reads the entire reply
before sending the next PULL, validates the record sizes, MWV1 header, PTS and
NAL framing, and checks that ordinary PULL after initial sync returns idle.
It exercises cached reset, both directions of a tier change, resize and
minimize/restore. For resize, change the aspect ratio so the coded dimensions
change even with the longest side capped. The shutdown checks use fresh helpers
that have already returned sync. Each fills stdout, submits one reset PULL
without draining the pipe, then sends STOP or closes stdin and expects exit 0
within two seconds.

Also check these cases on the granted Mac.

- Make a very small resize that preserves the coded dimensions, and move the
  window across Retina and non-Retina displays. Watch for a sync frame after
  each geometry change. Decode the video and verify that there is no padding,
  clipping or content from overlapping windows.
- Pause motion until idle, then move or scroll within the window. The first
  new frame after the idle gap should be sync even for a gap under two seconds.
- Close the window mid-stream and expect exit 5. Revoke Screen Recording
  mid-stream and expect exit 3. An unavailable codec/profile should exit 6.
- Replace the installed CLI's source-hash-built helper and check whether it
  retains the existing Screen Recording grant.
