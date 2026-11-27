// Lists a Mac's windows and takes one still of one of them for the phone's
// mac-windows screen (bridge/mac-windows.ts). ScreenCaptureKit does both, so
// macOS asks once for the Screen Recording grant and nothing is composed from
// the desktop behind the window. `list` prints the windows as one JSON object;
// `snapshot` prints one JPEG of the window alone, scaled to the requested size
// and quality. Frames are points in global display coordinates with a top-left
// origin, the space CGWindow bounds and CGEvent use, so a fraction of the
// snapshot is the same fraction of the frame. Built on demand by Phren Hook
// with swiftc, like simtap and simcast.
//
// `stream` is the live slice: the Hook drives one VideoToolbox encoder with
// PULL/STOP lines on stdin and forwards each encoded access unit to the phone.
import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import VideoToolbox

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

func eligibleApplication(for window: SCWindow) -> SCRunningApplication? {
    let frame = window.frame
    guard window.windowLayer == 0, frame.width >= 60, frame.height >= 60,
          let app = window.owningApplication, !app.applicationName.isEmpty,
          app.processID != getpid(), window.title != "Phren phone control" else { return nil }
    return app
}

func list() async throws {
    guard CGPreflightScreenCaptureAccess() else { fail(3, "screen-recording") }
    let windows = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true).windows
    var rows: [Window] = []
    for window in windows {
        let frame = window.frame
        guard let app = eligibleApplication(for: window) else { continue }
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

// MARK: - Live window stream

/// One row of the slice-2 tier table. `size` is the longest coded side in
/// pixels; `fps` paces SCK and sets the VT frame duration; `bitrate` is the
/// video wire target in bits per second.
struct TierSpec {
    let size: Int
    let fps: Int
    let bitrate: Int
}

let streamTiers: [TierSpec] = [
    TierSpec(size: 320, fps: 5, bitrate: 96_000),
    TierSpec(size: 480, fps: 8, bitrate: 160_000),
    TierSpec(size: 640, fps: 10, bitrate: 240_000),
    TierSpec(size: 960, fps: 12, bitrate: 384_000),
]

func tierSpec(_ tier: Int) -> TierSpec { streamTiers[tier] }

/// The coded size the wire carries. Always even and at most the tier size.
struct Dimensions: Equatable {
    let width: Int
    let height: Int
}

enum StreamCodec: String {
    case h264
    case hevc

    var cmCodecType: CMVideoCodecType { self == .h264 ? kCMVideoCodecType_H264 : kCMVideoCodecType_HEVC }
    var profileLevel: CFString {
        self == .h264 ? kVTProfileLevel_H264_Baseline_AutoLevel : kVTProfileLevel_HEVC_Main_AutoLevel
    }
}

/// Scale the window's native pixel size to the tier's longest side, keep the
/// aspect ratio, round each side to an even number of pixels and never exceed
/// the native size. A window smaller than the tier is sent at native size.
func codedDimensions(native: CGSize, tier: Int) -> Dimensions? {
    let nativeWidth = Double(native.width)
    let nativeHeight = Double(native.height)
    guard nativeWidth.isFinite, nativeHeight.isFinite, nativeWidth >= 2, nativeHeight >= 2 else { return nil }
    let cap = Double(tierSpec(tier).size)
    let longest = max(nativeWidth, nativeHeight)
    let factor = min(1.0, cap / longest)

    func even(_ value: Double, atMost limit: Double) -> Int {
        var pixels = Int(min(value, limit).rounded())
        if pixels % 2 == 1 { pixels -= 1 }
        if pixels < 2 { pixels = 2 }
        if pixels > 960 { pixels = 960 }
        return pixels
    }

    return Dimensions(width: even(nativeWidth * factor, atMost: nativeWidth),
                      height: even(nativeHeight * factor, atMost: nativeHeight))
}

func appendBE16(_ data: inout Data, _ value: UInt16) {
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8(value & 0xff))
}

func appendBE32(_ data: inout Data, _ value: UInt32) {
    data.append(UInt8((value >> 24) & 0xff))
    data.append(UInt8((value >> 16) & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8(value & 0xff))
}

func appendBE64(_ data: inout Data, _ value: UInt64) {
    for shift in stride(from: 56, through: 0, by: -8) {
        data.append(UInt8((value >> shift) & 0xff))
    }
}

func monotonicMicros() -> UInt64 { DispatchTime.now().uptimeNanoseconds / 1000 }

/// stdin owns cancellation. The lock covers only credit bookkeeping and
/// nonblocking writes, so no capture, encoder or pipe wait can delay STOP.
private final class StreamPipe: @unchecked Sendable {
    private let lock = NSLock()
    private var pullOutstanding = false
    private var outputConfigured = false // Only the state queue writes.

    func finish(_ code: Int32, _ message: String = "") -> Never {
        // Keep the output gate closed through _exit. In particular, avoid
        // teardown calls and Swift/Foundation shutdown on the input thread.
        lock.lock()
        if code != 0 {
            let flags = fcntl(STDERR_FILENO, F_GETFL)
            if flags >= 0, fcntl(STDERR_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 {
                _ = (message + "\n").withCString { write(STDERR_FILENO, $0, strlen($0)) }
            }
        }
        _exit(code)
    }

    func claimPull() {
        let accepted = lock.withLock {
            if pullOutstanding { return false }
            pullOutstanding = true
            return true
        }
        guard accepted else { finish(2, "pipelined pull") }
    }

    func send(tag: UInt8, body: Data?) {
        if !outputConfigured {
            let flags = fcntl(STDOUT_FILENO, F_GETFL)
            guard flags >= 0, fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) == 0
            else { finish(4, "stdout-pipe") }
            outputConfigured = true
        }
        var record = Data()
        appendBE32(&record, UInt32(1 + (body?.count ?? 0)))
        record.append(tag)
        if let body { record.append(body) }
        record.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                lock.lock()
                let written = write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                let error = errno
                if written > 0 { offset += written }
                if offset == bytes.count { pullOutstanding = false }
                lock.unlock()

                if written > 0 || (written < 0 && error == EINTR) { continue }
                guard written < 0, error == EAGAIN else { finish(4, "stdout-pipe") }
                var fd = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                if poll(&fd, 1, 50) < 0, errno != EINTR { finish(4, "stdout-pipe") }
            }
        }
    }
}

private struct CaptureGeometry: Equatable {
    let native: CGSize
    let scale: CGFloat

    init(window: SCWindow) {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let rect = filter.contentRect.isEmpty ? window.frame : filter.contentRect
        scale = filter.pointPixelScale > 0 ? CGFloat(filter.pointPixelScale) : displayScale(for: window.frame)
        native = CGSize(width: rect.width * scale, height: rect.height * scale)
    }
}

private struct RawFrame {
    let image: CVPixelBuffer
    let crop: CGRect
    let serial: UInt64

    init?(sample: CMSampleBuffer, attachments: [SCStreamFrameInfo: Any],
          geometry: CaptureGeometry, dims: Dimensions, serial: UInt64) {
        guard let image = CMSampleBufferGetImageBuffer(sample),
              CVPixelBufferGetWidth(image) == dims.width, CVPixelBufferGetHeight(image) == dims.height,
              let dictionary = attachments[.contentRect] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: dictionary),
              let scale = attachments[.scaleFactor] as? CGFloat, scale.isFinite, scale > 0,
              let contentScale = attachments[.contentScale] as? CGFloat, contentScale.isFinite, contentScale > 0
        else { return nil }

        // SCK reports the visible rectangle in points. Convert it to surface
        // pixels, then undo SCK's content scaling to check the source geometry.
        let pixels = rect.applying(CGAffineTransform(scaleX: scale, y: scale))
        let bounds = CGRect(x: 0, y: 0, width: dims.width, height: dims.height)
        let visible = bounds.intersection(pixels)
        // The content rectangle can round by a pixel at the capture scale.
        guard abs(scale - geometry.scale) < 0.01,
              abs(pixels.width - geometry.native.width * contentScale) <= 1.5,
              abs(pixels.height - geometry.native.height * contentScale) <= 1.5,
              visible.width >= 1, visible.height >= 1 else { return nil }

        self.image = image
        self.crop = CGRect(x: visible.minX, y: bounds.height - visible.maxY,
                           width: visible.width, height: visible.height)
        self.serial = serial
    }

    func scaled(to dims: Dimensions, pool: CVPixelBufferPool?, context: CIContext) -> CVPixelBuffer? {
        if crop == CGRect(x: 0, y: 0, width: dims.width, height: dims.height) { return image }
        guard let pool else { return nil }
        var output: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output) == kCVReturnSuccess,
              let output else { return nil }
        let content = CIImage(cvPixelBuffer: image).cropped(to: crop)
            .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
            .transformed(by: CGAffineTransform(scaleX: CGFloat(dims.width) / crop.width,
                                               y: CGFloat(dims.height) / crop.height))
        context.render(content, to: output, bounds: CGRect(x: 0, y: 0, width: dims.width, height: dims.height),
                       colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        return output
    }
}

private struct PullRequest {
    let token: UInt
    let reset: Bool
}

private struct Submission {
    let token: UInt
    let pts: UInt64
    let wantsSync: Bool
}

private let vtOutputStreamCallback: VTCompressionOutputCallback = { refcon, frameRefcon, status, flags, sample in
    guard let refcon, let frameRefcon else { return }
    let streamer = Unmanaged<WindowStreamer>.fromOpaque(refcon).takeUnretainedValue()
    streamer.receiveEncoded(token: UInt(bitPattern: frameRefcon), status: status, flags: flags, sample: sample)
}

// SCWindow is a read-only snapshot. Transfer the selected window only.
private enum WindowLookup: @unchecked Sendable {
    case found(SCWindow)
    case missing
    case failed
}

/// One capture, one cached image, and one PULL from admission through its
/// response. Capture and VT state live on stateQueue. The independent monitor
/// owns permission/identity checks, even during a blocked encode or write.
private final class WindowStreamer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let windowID: CGWindowID
    private let codec: StreamCodec
    private let pipe = StreamPipe()
    private let stateQueue = DispatchQueue(label: "phren.wincap.stream")
    private let monitorQueue = DispatchQueue(label: "phren.wincap.monitor")

    // monitorQueue
    private var originalPID: pid_t?
    private var monitor: DispatchSourceTimer?
    private var lookup: UInt64 = 0
    private var lookupInFlight = false
    private var classifyingFailure = false

    // stateQueue
    private var window: SCWindow?
    private var geometry: CaptureGeometry?
    private var tier = 1
    private var stream: SCStream?
    private var appliedGeometry: CaptureGeometry?
    private var appliedTier: Int?
    private var dimensions: Dimensions?
    private var transitioning = false
    private var transitionID: UInt64 = 0
    private var captureFailed = false
    private var rebuildForResume = false
    private var resumeNeedsSync = true

    private var rawFrame: RawFrame?
    private var rawSerial: UInt64 = 0
    private var lastSubmittedSerial: UInt64 = 0
    private var lastPTS: UInt64 = 0
    private var nextPullToken: UInt = 0
    private var nextSubmissionToken: UInt = 0
    private var pending: PullRequest?
    private var idleDeadline: DispatchTime?
    private var encoding: Submission?
    private var encoder: VTCompressionSession?
    private lazy var renderContext = CIContext()

    init(windowID: CGWindowID, codec: StreamCodec) {
        self.windowID = windowID
        self.codec = codec
    }

    func begin() {
        Thread { self.readInput() }.start()
    }

    // MARK: Input and lifecycle

    private func readInput() {
        var line: [UInt8] = []
        var buffer = [UInt8](repeating: 0, count: 4096)
        var launched = false
        while true {
            // Consume already available cancellation before launching capture
            // (including an immediate STOP or EOF on an ungranted helper).
            if !launched {
                var fd = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
                let ready = poll(&fd, 1, 0)
                if ready < 0, errno == EINTR { continue }
                if ready == 0 {
                    launched = true
                    monitorQueue.async { self.startMonitor() }
                }
            }

            let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count == 0 { pipe.finish(0) }
            if count < 0 {
                if errno == EINTR { continue }
                pipe.finish(2, "stdin")
            }
            for byte in buffer.prefix(count) {
                if byte == 10 {
                    handleCommand(line)
                    line.removeAll(keepingCapacity: true)
                } else {
                    guard line.count < 8 else { pipe.finish(2, "command too long") }
                    line.append(byte)
                }
            }
        }
    }

    private func handleCommand(_ line: [UInt8]) {
        if line == Array("STOP".utf8) { pipe.finish(0) }
        guard line.count == 8, line.prefix(5).elementsEqual("PULL ".utf8),
              (48...51).contains(line[5]), line[6] == 32, (48...49).contains(line[7])
        else { pipe.finish(2, "bad command") }
        pipe.claimPull()
        stateQueue.async { self.pull(tier: Int(line[5] - 48), reset: line[7] == 49) }
    }

    private func startMonitor() {
        let timer = DispatchSource.makeTimerSource(queue: monitorQueue)
        timer.schedule(deadline: .now(), repeating: .seconds(1), leeway: .nanoseconds(0))
        timer.setEventHandler { [weak self] in
            guard let self, !self.classifyingFailure, !self.lookupInFlight else { return }
            self.inspectWindow(failure: nil)
        }
        monitor = timer
        timer.resume()
    }

    /// A lookup has its own deadline on the monotonic monitor queue. A
    /// capture failure supersedes a regular lookup and gets a fresh check.
    private func inspectWindow(failure: String?) {
        guard CGPreflightScreenCaptureAccess() else { pipe.finish(3, "screen-recording") }
        lookup += 1
        lookupInFlight = true
        let ticket = lookup
        monitorQueue.asyncAfter(deadline: .now() + .milliseconds(950)) {
            guard self.lookup == ticket else { return }
            self.finishCaptureFailure(failure ?? "window lookup timed out")
        }
        // Submit outside monitorQueue so the deadline also covers submission.
        Task {
            let result: WindowLookup
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                if let window = content.windows.first(where: { $0.windowID == self.windowID }) {
                    result = .found(window)
                } else {
                    result = .missing
                }
            } catch {
                result = .failed
            }
            monitorQueue.async { self.applyLookup(result, ticket: ticket, failure: failure) }
        }
    }

    private func applyLookup(_ result: WindowLookup, ticket: UInt64, failure: String?) {
        guard lookup == ticket else { return }
        lookup += 1
        lookupInFlight = false
        guard CGPreflightScreenCaptureAccess() else { pipe.finish(3, "screen-recording") }
        switch result {
        case .failed:
            finishCaptureFailure(failure ?? "window lookup failed")
        case .missing:
            pipe.finish(5, "window-gone")
        case .found(let window):
            guard let app = window.owningApplication,
                  originalPID.map({ $0 == app.processID }) ?? (eligibleApplication(for: window) != nil)
            else { pipe.finish(5, "window-gone") }
            if let failure { finishCaptureFailure(failure) }
            originalPID = app.processID
            stateQueue.async { self.applyWindow(window) }
        }
    }

    private func finishCaptureFailure(_ message: String) -> Never {
        if !CGPreflightScreenCaptureAccess() { pipe.finish(3, "screen-recording") }
        pipe.finish(4, "capture-failed: \(message)")
    }

    private func captureFailure(_ message: String) {
        guard !captureFailed else { return }
        captureFailed = true
        monitorQueue.async {
            self.classifyingFailure = true
            self.inspectWindow(failure: message)
        }
    }

    // MARK: Capture configuration

    private func applyWindow(_ next: SCWindow) {
        guard !captureFailed else { return }
        let wasOffScreen = window?.isOnScreen == false
        window = next
        geometry = CaptureGeometry(window: next)
        if !next.isOnScreen {
            suspendFrames()
        } else if wasOffScreen {
            // A restore frame can have arrived before the visibility lookup.
            // Restart capture to obtain a fresh complete frame even if static.
            appliedGeometry = nil
        }
        configureCapture()
    }

    private func configureCapture() {
        guard !captureFailed, !transitioning, let window, let geometry,
              stream == nil || geometry != appliedGeometry || tier != appliedTier else { return }
        guard let dims = codedDimensions(native: geometry.native, tier: tier) else {
            captureFailure("invalid window geometry")
            return
        }
        transitioning = true
        transitionID += 1
        let transition = transitionID
        stateQueue.asyncAfter(deadline: .now() + .seconds(5)) {
            if self.transitioning, self.transitionID == transition {
                self.captureFailure("capture configuration timed out")
            }
        }
        idleDeadline = nil
        suspendFrames()
        let previous = stream
        stream = nil
        if let previous {
            // Use a new stream for each configuration. Its identity fences
            // pending callbacks, including same-size changes and late stops.
            previous.stopCapture { error in
                self.stateQueue.async {
                    // Keep the retired stream alive until stop completes.
                    defer { withExtendedLifetime(previous) {} }
                    if let error {
                        self.captureFailure(error.localizedDescription)
                    } else {
                        self.transitioning = false
                        self.configureCapture()
                    }
                }
            }
        } else {
            startCapture(window: window, geometry: geometry, dims: dims)
        }
    }

    private func startCapture(window: SCWindow, geometry: CaptureGeometry, dims: Dimensions) {
        let config = SCStreamConfiguration()
        config.width = dims.width
        config.height = dims.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(tierSpec(tier).fps))
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.capturesAudio = false
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.colorSpaceName = CGColorSpace.sRGB

        let created = SCStream(filter: SCContentFilter(desktopIndependentWindow: window),
                               configuration: config, delegate: self)
        do {
            try created.addStreamOutput(self, type: .screen, sampleHandlerQueue: stateQueue)
        } catch {
            captureFailure(error.localizedDescription)
            return
        }
        stream = created
        appliedGeometry = geometry
        appliedTier = tier
        dimensions = dims
        created.startCapture { error in
            self.stateQueue.async {
                if let error {
                    self.captureFailure(error.localizedDescription)
                    return
                }
                guard !self.captureFailed else { return }
                self.transitioning = false
                self.configureCapture()
                self.attemptEncode()
                self.armIdle()
            }
        }
    }

    private func suspendFrames() {
        rawFrame = nil
        resumeNeedsSync = true
        rebuildForResume = false
        // Keep any outstanding PULL across a resize or suspension.
        encoding = nil
        invalidateEncoder()
        armIdle()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, stream === self.stream, !captureFailed,
              let attachments = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                                  as? [[SCStreamFrameInfo: Any]])?.first,
              let value = attachments[.status] as? Int, let status = SCFrameStatus(rawValue: value) else { return }
        switch status {
        case .complete:
            guard window?.isOnScreen == true, let geometry = appliedGeometry, let dims = dimensions else { return }
            rawSerial += 1
            guard let frame = RawFrame(sample: sample, attachments: attachments, geometry: geometry,
                                       dims: dims, serial: rawSerial) else {
                suspendFrames()
                return
            }
            if resumeNeedsSync {
                // A prior submission may still finish when SCK goes idle.
                // Let its response complete, then rebuild for this fresh frame.
                rebuildForResume = true
                resumeNeedsSync = false
            }
            rawFrame = frame
            attemptEncode()
        case .idle:
            resumeNeedsSync = true
        case .blank, .suspended:
            suspendFrames()
        case .stopped:
            captureFailure("capture stopped")
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stateQueue.async {
            guard stream === self.stream else { return }
            self.captureFailure(error.localizedDescription)
        }
    }

    // MARK: Pull and encoder

    private func pull(tier: Int, reset: Bool) {
        guard !captureFailed else { return }
        nextPullToken += 1
        pending = PullRequest(token: nextPullToken, reset: reset)
        self.tier = tier
        configureCapture()
        attemptEncode()
        armIdle()
    }

    private func armIdle() {
        guard !transitioning, !captureFailed, idleDeadline == nil, let request = pending,
              encoding == nil else { return }
        let deadline = DispatchTime.now() + .milliseconds(500)
        idleDeadline = deadline
        stateQueue.asyncAfter(deadline: deadline) {
            guard !self.captureFailed, self.pending?.token == request.token,
                  self.idleDeadline == deadline else { return }
            self.answer(tag: 0)
        }
    }

    private func answer(tag: UInt8, body: Data? = nil) {
        pending = nil
        idleDeadline = nil
        pipe.send(tag: tag, body: body)
    }

    private func attemptEncode() {
        guard !transitioning, !captureFailed, window?.isOnScreen == true, encoding == nil,
              let request = pending, let raw = rawFrame, let dims = dimensions,
              request.reset || raw.serial > lastSubmittedSerial else { return }
        // While idle the phone holds its current image. Allow cached recovery
        // on explicit reset and allow the initial or already-latched sync.
        if resumeNeedsSync && encoder != nil && !rebuildForResume && !request.reset { return }

        if request.reset || rebuildForResume { invalidateEncoder() }
        let wantsSync = encoder == nil
        if wantsSync { buildEncoder(dims: dims) }
        guard let encoder,
              let image = raw.scaled(to: dims, pool: VTCompressionSessionGetPixelBufferPool(encoder),
                                     context: renderContext) else { pipe.finish(4, "pixel conversion failed") }

        let pts = max(monotonicMicros(), lastPTS + 1)
        lastPTS = pts
        lastSubmittedSerial = raw.serial
        rebuildForResume = false
        idleDeadline = nil
        nextSubmissionToken += 1
        let token = nextSubmissionToken
        encoding = Submission(token: token, pts: pts, wantsSync: wantsSync)
        let duration = CMTime(value: 1, timescale: CMTimeScale(tierSpec(tier).fps))
        let properties = wantsSync ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary : nil
        var flags = VTEncodeInfoFlags()
        let status = VTCompressionSessionEncodeFrame(
            encoder, imageBuffer: image, presentationTimeStamp: CMTime(value: Int64(pts), timescale: 1_000_000),
            duration: duration, frameProperties: properties, sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: token),
            infoFlagsOut: &flags)
        requireEncoderSuccess(status, operation: "submit encode")
        if flags.contains(.frameDropped) { encoderDroppedFrame() }
    }

    private func invalidateEncoder() {
        guard let session = encoder else { return }
        encoder = nil
        VTCompressionSessionInvalidate(session)
    }

    private func encoderDroppedFrame() {
        encoding = nil
        invalidateEncoder()
        answer(tag: 0)
    }

    func receiveEncoded(token: UInt, status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
        stateQueue.async {
            guard !self.captureFailed, let submission = self.encoding, submission.token == token,
                  let dims = self.dimensions else { return }
            self.encoding = nil
            self.requireEncoderSuccess(status, operation: "encode callback")
            if flags.contains(.frameDropped) {
                self.encoderDroppedFrame()
                return
            }
            guard let sample else { self.pipe.finish(4, "encoder returned no sample") }
            do {
                let body = try makeFrameBody(sample, codec: self.codec, dims: dims, submission: submission)
                self.answer(tag: 1, body: body)
            } catch WireFrameError.oversize {
                self.invalidateEncoder()
                self.answer(tag: 2)
            } catch {
                self.pipe.finish(4, "invalid encoded access unit")
            }
        }
    }

    private func requireEncoderSuccess(_ status: OSStatus, operation: String) {
        switch status {
        case noErr: return
        case kVTCouldNotFindVideoEncoderErr, kVTVideoEncoderNotAvailableNowErr, kVTVideoEncoderAuthorizationErr:
            pipe.finish(6, "codec-unavailable: \(operation) (\(status))")
        default:
            pipe.finish(4, "\(operation) failed (\(status))")
        }
    }

    private func buildEncoder(dims: Dimensions) {
        let spec = tierSpec(tier)
        let specification = [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true]
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ]
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(dims.width), height: Int32(dims.height), codecType: codec.cmCodecType,
            encoderSpecification: specification as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
            compressedDataAllocator: nil, outputCallback: vtOutputStreamCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &session)
        requireEncoderSuccess(status, operation: "create encoder")
        guard let session else { pipe.finish(4, "encoder returned no session") }

        let profile = VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: codec.profileLevel)
        if [kVTPropertyNotSupportedErr, kVTPropertyReadOnlyErr, kVTParameterErr, OSStatus(paramErr)].contains(profile) {
            pipe.finish(6, "codec-unavailable: profile (\(profile))")
        }
        requireEncoderSuccess(profile, operation: "set profile")
        let required: [(CFString, NSNumber)] = [
            (kVTCompressionPropertyKey_RealTime, NSNumber(value: true)),
            (kVTCompressionPropertyKey_AllowFrameReordering, NSNumber(value: false)),
            (kVTCompressionPropertyKey_AllowTemporalCompression, NSNumber(value: true)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: spec.fps)),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: spec.bitrate)),
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: spec.fps * 2)),
            (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: 2)),
        ]
        for (key, value) in required {
            requireEncoderSuccess(VTSessionSetProperty(session, key: key, value: value), operation: "set \(key)")
        }
        let optional: [(CFString, CFTypeRef)] = [
            (kVTCompressionPropertyKey_AllowOpenGOP, kCFBooleanFalse),
            (kVTCompressionPropertyKey_DataRateLimits, [NSNumber(value: spec.bitrate / 8), NSNumber(value: 1.0)] as CFArray),
        ]
        for (key, value) in optional {
            let status = VTSessionSetProperty(session, key: key, value: value)
            if status != kVTPropertyNotSupportedErr { requireEncoderSuccess(status, operation: "set \(key)") }
        }
        requireEncoderSuccess(VTCompressionSessionPrepareToEncodeFrames(session), operation: "prepare encoder")
        encoder = session
    }
}

// MARK: - MWV1 sample conversion

private enum WireFrameError: Error {
    case invalid
    case oversize
}

private let wireBodyLimit = 24_576

private extension StreamCodec {
    var parameterTypes: [UInt8] { self == .h264 ? [7, 8] : [32, 33, 34] }
    var nalHeaderSize: Int { self == .h264 ? 1 : 2 }

    func nalType(_ bytes: UnsafePointer<UInt8>, length: Int) throws -> UInt8 {
        guard length >= nalHeaderSize, bytes[0] & 0x80 == 0 else { throw WireFrameError.invalid }
        if self == .h264 { return bytes[0] & 0x1f }
        // A single HEVC Main layer and a nonzero temporal_id_plus1.
        guard bytes[0] & 1 == 0, bytes[1] >> 3 == 0, bytes[1] & 7 != 0 else { throw WireFrameError.invalid }
        return (bytes[0] >> 1) & 0x3f
    }

    func sliceType(_ type: UInt8) throws -> Bool? {
        // true = independently decodable IDR, false = other VCL, nil = non-VCL.
        if self == .h264 {
            switch type {
            case 5: return true
            case 1: return false
            case 6, 9...12: return nil
            default: throw WireFrameError.invalid
            }
        }
        switch type {
        case 19, 20: return true
        case 0...9, 16...18, 21: return false
        case 35...40: return nil
        default: throw WireFrameError.invalid
        }
    }
}

private func parameterSet(_ format: CMFormatDescription, codec: StreamCodec, index: Int,
                          count: UnsafeMutablePointer<Int>? = nil,
                          lengthWidth: UnsafeMutablePointer<Int32>? = nil) throws -> UnsafeBufferPointer<UInt8> {
    var bytes: UnsafePointer<UInt8>?
    var size = 0
    let status: OSStatus
    switch codec {
    case .h264:
        status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: index, parameterSetPointerOut: &bytes, parameterSetSizeOut: &size,
            parameterSetCountOut: count, nalUnitHeaderLengthOut: lengthWidth)
    case .hevc:
        status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
            format, parameterSetIndex: index, parameterSetPointerOut: &bytes, parameterSetSizeOut: &size,
            parameterSetCountOut: count, nalUnitHeaderLengthOut: lengthWidth)
    }
    guard status == noErr, let bytes, size > 0 else { throw WireFrameError.invalid }
    return UnsafeBufferPointer(start: bytes, count: size)
}

private func sampleIsSync(_ sample: CMSampleBuffer) throws -> Bool {
    // CoreMedia defines an absent NotSync key (including no attachments)
    // as false. A malformed attachment is an invalid sample.
    guard let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) else { return true }
    guard let attachments = array as? [[String: Any]], attachments.count == 1,
          let first = attachments.first else { throw WireFrameError.invalid }
    guard let value = first[kCMSampleAttachmentKey_NotSync as String] else { return true }
    guard let flag = value as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID()
    else { throw WireFrameError.invalid }
    return !flag.boolValue
}

private func makeFrameBody(_ sample: CMSampleBuffer, codec: StreamCodec, dims: Dimensions,
                           submission: Submission) throws -> Data {
    guard CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
          CMSampleBufferGetNumSamples(sample) == 1,
          let format = CMSampleBufferGetFormatDescription(sample),
          CMFormatDescriptionGetMediaType(format) == kCMMediaType_Video,
          CMFormatDescriptionGetMediaSubType(format) == codec.cmCodecType,
          let block = CMSampleBufferGetDataBuffer(sample) else { throw WireFrameError.invalid }
    let size = CMVideoFormatDescriptionGetDimensions(format)
    guard size.width == dims.width, size.height == dims.height else { throw WireFrameError.invalid }
    let sync = try sampleIsSync(sample)
    guard sync || !submission.wantsSync else { throw WireFrameError.invalid }

    var setCount = 0
    var nativeLengthWidth: Int32 = 0
    let first = try parameterSet(format, codec: codec, index: 0, count: &setCount, lengthWidth: &nativeLengthWidth)
    let types = codec.parameterTypes
    guard setCount == types.count, [1, 2, 4].contains(nativeLengthWidth) else { throw WireFrameError.invalid }
    var sets: [UInt8: UnsafeBufferPointer<UInt8>] = [:]
    for index in 0..<setCount {
        let set = index == 0 ? first : try parameterSet(format, codec: codec, index: index)
        let type = try codec.nalType(set.baseAddress!, length: set.count)
        guard types.contains(type), sets[type] == nil else { throw WireFrameError.invalid }
        sets[type] = set
    }

    var body = Data("MWV1".utf8)
    body.append(sync ? 1 : 0)
    body.append(sync ? UInt8(setCount) : 0)
    appendBE16(&body, UInt16(dims.width))
    appendBE16(&body, UInt16(dims.height))
    appendBE16(&body, 0)
    appendBE32(&body, 0)
    appendBE64(&body, submission.pts)
    if sync {
        for type in types {
            let set = sets[type]!
            guard set.count <= wireBodyLimit - body.count - 2 else { throw WireFrameError.oversize }
            appendBE16(&body, UInt16(set.count))
            body.append(contentsOf: set)
        }
    }

    // The parameter buffers above belong to the format description. Keep it
    // alive through the final use of those buffers.
    withExtendedLifetime(format) {}
    try appendAccessUnit(block, lengthWidth: Int(nativeLengthWidth), codec: codec, sync: sync, to: &body)
    return body
}

private func appendAccessUnit(_ block: CMBlockBuffer, lengthWidth: Int, codec: StreamCodec,
                              sync: Bool, to body: inout Data) throws {
    let size = CMBlockBufferGetDataLength(block)
    var offset = 0
    var hasSlice = false
    var header = [UInt8](repeating: 0, count: lengthWidth + codec.nalHeaderSize)
    while offset < size {
        guard size - offset >= header.count,
              CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: header.count,
                                         destination: &header) == noErr else { throw WireFrameError.invalid }
        let length = header.prefix(lengthWidth).reduce(0) { ($0 << 8) | Int($1) }
        offset += lengthWidth
        guard length >= codec.nalHeaderSize, length <= size - offset else { throw WireFrameError.invalid }
        let type = try header.withUnsafeBufferPointer {
            try codec.nalType($0.baseAddress!.advanced(by: lengthWidth), length: length)
        }
        if let idr = try codec.sliceType(type) {
            // An IDR has no leading pictures or cross-GOP references, even
            // when this encoder does not implement AllowOpenGOP.
            guard !sync || idr else { throw WireFrameError.invalid }
            hasSlice = true
        }
        guard length <= wireBodyLimit - body.count - 4 else { throw WireFrameError.oversize }
        appendBE32(&body, UInt32(length))
        let start = body.count
        body.count += length
        let status = body.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: offset, dataLength: length,
                                       destination: $0.baseAddress!.advanced(by: start))
        }
        guard status == noErr else { throw WireFrameError.invalid }
        offset += length
    }
    guard hasSlice else { throw WireFrameError.invalid }
}

private var activeStreamer: WindowStreamer?

private func startStream(id: CGWindowID, codec: StreamCodec) {
    _ = signal(SIGPIPE, SIG_IGN)
    let streamer = WindowStreamer(windowID: id, codec: codec)
    activeStreamer = streamer
    streamer.begin()
}

func run(_ args: [String]) async {
    let usage = "usage: wincap check | prompt | list | snapshot <id> <max-side 160-2400> <quality 0.1-1> | stream <id> <h264|hevc>"
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
        case "stream":
            guard args.count == 4, args[2].utf8.allSatisfy({ (48...57).contains($0) }),
                  let rawId = UInt32(args[2]), rawId >= 1,
                  let chosen = StreamCodec(rawValue: args[3]) else { fail(2, usage) }
            startStream(id: rawId, codec: chosen)
            return
        default: fail(2, "unknown command \(args[1])")
        }
    } catch {
        fail(4, "\(error.localizedDescription)")
    }
    exit(0)
}

Task { await run(CommandLine.arguments) }
dispatchMain()
