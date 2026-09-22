# Files

All file entry points use `FileViewer`: computer uploads, project repository
browsing, working-tree rows, store documents and chat image attachments.
Absolute paths and project-relative paths in chat prose and tables become
links only after a zero-byte Hook read confirms a regular file exists.
Markdown file links also wait for this check. The check is coalesced and cached
for 15 seconds, scoped to the exact computer and conversation. Each rendered
block checks at most 24 distinct candidates. Missing paths stay plain text.

## Transport and cache

`GET /v1/files/range` accepts `path`, `offset` and `length`. It selects a root
using `project` plus an optional exact located `directory`, the existing pane
identity fields plus optional `child`, or `scope=uploads`. A pane resolves to
its Git root; a pane outside Git cannot grant file access. Uploads are
restricted to the Hook's uploads root. Git ignore rules do not restrict reads.
No unchecked directory grants access. Traversal, Git internals, nonregular
files and symbolic links are refused.

The JSON response carries `offset`, `length`, `total`, `contentType`, `version`,
`eof` and base64 `data`. Reads return at most 4 MiB of decoded bytes; the phone
normally requests 1 MiB and allows a 6,000,000-byte gateway response, enough
for the largest base64 chunk plus metadata. `length=0` returns metadata only.
At EOF the range is empty; offsets past EOF return 416. A supplied `version`
must still match the file identity, size and modification times, or the Hook
returns 409. Every chunk rechecks metadata after reading.

The phone writes each chunk to a cache file and synchronizes it before showing
the new progress. The original extension is preserved. Metadata and actual
file length let a reopened viewer resume across process termination. A changed
remote version starts a fresh download. Files are isolated by computer, scope
and path. Backgrounding pauses the SSH work; foregrounding resumes paused
work. Cancel keeps downloaded bytes and offers Resume, and stays canceled on foregrounding. Closing cancels work.
Playback starts after the download completes. There is no whole-file network
response limit and no arbitrary media file size cap; available disk space is
the practical limit. The OS may evict cached files, which will download again.

## Renderers

| Type | Presentation |
| --- | --- |
| Video and audio | AVPlayer with phren play/pause, scrubber, elapsed/total time, mute and fullscreen controls |
| PDF | PDFKit content, with phren previous/next page controls and page count |
| Markdown | The chat renderer |
| Source code, configuration and logs | CodeHighlighting or plain UTF-8 text |
| JSON up to 1 MiB | Sorted, indented object/array rows with phren disclosure buttons, 100 children at a time, depth limit 64 |
| Larger JSON | Streaming pretty printer with foldable pages |
| CSV | Two-axis table, 100 records per page, quoted newlines and escaped quotes preserved |
| Images | The existing pinch/actual-size/pan canvas within shared file chrome |
| Other types | File card with Save to Files and Share |

Specific content types take precedence over extensions; generic text and
binary types allow the extension to select a richer renderer. Media playback
uses formats/codecs available to AVPlayer on that iPhone. Unsupported or corrupt
media retains Save and Share. Picture in picture is not implemented.

Text reads use 32 KiB pages (at most 64 KiB for the paging API), preserving UTF-8
boundaries. Only the current page and lightweight previous-page cursors stay
in the viewer. A single CSV record is bounded to 256 KiB; an oversized or invalid
record offers the same export path. Markdown page boundaries prefer newlines;
very long paragraphs and fences can span pages. Text formats must be UTF-8.

## Controls

File chrome uses theme colors, PhrenTypography, and 44-point PhrenIconButton
targets. The header owns Close, Save, Share and any document actions. Fullscreen
media hides the header; Exit fullscreen restores it. The scrubber is drawn with
phren's track, thumb and colors and supports VoiceOver ten-second adjustments.
Progress uses the same track and reports downloaded/total bytes. PDFKit and
AVPlayer contribute content only, with no native viewer toolbars. Save to Files
and Share explicitly hand the local file to the system destination picker or
share surface after the corresponding phren action.

Stable identifiers include `file-viewer-video`, `file-viewer-audio`,
`file-viewer-pdf`, `file-viewer-json`, `file-media-play`, `file-media-scrubber`,
`file-media-mute`, `file-media-fullscreen`, `file-pdf-next`, `file-json-fold:root`,
`file-download-progress` and `file-download-toggle`.

## Verification

Bridge tests assemble a 12 MiB + 37 byte ignored file using 4 MiB chunks and
read a four-byte tail past 3 GiB in a sparse file. They cover empty files, EOF,
out-of-range offsets, invalid numbers, traversal, symlink escapes and version
changes. PhrenKit tests assemble and resume a 9 MiB + 17 byte file, reject bad
chunks, and check type detection, split UTF-8, streaming JSON and quoted CSV.
App tests cover renderer selection and existence-gated chat links. Simulator UI
tests generate a real two-second H.264 MP4, a two-page PDF and nested JSON, then
open them through the computer Files screen and exercise phren controls.
