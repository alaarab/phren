# Graph selection camera

The Memory map fills the space between its filter line and the tab bar.
Its web dossier stays anchored 12 points above the viewport's bottom safe
area, within thumb reach, and can grow to 45% of the viewport height.
Controls follow [the Phren control kit](controls.md).

Selecting a finding, task or project centers its projected node in the
uncovered rectangle. Reserve 24 points above the dossier, then center in
the space from the canvas top to that boundary. Measure the dossier's
actual top edge, including its bottom padding and safe area. SwiftUI already
excludes the tab bar from this viewport, so do not subtract it twice.

The camera translates along its view plane, preserving orientation and the
node's depth so the placement works at every zoom. The perspective offset
uses the viewport size, field of view and lens zoom. A ResizeObserver
recomputes placement when text changes the card's height or the viewport
resizes. Zoom buttons keep the selected node at the same free-space center.

Movement uses 0.18-second easing. Reduce Motion jumps immediately, including
when closing or resizing the dossier. Save the camera before the first
selection, keep that saved pose while stepping between nodes, and restore it
on deselection. Fit graph is an explicit new overview request.

Starting an orbit, pan or pinch cancels camera animation. Resizing the card
does not take control back during or after that gesture. Selecting another
node resumes automatic centering. Dossier scrolling does not move the camera.

The selected WebGL sprite exposes a transparent accessibility image at its
actual projected position (`memory-selected-node`). The UI regression test
compares that frame with the web dialog and the tab bar. Graph-core tests
cover free-space geometry; camera tests project through a perspective camera
to cover zoom, changing card heights, restoration, Reduce Motion and drag
interruption.
