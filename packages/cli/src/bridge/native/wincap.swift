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

func tierSpec(_ tier: Int) -> TierSpec { streamTiers[min(max(tier, 0), 3)] }

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
    guard nativeWidth >= 2, nativeHeight >= 2 else { return nil }
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

/// The most recent complete SCK frame. One slot only: a newer complete frame
/// replaces it (dropping is cheaper than queueing), and it doubles as the
/// cached image a forced-sync PULL may re-encode.
struct RawFrame {
    let image: CVImageBuffer
    let pts: UInt64
    let generation: UInt64
}

struct PullRequest {
    let tier: Int
    let reset: Bool
    let token: UInt64
}

/// VideoToolbox's output callback must be a non-capturing C function. The
/// refcon is the WindowStreamer that created the session.
let vtOutputStreamCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
    guard let refcon else { return }
    let streamer = Unmanaged<WindowStreamer>.fromOpaque(refcon).takeUnretainedValue()
    streamer.receiveEncoded(status: status, sampleBuffer: sampleBuffer)
}

/// Live capture of one window, driven by `wincap stream <id> <h264|hevc>`.
///
/// Record format on stdout: `u32 BE payload length`, then one tag byte and
/// its body. Length counts the tag byte too.
///   tag 0  idle, or VT dropped the input (no body).
///   tag 1  one encoded access unit (body = MWV1 binary WS layout, seq 0).
///   tag 2  the encoded unit exceeded the phone's 24576-byte wire cap; the
///          encoder is invalidated before this is written (no body).
/// The body of tag 1 is the 24-byte MWV1 header (flags bit 0 sync, parameter
/// set count, u16 width/height, reserved, u32 seq = 0, u64 monotonic PTS in
/// microseconds), then `u16 length + raw NAL` parameter sets on sync frames
/// only, then `u32 length + raw NAL` access-unit entries.
///
/// Pacing contract with the Hook: stdin carries one `PULL <tier> <reset>` at a
/// time (tier 0…3, reset 0|1) and exactly one record answers each PULL; `STOP`
/// or EOF ends the process with 0 and needs no answer. A PULL waits at most
/// 500 ms for a usable image (longer while an SCK configuration update is in
/// flight) and then answers idle; idle is valid indefinitely, so static or
/// minimized windows simply cost tag-0 records. The Hook owns seq numbering,
/// epochs, the token bucket and frame rate; this process only refuses to
/// overrun the 24576-byte unit cap (tag 2) and paces SCK via the tier's frame
/// interval. Resize, tier change and reset all force a sync frame.
final class WindowStreamer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let windowID: CGWindowID
    let codec: StreamCodec
    let stateQueue = DispatchQueue(label: "phren.wincap.stream")

    private var captureStream: SCStream?
    /// Set once at startup and never changed: a window that hands its id to a
    /// different owner is gone for our purposes (exit 5).
    private var originalPID: pid_t = 0
    private var tier = 1
    private var nativeSize: CGSize?
    private var declared: Dimensions?
    private var encoder: VTCompressionSession?
    private var rawFrame: RawFrame?
    private var pending: PullRequest?
    private var encoding: PullRequest?
    private var encodingGeneration: UInt64 = 0
    private var encodingWantsSync = false
    private var encodingPts: UInt64 = 0
    private var geometryGeneration: UInt64 = 0
    private var tokenCounter: UInt64 = 0
    private var forceSync = true
    private var needsReset = true
    private var sentFirstFrame = false
    private var lastGeneratedPts: UInt64 = 0
    private var lastSentPts: UInt64 = 0
    private var lastCompleteAt: UInt64 = 0
    private var offScreen = false
    private var resumeNeedsSync = true
    private var configuring = false
    private var configInFlight = false
    private var deferredConfiguration: (Dimensions, Int)?
    private var started = false
    private var stopped = false
    private var recheckTask: Task<Void, Never>?

    init(windowID: CGWindowID, codec: StreamCodec) {
        self.windowID = windowID
        self.codec = codec
        super.init()
    }

    // MARK: lifecycle

    func begin() {
        startInput()
        Task { await self.startCapture() }
    }

    private func startCapture() async {
        guard CGPreflightScreenCaptureAccess() else { fail(3, "screen-recording") }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == self.windowID }),
                  window.frame.width >= 1, window.frame.height >= 1,
                  let app = window.owningApplication else { fail(5, "no window") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let native = nativePixels(filter: filter, window: window)
            let stream: SCStream = try stateQueue.sync {
                try self.install(filter: filter, native: native, pid: app.processID)
            }
            try await stream.startCapture()
            stateQueue.async {
                guard !self.stopped else { return }
                self.started = true
                self.attemptEncode()
                self.startRecheck()
            }
        } catch {
            if !CGPreflightScreenCaptureAccess() { fail(3, "screen-recording") }
            fail(4, "capture-failed: \(error.localizedDescription)")
        }
    }

    private func nativePixels(filter: SCContentFilter, window: SCWindow) -> CGSize {
        let rect = filter.contentRect.width >= 2 && filter.contentRect.height >= 2 ? filter.contentRect : window.frame
        let scale = filter.pointPixelScale > 0 ? CGFloat(filter.pointPixelScale) : displayScale(for: window.frame)
        return CGSize(width: rect.width * scale, height: rect.height * scale)
    }

    private func install(filter: SCContentFilter, native: CGSize, pid: pid_t) throws -> SCStream {
        originalPID = pid
        nativeSize = native
        guard let dims = codedDimensions(native: native, tier: tier) else { fail(5, "no window") }
        declared = dims
        buildEncoder(dims: dims, tier: tier)
        let config = makeConfiguration(dims: dims, tier: tier)
        let created = SCStream(filter: filter, configuration: config, delegate: self)
        try created.addStreamOutput(self, type: .screen, sampleHandlerQueue: stateQueue)
        captureStream = created
        return created
    }

    private func stopProcess() -> Never {
        if stopped { exit(0) }
        stopped = true
        pending = nil
        encoding = nil
        recheckTask?.cancel()
        teardownEncoder()
        if let captureStream { captureStream.stopCapture(completionHandler: { _ in }) }
        exit(0)
    }

    // MARK: stdin

    private func startInput() {
        let thread = Thread { [weak self] in self?.readInput() }
        thread.name = "wincap-stream-stdin"
        thread.start()
    }

    private func readInput() {
        var pendingBytes = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                fail(2, "stdin")
            }
            if count == 0 {
                stateQueue.async { self.stopProcess() }
                return
            }
            pendingBytes.append(contentsOf: buffer[0..<count])
            while let newline = pendingBytes.firstIndex(of: 0x0a) {
                let lineBytes = pendingBytes[pendingBytes.startIndex..<newline]
                pendingBytes.removeSubrange(pendingBytes.startIndex...newline)
                var line = String(decoding: lineBytes, as: UTF8.self)
                if line.hasSuffix("\r") { line.removeLast() }
                handle(line)
            }
            if pendingBytes.count > 64 { fail(2, "command too long") }
        }
    }

    private func handle(_ line: String) {
        if line == "STOP" {
            stateQueue.async { self.stopProcess() }
            return
        }
        let parts = line.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "PULL",
              let nextTier = Int(parts[1]), (0...3).contains(nextTier),
              parts[2] == "0" || parts[2] == "1" else { fail(2, "bad command") }
        let reset = parts[2] == "1"
        stateQueue.async { self.pull(tier: nextTier, reset: reset) }
    }

    // MARK: configuration

    private func makeConfiguration(dims: Dimensions, tier: Int) -> SCStreamConfiguration {
        let spec = tierSpec(tier)
        let config = SCStreamConfiguration()
        config.width = dims.width
        config.height = dims.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(spec.fps))
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.capturesAudio = false
        config.scalesToFit = true
        config.colorSpaceName = CGColorSpace.sRGB
        return config
    }

    /// Recompute coded size after a tier or window-geometry change. Cached
    /// pre-change content is discarded, the encoder is rebuilt and the next
    /// encode is forced to a keyframe, so no delta ever crosses a resize.
    private func retune(native: CGSize, nextTier: Int, configChanged: Bool) {
        // An in-flight encode belongs to the old configuration: abandon it and
        // answer its PULL rather than let it write a stale sample.
        if encoding != nil {
            encoding = nil
            respond(tag: 0, body: nil)
        }
        let tierChanged = nextTier != tier
        tier = nextTier
        nativeSize = native
        guard let dims = codedDimensions(native: native, tier: nextTier) else { return }
        let dimsChanged = declared != dims
        declared = dims
        geometryGeneration &+= 1
        rawFrame = nil
        buildEncoder(dims: dims, tier: nextTier)
        forceSync = true
        needsReset = true
        if configChanged || dimsChanged || tierChanged {
            pushConfiguration(dims: dims, tier: nextTier)
        }
    }

    private func retuneForTier(_ nextTier: Int) {
        guard nextTier != tier else { return }
        guard let native = nativeSize else {
            tier = nextTier
            return
        }
        retune(native: native, nextTier: nextTier, configChanged: true)
    }

    /// SCK allows one configuration update at a time, so later requests wait
    /// for the one in flight; only the newest queued update is kept. While any
    /// update is outstanding `configuring` stays set, which keeps a PULL
    /// outstanding instead of answering it idle.
    private func pushConfiguration(dims: Dimensions, tier: Int) {
        guard captureStream != nil else { return }
        if configInFlight {
            deferredConfiguration = (dims, tier)
            return
        }
        configuring = true
        configInFlight = true
        let config = makeConfiguration(dims: dims, tier: tier)
        captureStream?.updateConfiguration(config) { [weak self] error in
            guard let self else { return }
            self.stateQueue.async {
                self.configInFlight = false
                if let error { fail(4, "capture-failed: \(error.localizedDescription)") }
                if let deferred = self.deferredConfiguration {
                    self.deferredConfiguration = nil
                    self.pushConfiguration(dims: deferred.0, tier: deferred.1)
                } else {
                    self.configuring = false
                }
                self.attemptEncode()
            }
        }
    }

    // MARK: encoder

    private func buildEncoder(dims: Dimensions, tier: Int) {
        teardownEncoder()
        let spec = tierSpec(tier)
        let specification: [String: Any] = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
        ]
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ]
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: kCFAllocatorDefault,
                                                width: Int32(dims.width),
                                                height: Int32(dims.height),
                                                codecType: codec.cmCodecType,
                                                encoderSpecification: specification as CFDictionary,
                                                imageBufferAttributes: attributes as CFDictionary,
                                                compressedDataAllocator: nil,
                                                outputCallback: vtOutputStreamCallback,
                                                refcon: Unmanaged.passUnretained(self).toOpaque(),
                                                compressionSessionOut: &session)
        guard status == noErr, let created = session else { fail(6, "codec-unavailable") }

        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: NSNumber(value: true))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: NSNumber(value: false))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowOpenGOP, value: NSNumber(value: false))
        if VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: codec.profileLevel) != noErr {
            VTCompressionSessionInvalidate(created)
            fail(6, "codec-unavailable")
        }
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowTemporalCompression, value: NSNumber(value: true))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: spec.fps))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: spec.bitrate))
        let limits = [NSNumber(value: spec.bitrate / 8), NSNumber(value: 1.0)] as NSArray
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_DataRateLimits, value: limits as CFArray)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: spec.fps * 2))
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 2))
        VTCompressionSessionPrepareToEncodeFrames(created)

        encoder = created
        sentFirstFrame = false
    }

    private func teardownEncoder() {
        guard let session = encoder else { return }
        encoder = nil
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
    }

    // MARK: PULL handling

    private func pull(tier nextTier: Int, reset: Bool) {
        guard !stopped else { return }
        // The Hook never pipelines: one PULL at a time, answered before the next.
        if pending != nil || encoding != nil { fail(2, "pipelined pull") }
        if nextTier != tier { retuneForTier(nextTier) }
        if reset {
            forceSync = true
            needsReset = true
            // Reset also means a fresh session: rate control and GOP state
            // start clean, and the first unit is an independent keyframe.
            if let dims = declared { buildEncoder(dims: dims, tier: tier) }
        }
        let request = PullRequest(tier: tier, reset: reset, token: nextToken())
        pending = request
        attemptEncode()
        guard let outstanding = pending, outstanding.token == request.token else { return }
        scheduleIdle(for: request.token)
    }

    private func nextToken() -> UInt64 {
        tokenCounter &+= 1
        return tokenCounter
    }

    /// The 500 ms idle answer. A PULL stays outstanding through an SCK
    /// configuration update, so the timer simply re-arms while one runs.
    private func scheduleIdle(for token: UInt64) {
        stateQueue.asyncAfter(deadline: .now() + .milliseconds(500)) {
            guard let request = self.pending, request.token == token, self.encoding == nil else { return }
            if self.configuring {
                self.scheduleIdle(for: token)
                return
            }
            self.pending = nil
            self.respond(tag: 0, body: nil)
        }
    }

    private func usableFrame(for request: PullRequest) -> RawFrame? {
        guard let frame = rawFrame, frame.generation == geometryGeneration else { return nil }
        if request.reset { return frame }
        return frame.pts > lastSentPts ? frame : nil
    }

    private func attemptEncode() {
        guard !stopped, encoding == nil,
              let request = pending,
              let session = encoder,
              declared != nil,
              let frame = usableFrame(for: request) else { return }
        pending = nil
        encoding = request
        encodingGeneration = geometryGeneration
        let wantsSync = forceSync || request.reset || needsReset || !sentFirstFrame
        encodingWantsSync = wantsSync
        var pts = monotonicMicros()
        if pts <= lastGeneratedPts { pts = lastGeneratedPts + 1 }
        lastGeneratedPts = pts
        encodingPts = pts
        let duration = CMTime(value: 1, timescale: CMTimeScale(tierSpec(tier).fps))
        let properties: CFDictionary? = wantsSync
            ? (NSDictionary(object: NSNumber(value: true),
                            forKey: kVTEncodeFrameOptionKey_ForceKeyFrame as NSString) as CFDictionary)
            : nil
        var flags = VTEncodeInfoFlags()
        let status = VTCompressionSessionEncodeFrame(session,
                                                     imageBuffer: frame.image,
                                                     presentationTimeStamp: CMTime(value: CMTimeValue(pts), timescale: 1_000_000),
                                                     duration: duration,
                                                     frameProperties: properties,
                                                     sourceFrameRefcon: nil,
                                                     infoFlagsOut: &flags)
        if status != noErr || flags.contains(.frameDropped) {
            // Tag 0 after an encoder-reported drop still needs the next actual
            // encode to start a fresh GOP, even if the Hook sends reset=0.
            encoding = nil
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
        }
    }

    func receiveEncoded(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
        stateQueue.async { self.processEncoded(status: status, sampleBuffer: sampleBuffer) }
    }

    private func processEncoded(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
        guard encoding != nil else { return }
        encoding = nil
        let generation = encodingGeneration
        let wantsSync = encodingWantsSync
        let pts = encodingPts

        guard status == noErr, let sample = sampleBuffer else {
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }
        guard generation == geometryGeneration, let dims = declared else {
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }

        // A keyframe is confirmed from the sample's own metadata, not merely
        // from having asked for one.
        var isSync = false
        var sawAttachments = false
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]] {
            sawAttachments = true
            let notSync = (attachments.first?[kCMSampleAttachmentKey_NotSync as String] as? NSNumber)?.boolValue ?? false
            isSync = !notSync
        }
        if !sawAttachments { isSync = wantsSync }
        guard !wantsSync || isSync else {
            // The phone expects a sync frame; never let an unexpected delta
            // stand in for it.
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }

        guard let format = CMSampleBufferGetFormatDescription(sample),
              let block = CMSampleBufferGetDataBuffer(sample) else {
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }
        let (parameterSets, nalLengthSize) = parameterSetData(format: format, codec: codec)
        if isSync && parameterSets.isEmpty {
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }
        let rawLength = CMBlockBufferGetDataLength(block)
        guard rawLength > 0 else {
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }
        let memory = UnsafeMutablePointer<UInt8>.allocate(capacity: rawLength)
        guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: rawLength, destination: memory) == noErr else {
            memory.deallocate()
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }
        let raw = Data(bytesNoCopy: memory, count: rawLength, deallocator: .free)
        guard let accessUnit = normalizeNALUnits(raw, nalLengthSize: nalLengthSize) else {
            forceSync = true
            needsReset = true
            respond(tag: 0, body: nil)
            return
        }

        let wireSets = isSync ? parameterSets : []
        let bodySize = 24 + wireSets.reduce(0) { $0 + 2 + $1.count } + accessUnit.count
        if bodySize > 24576 {
            teardownEncoder()
            sentFirstFrame = false
            forceSync = true
            needsReset = true
            respond(tag: 2, body: nil)
            return
        }

        let body = frameBody(dims: dims, pts: pts, sync: isSync, parameterSets: wireSets, accessUnit: accessUnit)
        respond(tag: 1, body: body)
        sentFirstFrame = true
        lastSentPts = pts
        forceSync = false
        needsReset = false
    }

    // MARK: sample conversion

    private func parameterSetData(format: CMFormatDescription, codec: StreamCodec) -> ([Data], Int) {
        var count = 0
        var headerLength: Int32 = 4
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        let status: OSStatus
        if codec == .h264 {
            status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: 0, parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size, parameterSetCountOut: &count,
                nalUnitHeaderLengthOut: &headerLength)
        } else {
            status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                format, parameterSetIndex: 0, parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size, parameterSetCountOut: &count,
                nalUnitHeaderLengthOut: &headerLength)
        }
        guard status == noErr, count > 0, count < 256 else { return ([], 4) }

        var sets: [Data] = []
        for index in 0..<count {
            var setPointer: UnsafePointer<UInt8>?
            var setSize = 0
            let result: OSStatus
            if codec == .h264 {
                result = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: index, parameterSetPointerOut: &setPointer,
                    parameterSetSizeOut: &setSize, parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil)
            } else {
                result = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                    format, parameterSetIndex: index, parameterSetPointerOut: &setPointer,
                    parameterSetSizeOut: &setSize, parameterSetCountOut: nil,
                    nalUnitHeaderLengthOut: nil)
            }
            guard result == noErr, let bytes = setPointer, setSize > 0, setSize <= 65535 else { return ([], 4) }
            sets.append(Data(bytes: bytes, count: setSize))
        }
        let header = Int(headerLength)
        return (sets, (1...4).contains(header) ? header : 4)
    }

    /// Rewrite AVCC/HVCC length prefixes as four-byte big-endian lengths and
    /// validate that the entries consume the buffer exactly. Parameter sets
    /// are already out of band in the MWV1 body.
    private func normalizeNALUnits(_ data: Data, nalLengthSize: Int) -> Data? {
        guard (1...4).contains(nalLengthSize) else { return nil }
        var output = Data(capacity: data.count)
        var index = data.startIndex
        let end = data.endIndex
        while index < end {
            guard index + nalLengthSize <= end else { return nil }
            var length = 0
            for offset in 0..<nalLengthSize {
                length = (length << 8) | Int(data[index + offset])
            }
            index += nalLengthSize
            guard length > 0, index + length <= end else { return nil }
            appendBE32(&output, UInt32(length))
            output.append(contentsOf: data[index..<(index + length)])
            index += length
        }
        return output.isEmpty ? nil : output
    }

    private func frameBody(dims: Dimensions, pts: UInt64, sync: Bool, parameterSets: [Data], accessUnit: Data) -> Data {
        var body = Data(capacity: 24 + accessUnit.count)
        body.append(contentsOf: Array("MWV1".utf8))
        body.append(sync ? 1 : 0)
        body.append(UInt8(parameterSets.count))
        appendBE16(&body, UInt16(dims.width))
        appendBE16(&body, UInt16(dims.height))
        appendBE16(&body, 0)
        appendBE32(&body, 0)
        appendBE64(&body, pts)
        for set in parameterSets {
            appendBE16(&body, UInt16(set.count))
            body.append(set)
        }
        body.append(accessUnit)
        return body
    }

    /// The only stdout writer. Called on `stateQueue` only, so records never
    /// interleave.
    private func respond(tag: UInt8, body: Data?) {
        var record = Data(capacity: 5 + (body?.count ?? 0))
        appendBE32(&record, UInt32(1 + (body?.count ?? 0)))
        record.append(tag)
        if let body { record.append(body) }
        do {
            try FileHandle.standardOutput.write(contentsOf: record)
        } catch {
            fail(4, "stdout-pipe")
        }
    }

    // MARK: SCK callbacks

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, !stopped else { return }
        var status = SCFrameStatus.complete
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? NSNumber,
           let parsed = SCFrameStatus(rawValue: raw.intValue) {
            status = parsed
        }
        switch status {
        case .complete:
            guard let dims = declared, let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            // A frame from an old configuration must never reach the encoder.
            guard CVPixelBufferGetWidth(image) == dims.width,
                  CVPixelBufferGetHeight(image) == dims.height else { return }
            let now = monotonicMicros()
            // Coming back from minimized/blank, or from a pause longer than a
            // couple of seconds, starts a fresh GOP so the phone can recover
            // even if it missed the last reference frame. Shorter idle gaps
            // stay deltas: the phone still holds the last image.
            if resumeNeedsSync || (lastCompleteAt != 0 && now &- lastCompleteAt > 2_000_000) {
                forceSync = true
                needsReset = true
                resumeNeedsSync = false
            }
            lastCompleteAt = now
            rawFrame = RawFrame(image: image, pts: now, generation: geometryGeneration)
            attemptEncode()
        case .blank:
            // The window is minimized or its content is unavailable. Keep the
            // last complete image so a forced sync can reuse it, and resume
            // with a sync frame on the first new complete image.
            resumeNeedsSync = true
        case .idle:
            break
        case .stopped:
            classifyCaptureEnd()
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        stateQueue.async { self.classifyCaptureEnd() }
    }

    /// Recheck window existence and permission before mapping a generic
    /// capture termination, so the Hook can close with 4404 or the Screen
    /// Recording refusal instead of capture-failed.
    private func classifyCaptureEnd() {
        guard !stopped else { return }
        stopped = true
        pending = nil
        encoding = nil
        recheckTask?.cancel()
        teardownEncoder()
        Task {
            if !CGPreflightScreenCaptureAccess() { fail(3, "screen-recording") }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                guard let window = content.windows.first(where: { $0.windowID == self.windowID }),
                      let app = window.owningApplication,
                      app.processID == self.originalPID else { fail(5, "no window") }
            } catch {
                fail(4, "capture-failed")
            }
            fail(4, "capture-failed")
        }
    }

    // MARK: recheck

    private func startRecheck() {
        guard recheckTask == nil else { return }
        recheckTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                if self.stopped { return }
                await self.recheck()
            }
        }
    }

    /// At least once per second, even with no complete samples: verify the
    /// grant, the window id and its original owner, and notice a resize.
    private func recheck() async {
        if !CGPreflightScreenCaptureAccess() { fail(3, "screen-recording") }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == self.windowID }),
                  let app = window.owningApplication else { fail(5, "no window") }
            if originalPID != 0 && app.processID != originalPID { fail(5, "window-gone") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let native = nativePixels(filter: filter, window: window)
            let onScreen = window.isOnScreen
            stateQueue.async { self.applyRecheck(native, onScreen: onScreen) }
        } catch {
            // A transient shareable-content failure is retried on the next tick.
        }
    }

    private func applyRecheck(_ native: CGSize, onScreen: Bool) {
        guard !stopped, let current = nativeSize else { return }
        if !onScreen {
            offScreen = true
        } else if offScreen {
            // Restored from minimized/occluded: the next complete image must
            // start a fresh GOP.
            offScreen = false
            resumeNeedsSync = true
        }
        if abs(current.width - native.width) < 0.75, abs(current.height - native.height) < 0.75 { return }
        retune(native: native, nextTier: tier, configChanged: true)
    }
}

var activeStreamer: WindowStreamer?

func startStream(id: CGWindowID, codec: StreamCodec) {
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
            guard args.count == 4, let rawId = UInt32(args[2]), rawId >= 1,
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
