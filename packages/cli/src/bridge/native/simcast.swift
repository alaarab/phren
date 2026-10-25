// Live frames of one simulator's screen for Phren Hook's stream
// (simulator-stream.ts). It reads the device's own framebuffer through
// CoreSimulator, as `simctl io` does, so macOS asks for no Screen Recording
// grant and the Simulator window may be covered, hidden or closed. Each
// changed frame is scaled and JPEG-encoded with Core Image and written to
// stdout as a 4-byte big-endian length and the JPEG. Built on demand by
// Phren Hook with swiftc, like simtap.
import CoreImage
import Foundation
import IOSurface

func fail(_ code: Int32, _ message: String) -> Never { FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(code) }

let args = CommandLine.arguments
guard args.count == 5, let udid = UUID(uuidString: args[1]), let fps = Int(args[2]), (1...30).contains(fps),
      let maxSide = Int(args[3]), (160...2400).contains(maxSide), let quality = Double(args[4]), quality >= 0.1, quality <= 1
else { fail(2, "usage: simcast <udid> <fps 1-30> <max-side 160-2400> <quality 0.1-1>") }

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil else { fail(4, "CoreSimulator is not installed") }

/// An Objective-C message by name; nil when this Xcode's CoreSimulator lacks it.
func call(_ target: AnyObject?, _ name: String, _ argument: Any? = nil) -> AnyObject? {
    let selector = NSSelectorFromString(name)
    guard let object = target as? NSObjectProtocol, object.responds(to: selector) else { return nil }
    return object.perform(selector, with: argument, with: nil)?.takeUnretainedValue()
}
/// A scalar property, boxed by key-value coding.
func number(_ target: AnyObject?, _ name: String) -> Int? {
    guard let object = target as? NSObject, object.responds(to: NSSelectorFromString(name)) else { return nil }
    return object.value(forKey: name) as? Int
}

let developerDir: String = {
    if let dir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !dir.isEmpty { return dir }
    let pipe = Pipe(), process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select"); process.arguments = ["-p"]; process.standardOutput = pipe
    try? process.run(); process.waitUntilExit()
    return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}()
guard let contextClass = NSClassFromString("SimServiceContext"),
      let context = call(contextClass, "sharedServiceContextForDeveloperDir:error:", developerDir),
      let deviceSet = call(context, "defaultDeviceSetWithError:"),
      let devices = call(deviceSet, "devices") as? [AnyObject]
else { fail(4, "CoreSimulator did not answer") }
guard let device = devices.first(where: { (call($0, "UDID") as? NSUUID)?.uuidString == udid.uuidString }) else { fail(5, "no such simulator") }
// SimDeviceState 3 is Booted.
guard number(device, "state") == 3 else { fail(5, "not booted") }

/// The device's main display: the IO port whose descriptor renders to an
/// IOSurface and whose display class is 0 (not CarPlay or an external one).
/// Asked again each tick, since rotation or a respring swaps the surface.
func framebuffer() -> IOSurface? {
    guard let ports = call(call(device, "io"), "ioPorts") as? [AnyObject] else { return nil }
    for port in ports {
        guard let descriptor = call(port, "descriptor") else { continue }
        if let display = number(call(descriptor, "state"), "displayClass"), display != 0 { continue }
        // framebufferSurface since Xcode 13, ioSurface before it.
        if let surface = (call(descriptor, "framebufferSurface") ?? call(descriptor, "ioSurface")) as? IOSurface { return surface }
    }
    return nil
}

let renderer = CIContext(options: [.cacheIntermediates: false, .name: "simcast"])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
let output = FileHandle.standardOutput
var lastSurface: IOSurface?, lastSeed: UInt32 = 0, missing = 0
// PHREN_SIMCAST_STATS=1 prints frames, encode time and bytes every 2 s.
let stats = ProcessInfo.processInfo.environment["PHREN_SIMCAST_STATS"] == "1"
var statFrames = 0, statBytes = 0, statEncode = 0.0, statSince = DispatchTime.now()

let queue = DispatchQueue(label: "simcast")
let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / fps), leeway: .milliseconds(2))
timer.setEventHandler {
    // The Hook went away without closing the pipe: stop rather than linger.
    if getppid() == 1 { exit(0) }
    guard let surface = framebuffer() else {
        // A respring drops the port briefly; a shutdown drops it for good.
        missing += 1
        if missing > fps * 3 { fail(5, "the simulator's screen went away") }
        return
    }
    missing = 0
    // The seed moves whenever the surface is written: an unchanged screen
    // costs one property read per tick and sends nothing.
    if surface === lastSurface && surface.seed == lastSeed { return }
    lastSurface = surface; lastSeed = surface.seed
    let began = DispatchTime.now()
    var image = CIImage(ioSurface: surface)
    let longest = max(image.extent.width, image.extent.height)
    guard longest > 0 else { return }
    if longest > CGFloat(maxSide) {
        let scale = CGFloat(maxSide) / longest
        image = image.samplingLinear().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
    guard let jpeg = renderer.jpegRepresentation(of: image, colorSpace: sRGB,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality])
    else { return }
    var length = UInt32(jpeg.count).bigEndian
    // A closed pipe raises SIGPIPE, which ends the helper with the stream.
    output.write(Data(bytes: &length, count: 4) + jpeg)
    guard stats else { return }
    statFrames += 1; statBytes += jpeg.count; statEncode += Double(DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds) / 1e6
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - statSince.uptimeNanoseconds) / 1e9
    if elapsed >= 2 {
        FileHandle.standardError.write(String(format: "stats fps=%.1f encode=%.1fms bytes=%d size=%dx%d\n", Double(statFrames) / elapsed,
            statEncode / Double(max(statFrames, 1)), statBytes / max(statFrames, 1), Int(image.extent.width), Int(image.extent.height)).data(using: .utf8)!)
        statFrames = 0; statBytes = 0; statEncode = 0; statSince = DispatchTime.now()
    }
}
timer.resume()
dispatchMain()
