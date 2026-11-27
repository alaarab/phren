// Lists a Mac's windows and takes one still of one of them for the phone's
// mac-windows screen (bridge/mac-windows.ts). ScreenCaptureKit does both, so
// macOS asks once for the Screen Recording grant and nothing is composed from
// the desktop behind the window. `list` prints the windows as one JSON object;
// `snapshot` prints one JPEG of the window alone, scaled to the requested size
// and quality. Frames are points in global display coordinates with a top-left
// origin, the space CGWindow bounds and CGEvent use, so a fraction of the
// snapshot is the same fraction of the frame. Built on demand by Phren Hook
// with swiftc, like simtap and simcast.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

func fail(_ code: Int32, _ message: String) -> Never { FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(code) }

/// The JSON shapes of `list`; the phone decodes the same fields (MacWindow).
struct Frame: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}
struct Window: Encodable {
    let id: UInt32
    let app: String
    let bundleId: String?
    let pid: Int32
    let title: String
    let frame: Frame
    let onScreen: Bool
}
struct Listing: Encodable { let windows: [Window] }

/// The window's display, so the still is captured at the pixels the person
/// sees. NSScreen frames are bottom-left origin while SCK's are top-left, so
/// each is flipped into the window's space before the overlap is compared. A
/// helper without a window server sees no screens; 2 is the common Mac.
func displayScale(for frame: CGRect) -> CGFloat {
    guard let primary = NSScreen.screens.first else { return 2 }
    let top = primary.frame.maxY
    var scale: CGFloat = 2, area: CGFloat = 0
    for screen in NSScreen.screens {
        let screenFrame = CGRect(x: screen.frame.minX, y: top - screen.frame.maxY, width: screen.frame.width, height: screen.frame.height)
        let overlap = screenFrame.intersection(frame)
        let shared = overlap.isNull ? 0 : overlap.width * overlap.height
        if shared > area { area = shared; scale = screen.backingScaleFactor }
    }
    return scale
}

func list() async throws {
    guard CGPreflightScreenCaptureAccess() else { fail(3, "screen-recording") }
    let mine = getpid()
    let windows = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true).windows
    var rows: [Window] = []
    for window in windows {
        let frame = window.frame
        guard window.windowLayer == 0, frame.width >= 60, frame.height >= 60,
              let app = window.owningApplication, !app.applicationName.isEmpty,
              app.processID != mine, window.title != "Phren phone control" else { continue }
        rows.append(Window(id: window.windowID, app: app.applicationName,
                           bundleId: app.bundleIdentifier.isEmpty ? nil : app.bundleIdentifier,
                           pid: app.processID, title: window.title ?? "",
                           frame: Frame(x: Double(frame.origin.x), y: Double(frame.origin.y),
                                        width: Double(frame.width), height: Double(frame.height)),
                           onScreen: window.isOnScreen))
    }
    var encoded = try JSONEncoder().encode(Listing(windows: rows))
    encoded.append(0x0a)
    FileHandle.standardOutput.write(encoded)
}

func snapshot(id: CGWindowID, maxSide: Int, quality: Double) async throws {
    guard CGPreflightScreenCaptureAccess() else { fail(3, "screen-recording") }
    // Off-screen windows are still snapshottable by id, so list them all.
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == id }) else { fail(5, "no window") }
    let frame = window.frame
    guard frame.width >= 1, frame.height >= 1 else { fail(5, "no window") }

    // Capture at the display's pixels, then downscale only to fit maxSide. The
    // aspect is kept, so an image point maps straight onto the frame.
    let scale = displayScale(for: frame)
    let native = max(frame.width, frame.height) * scale
    let factor = native > CGFloat(maxSide) ? CGFloat(maxSide) / native : 1
    let config = SCStreamConfiguration()
    config.width = max(1, Int((frame.width * scale * factor).rounded()))
    config.height = max(1, Int((frame.height * scale * factor).rounded()))
    config.ignoreShadowsSingleWindow = true
    config.showsCursor = false

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)

    // ImageIO on a mutable CFData emits the JPEG bytes without a temp file.
    guard let jpeg = CFDataCreateMutable(nil, 0),
          let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil)
    else { fail(4, "JPEG encoder is unavailable") }
    CGImageDestinationAddImage(destination, image,
                               [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fail(4, "could not encode the JPEG") }
    FileHandle.standardOutput.write(jpeg as Data)
}

func run(_ args: [String]) async {
    let usage = "usage: wincap check | prompt | list | snapshot <id> <max-side 160-2400> <quality 0.1-1>"
    guard args.count >= 2 else { fail(2, usage) }
    do {
        switch args[1] {
        case "check": exit(CGPreflightScreenCaptureAccess() ? 0 : 3)
        case "prompt": exit(CGRequestScreenCaptureAccess() ? 0 : 3)
        case "list":
            guard args.count == 2 else { fail(2, usage) }
            try await list()
        case "snapshot":
            guard args.count == 5, let rawId = UInt32(args[2]), rawId >= 1,
                  let maxSide = Int(args[3]), (160...2400).contains(maxSide),
                  let quality = Double(args[4]), (0.1...1).contains(quality) else { fail(2, usage) }
            try await snapshot(id: rawId, maxSide: maxSide, quality: quality)
        default: fail(2, "unknown command \(args[1])")
        }
    } catch {
        fail(4, "\(error.localizedDescription)")
    }
    exit(0)
}

Task { await run(CommandLine.arguments) }
dispatchMain()
