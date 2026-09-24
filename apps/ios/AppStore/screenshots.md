# Screenshot plan

Screenshots should show how the phone helps while agents work: explore memory,
check sessions, and add direction. Lead with the memory graph.

## What Apple requires

- **6.9" iPhone** (1320 × 2868 portrait) — **required**. A 16 Pro Max or
  the matching simulator produces these natively.
- 6.5" and other sizes are optional; App Store Connect scales the 6.9"
  set down. Skip them for v1.
- 3 to 10 images. **Only the first two or three are visible without
  scrolling** — those carry the entire positioning argument.
- No alpha channel. No device frames required (Apple scales raw captures
  fine).
- iPad screenshots are not needed — the app is `TARGETED_DEVICE_FAMILY: 1`
  (iPhone only).

## The set, in order

Show memory and agents first, capture and optional maintenance later.

**1 — Memory graph.** A project's connected findings, with a selected node
and its neighborhood visible. Use readable technical knowledge from the demo
store and keep enough surrounding nodes visible to explain the connections.

Caption: *Explore what your agents know.*

**2 — A project's findings.** Real technical content — the collapsed
5-line cards with a `[pattern]` or `[architecture]` tag chip visible. The
text should be visibly *engineering* knowledge, not errands. Something
like the Angular `@Directive()` finding or a build-tooling pitfall reads
instantly as developer tooling.

Caption: *Your agents' knowledge, in a repo you own.*

**3 — Projects list or Agents tab.** Multiple projects with their findings,
tasks and notes counts, or a connected demo computer's live sessions. Session
states must come from a real connection or a clearly identified demo fixture.

Caption: *Every project your agents work on.*

**4 — Siri capture.** The Siri interface with "Add a phren task" and the
confirmation naming the destination project. Sells hands-free capture and
the OS integration.

Caption: *Capture from the Lock Screen, hands-free.*

**5 — Store health in Settings.** Sync state, pending writes, read-only
warnings. Signals seriousness and that it handles multi-repo setups.

Caption: *Know exactly what synced, and what didn't.*

**6 (optional) — Search or memory maintenance.** On-device results across
projects, or the optional maintenance overview grouped by project and store.

Caption: *Search everything, offline.* or *Handle maintenance project by project.*

## Rules for the content on screen

- **Use the demo store, not your real one.** Screenshots are public
  forever. Nothing from a work repository, no employer names, no
  colleagues' names, no internal hostnames or ticket numbers.
- Findings on screen should be genuinely readable technical statements —
  a blurred or lorem-ipsum screenshot reads as a fake app.
- Status bar: full battery, full signal, a clean time. The simulator gives
  you this for free (`xcrun simctl status_bar` can override it).
- Dark theme throughout — it's the app's identity and it's what ships.

## Capturing

Simulator is easier than a device and gives exact pixel sizes:

```
# boot a 6.9" device
xcrun simctl list devicetypes | grep "Pro Max"
xcrun simctl boot "iPhone 16 Pro Max"

# clean status bar
xcrun simctl status_bar "iPhone 16 Pro Max" override \
  --time "9:41" --batteryState charged --batteryLevel 100 \
  --cellularBars 4 --wifiBars 3

# capture
xcrun simctl io "iPhone 16 Pro Max" screenshot ~/Desktop/phren-01.png
```

Wait for the graph to load before selecting a node and capturing its neighborhood.

Save the final set to `apps/ios/AppStore/screenshots/` (gitignored if they
get large; otherwise commit them — they're small PNGs and worth versioning
alongside the copy).

## App preview video (optional, skip for v1)

A 15–30s video can follow a connected finding through the graph, open its
project instructions, and check an agent session. Use demo data throughout.
