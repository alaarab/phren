// Touches and keys for the iOS Simulator, without AppleScript: the window
// is found through the Accessibility API and events are posted with CGEvent,
// so one Accessibility grant for this helper is all macOS asks for.
// Built on demand by Phren Hook with swiftc; see simulators.ts.
import ApplicationServices
import Cocoa

func fail(_ code: Int32, _ message: String) -> Never { FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(code) }

let args = CommandLine.arguments
guard args.count >= 3 else { fail(2, "usage: simtap <window-title-prefix> tap <fx> <fy> | drag <fx1> <fy1> <fx2> <fy2> <ms> | key <keycode> [cmd] [shift] | type <text> | raise | prompt") }
let prefix = args[1], command = args[2]

// "prompt" asks macOS for the grant: it adds this helper to Privacy & Security
// → Accessibility (switched off) and shows the system's own dialog, so the
// person switches it on instead of hunting for a hidden folder behind +.
if command == "prompt" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    exit(AXIsProcessTrustedWithOptions(options) ? 0 : 3)
}
guard AXIsProcessTrusted() else { fail(3, "accessibility") }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first else { fail(4, "Simulator is not running") }
let element = AXUIElementCreateApplication(app.processIdentifier)
var windowsRef: CFTypeRef?
AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &windowsRef)
let windows = (windowsRef as? [AXUIElement]) ?? []
var target: AXUIElement?
for window in windows {
    var titleRef: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef)
    if let title = titleRef as? String, title.hasPrefix(prefix + " ") || title == prefix { target = window; break }
}
guard let window = target else { fail(5, "no window for \(prefix)") }

func frame(_ window: AXUIElement) -> CGRect {
    var posRef: CFTypeRef?, sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef)
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef)
    var pos = CGPoint.zero, size = CGSize.zero
    if let p = posRef { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
    if let s = sizeRef { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return CGRect(origin: pos, size: size)
}
func raise() {
    app.activate(options: [])
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    usleep(120_000)
}
func post(_ event: CGEvent?, pause: useconds_t = 40_000) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { fail(6, "focus lost") }
    event?.postToPid(app.processIdentifier)
    usleep(pause)
}

// A point given as fractions of the device screen, which fills the window below its title bar.
func screenPoint(_ f: CGRect, _ fx: Double, _ fy: Double) -> CGPoint {
    let titleBar: CGFloat = 28
    return CGPoint(x: f.origin.x + CGFloat(fx) * f.width, y: f.origin.y + titleBar + CGFloat(fy) * (f.height - titleBar))
}
func fraction(_ value: String) -> Double? { Double(value).flatMap { $0 >= 0 && $0 <= 1 ? $0 : nil } }

switch command {
case "raise": raise()
case "tap":
    guard args.count >= 5, let fx = Double(args[3]), let fy = Double(args[4]) else { fail(2, "tap needs fx fy") }
    raise()
    let point = screenPoint(frame(window), fx, fy)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
case "drag":
    // A swipe or scroll: press at the start, move in steps of about 16 ms (a frame) to the end, release.
    guard args.count >= 8, let fx1 = fraction(args[3]), let fy1 = fraction(args[4]), let fx2 = fraction(args[5]), let fy2 = fraction(args[6]),
          let ms = Int(args[7]), ms >= 50, ms <= 5_000 else { fail(2, "drag needs fx1 fy1 fx2 fy2 (0 to 1) and 50 to 5000 ms") }
    raise()
    let f = frame(window), start = screenPoint(f, fx1, fy1), end = screenPoint(f, fx2, fy2)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left))
    // Each move goes through post's own foreground check (focus lost mid-drag stops it there), paced to the duration.
    let steps = max(2, min(300, ms / 16)), pause = useconds_t(ms * 1_000 / steps)
    for step in 1...steps {
        let t = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left), pause: pause)
    }
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left))
case "key":
    guard args.count >= 4, let code = UInt16(args[3]) else { fail(2, "key needs a keycode") }
    raise()
    var flags: CGEventFlags = []
    if args.contains("cmd") { flags.insert(.maskCommand) }
    if args.contains("shift") { flags.insert(.maskShift) }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags; up?.flags = flags
    post(down); post(up)
case "type":
    guard args.count >= 4, !args[3].isEmpty, args[3].utf16.count <= 500 else { fail(2, "type needs at most 500 characters") }
    let submit = args.count == 5 && args[4] == "submit"
    guard args[3].unicodeScalars.allSatisfy({ scalar in
        (scalar.value >= 32 && scalar.value != 127) || (scalar.value == 10 && submit)
    }) else { fail(2, "invalid type controls; newline needs submit") }
    raise()
    for scalar in args[3].unicodeScalars {
        var chars = Array(String(scalar).utf16)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        post(down); post(up)
    }
default: fail(2, "unknown command \(command)")
}
