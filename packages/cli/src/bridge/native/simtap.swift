// Touches and keys for the iOS Simulator, without AppleScript: the window
// is found through the Accessibility API and events are posted with CGEvent,
// so one Accessibility grant for this helper is all macOS asks for.
// Built on demand by Phren Hook with swiftc; see simulators.ts.
import ApplicationServices
import Cocoa

func fail(_ code: Int32, _ message: String) -> Never { FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(code) }

let args = CommandLine.arguments
guard args.count >= 3 else { fail(2, "usage: simtap <window-title-prefix> tap <fx> <fy> | key <keycode> [cmd] [shift] | type <text> | raise") }
let prefix = args[1], command = args[2]

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
func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap); usleep(40_000) }

switch command {
case "raise": raise()
case "tap":
    guard args.count >= 5, let fx = Double(args[3]), let fy = Double(args[4]) else { fail(2, "tap needs fx fy") }
    raise()
    let f = frame(window)
    // The device screen fills the window below its title bar.
    let titleBar: CGFloat = 28
    let point = CGPoint(x: f.origin.x + CGFloat(fx) * f.width, y: f.origin.y + titleBar + CGFloat(fy) * (f.height - titleBar))
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
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
    guard args.count >= 4 else { fail(2, "type needs text") }
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
