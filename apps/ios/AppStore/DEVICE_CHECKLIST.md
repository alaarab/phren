# Device release check

Record the build number, iPhone model, iOS version, and result for each check.
Simulator success is not a substitute for this pass. Use a disposable store
for writes and an ordinary read-only store to verify disabled controls.

- Open the graph for each store; identical project names must stay separate.
- Orbit, pinch, zoom, and fit a large graph. Background and foreground the app,
  then confirm rendering recovers without excessive heat or a blank view.
- Search, focus one/two steps, go back, save a view, terminate, and restore it.
- Optionally save a Moshi session link and open it from the project and graph.
  Verify it reaches the intended session on the intended computer, including
  a workspace/pane target. Close that session in Moshi and check its fallback.
  Remove the link and confirm the Phren project remains usable.
- Remove a bookmarked node/project remotely and confirm the explanation and
  fallback view. Remove its store from the phone and reopen the bookmark.
- Disable a project skill and a global skill; pull on the desktop and verify
  the expected manifests, skill links, and generated instructions update.
- Make two offline skill choices on the phone, change another skill on the
  computer, then sync; all independent choices should survive.
- Change the same skill setting or instructions on two devices and confirm
  the conflicting phone operation appears in Settings → Needs attention.
- Queue offline task, instruction, and skill changes; install a newer signed
  build over this one and confirm every pending operation survives and syncs.
- Verify configured GitHub device sign-in, denied/expired approval, cancellation,
  and token sign-in using a test account.
- Confirm widgets read the shared App Group after a sync, and test voice,
  Siri capture from the Lock Screen, review triage, and store permissions.

Current verification: automated Swift, renderer, and native interaction tests,
plus unsigned simulator and Release builds.
Development profiles include the App Group. Signed archive, device pass, and
TestFlight upload remain pending signing-key access and account setup.
