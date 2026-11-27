// Phone control of one Mac app's window, without AppleScript: the window is
// found by its CGWindow id, its app raised through the Accessibility API, and
// taps, text and keys are posted with CGEvent. Built on demand by Phren Hook
// with swiftc; see mac-windows.ts.
import ApplicationServices
import Carbon.HIToolbox
import Cocoa

func fail(_ code: Int32, _ message: String) -> Never { FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(code) }

// Every name the Hook may send; letters and digits are there for ⌘-shortcuts.
let keyCodes: [String: CGKeyCode] = [
    "return": CGKeyCode(kVK_Return), "escape": CGKeyCode(kVK_Escape), "tab": CGKeyCode(kVK_Tab),
    "delete": CGKeyCode(kVK_Delete), "forwarddelete": CGKeyCode(kVK_ForwardDelete), "space": CGKeyCode(kVK_Space),
    "up": CGKeyCode(kVK_UpArrow), "down": CGKeyCode(kVK_DownArrow), "left": CGKeyCode(kVK_LeftArrow), "right": CGKeyCode(kVK_RightArrow),
    "home": CGKeyCode(kVK_Home), "end": CGKeyCode(kVK_End), "pageup": CGKeyCode(kVK_PageUp), "pagedown": CGKeyCode(kVK_PageDown),
    "a": CGKeyCode(kVK_ANSI_A), "b": CGKeyCode(kVK_ANSI_B), "c": CGKeyCode(kVK_ANSI_C), "d": CGKeyCode(kVK_ANSI_D),
    "e": CGKeyCode(kVK_ANSI_E), "f": CGKeyCode(kVK_ANSI_F), "g": CGKeyCode(kVK_ANSI_G), "h": CGKeyCode(kVK_ANSI_H),
    "i": CGKeyCode(kVK_ANSI_I), "j": CGKeyCode(kVK_ANSI_J), "k": CGKeyCode(kVK_ANSI_K), "l": CGKeyCode(kVK_ANSI_L),
    "m": CGKeyCode(kVK_ANSI_M), "n": CGKeyCode(kVK_ANSI_N), "o": CGKeyCode(kVK_ANSI_O), "p": CGKeyCode(kVK_ANSI_P),
    "q": CGKeyCode(kVK_ANSI_Q), "r": CGKeyCode(kVK_ANSI_R), "s": CGKeyCode(kVK_ANSI_S), "t": CGKeyCode(kVK_ANSI_T),
    "u": CGKeyCode(kVK_ANSI_U), "v": CGKeyCode(kVK_ANSI_V), "w": CGKeyCode(kVK_ANSI_W), "x": CGKeyCode(kVK_ANSI_X),
    "y": CGKeyCode(kVK_ANSI_Y), "z": CGKeyCode(kVK_ANSI_Z),
    "0": CGKeyCode(kVK_ANSI_0), "1": CGKeyCode(kVK_ANSI_1), "2": CGKeyCode(kVK_ANSI_2), "3": CGKeyCode(kVK_ANSI_3),
    "4": CGKeyCode(kVK_ANSI_4), "5": CGKeyCode(kVK_ANSI_5), "6": CGKeyCode(kVK_ANSI_6), "7": CGKeyCode(kVK_ANSI_7),
    "8": CGKeyCode(kVK_ANSI_8), "9": CGKeyCode(kVK_ANSI_9),
]

let args = CommandLine.arguments
guard args.count >= 2 else { fail(2, "usage: wininput check | prompt | tap <id> <fx> <fy> | type <id> | key <id> <name> [cmd] [shift] [option] [control] | raise <id>") }
let command = args[1]

// "prompt" asks macOS for the grant: it adds this helper to Privacy & Security
// → Accessibility (switched off) and shows the system's own dialog, so the
// person switches it on instead of hunting for a hidden folder behind +.
if command == "check" { exit(AXIsProcessTrusted() ? 0 : 3) }
if command == "prompt" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    exit(AXIsProcessTrustedWithOptions(options) ? 0 : 3)
}
guard AXIsProcessTrusted() else { fail(3, "accessibility") }

guard args.count >= 3, let raw = UInt32(args[2]), raw > 0 else { fail(2, "\(command) needs a window id") }
let id = CGWindowID(raw)

// The window's frame and owner come from the window server, which needs no
// Screen Recording grant; its bounds are the same top-left space CGEvent uses.
guard let infos = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
      let info = infos.first,
      let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
      let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
      let pid = info[kCGWindowOwnerPID as String] as? Int
else { fail(5, "no window") }
guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { fail(5, "no window") }

// The Accessibility window with this frame is the one to raise; the window
// server drops a little precision, so 2 points of slack. The first window is
// the fallback for apps whose AX frame differs (a shadow, a title-bar quirk).
func frame(_ window: AXUIElement) -> CGRect {
    var posRef: CFTypeRef?, sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef)
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef)
    var pos = CGPoint.zero, size = CGSize.zero
    if let p = posRef, CFGetTypeID(p) == AXValueGetTypeID() { AXValueGetValue(p as! AXValue, .cgPoint, &pos) }
    if let s = sizeRef, CFGetTypeID(s) == AXValueGetTypeID() { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return CGRect(origin: pos, size: size)
}
func near(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x - b.origin.x) <= 2 && abs(a.origin.y - b.origin.y) <= 2 &&
    abs(a.width - b.width) <= 2 && abs(a.height - b.height) <= 2
}
let element = AXUIElementCreateApplication(pid_t(pid))
var windowsRef: CFTypeRef?
AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &windowsRef)
let windows = (windowsRef as? [AXUIElement]) ?? []
guard let window = windows.first(where: { near(frame($0), bounds) }) ?? windows.first else { fail(5, "no window") }

func raise() {
    app.activate(options: [])
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    usleep(120_000)
}
func post(_ event: CGEvent?, pause: useconds_t = 20_000) { event?.post(tap: .cghidEventTap); usleep(pause) }
func fraction(_ value: String) -> Double? {
    Double(value).flatMap { $0.isFinite && $0 >= 0 && $0 <= 1 ? $0 : nil }
}

// Text arrives as Unicode key events in chunks of at most 20 UTF-16 units; a
// newline is Return, as the phone sends for submit.
func typeText(_ text: String) {
    var chunk: [UniChar] = []
    func flush() {
        guard !chunk.isEmpty else { return }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        post(down, pause: 0); post(up, pause: 8_000)
        chunk.removeAll()
    }
    for character in text {
        if character == "\n" {
            flush()
            post(CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_Return), keyDown: true), pause: 0)
            post(CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_Return), keyDown: false), pause: 8_000)
            continue
        }
        let units = Array(String(character).utf16)
        if chunk.count + units.count > 20 { flush() }
        chunk.append(contentsOf: units)
        if chunk.count >= 20 { flush() }
    }
    flush()
}

func press(_ code: CGKeyCode, modifiers: [String]) {
    var flags: CGEventFlags = []
    if modifiers.contains("cmd") { flags.insert(.maskCommand) }
    if modifiers.contains("shift") { flags.insert(.maskShift) }
    if modifiers.contains("option") { flags.insert(.maskAlternate) }
    if modifiers.contains("control") { flags.insert(.maskControl) }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags; up?.flags = flags
    post(down); post(up)
}

switch command {
case "raise": raise()
case "tap":
    guard args.count >= 5, let fx = fraction(args[3]), let fy = fraction(args[4]) else { fail(2, "tap needs fx fy in 0 to 1") }
    raise()
    let point = CGPoint(x: bounds.origin.x + CGFloat(fx) * bounds.width, y: bounds.origin.y + CGFloat(fy) * bounds.height)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
case "type":
    guard let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) else { fail(2, "type needs UTF-8 on stdin") }
    guard text.count <= 2000 else { fail(2, "type needs at most 2000 characters") }
    raise()
    typeText(text)
case "key":
    guard args.count >= 4, let code = keyCodes[args[3].lowercased()] else { fail(2, "key needs return, escape, tab, delete, forwarddelete, space, an arrow, home, end, pageup, pagedown, a-z or 0-9") }
    raise()
    press(code, modifiers: Array(args.dropFirst(4)))
default: fail(2, "unknown command \(command)")
}
