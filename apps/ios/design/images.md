# Image previews

`PhrenImageViewer` is the shared image surface for conversation pictures,
attachment previews, uploaded computer files and repository file images.
Images embedded in tool cards use the conversation preview route too. The
current diff renderer has no raster image surface; any future diff image
should open this viewer with the original bytes.

The name uses PhrenTypography and wraps. Close uses PhrenIconButton's
44-point target and the `image-viewer-close` identifier. There is no native
navigation toolbar or sheet drag handle. The canvas is named "Image viewer"
with identifier `image-viewer`, and reports Fit or its zoom relative to fit.
Conversation thumbnails retain the "View conversation image" label.

## Gestures

- Fit preserves aspect ratio and centers the image without enlarging small
  images. Zoom ranges from fit to the larger of 4 times fit or actual size.
- Pinch keeps the source point beneath the fingers' midpoint, including
  midpoint movement. At the image edges, bounds take priority over anchoring.
- Double tap toggles fit and 1:1, meaning one source pixel per canvas point,
  anchored at the tap. An image already smaller than the viewport stays at
  fit on double tap and can still be enlarged with a pinch.
- One finger pans while zoomed. Every update clamps each axis to its image
  bounds; an axis smaller than the viewport stays centered. No fling or
  overscroll can leave the image off screen.
- At fit, a one-finger drag is recognized only when it starts more downward
  than sideways. It dismisses after 18% of the viewport height, bounded to
  80 through 160 points, with a predominantly downward final displacement.
  Short or canceled drags return to fit. A zoomed pan never dismisses.
- Reduce Motion removes the 0.18-second zoom/return animation and the
  finger-following dismissal offset. The dismiss threshold stays the same.
- VoiceOver can adjust zoom and use the escape gesture or Close.

## Decoding and lifetime

Original bytes survive the smaller transcript and upload thumbnails in a
memory-only source registry. Upload resizing and metadata stripping still
apply to what the agent receives. ImageIO reads dimensions and orientation
and prepares the opening raster up to 2,048 pixels on a detached worker.
The first zoom beyond fit requests an orientation-correct full decode on a
worker. A content-keyed cache shares both in-flight and completed full
decodes for the rest of the app session, including reopening another viewer
for the same bytes. Returning to fit keeps that decode. Nothing is written
to disk. Memory retained for viewed originals and full rasters grows with
the pictures viewed until the app session ends.

App unit tests cover fit, zoom limits, pan bounds, anchored zoom, dismissal,
original preservation and shared full decoding. The chat fixture UI test
opens a large picture, double taps in and out, and uses phren's close control.
