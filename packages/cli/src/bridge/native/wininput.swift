// Phone control of one Mac app's window, without AppleScript: the window is
// found by its CGWindow id, its app raised through the Accessibility API, and
// taps, text, keys, scrolls and drags are posted with CGEvent. Built on demand
// by Phren Hook with swiftc; see mac-windows.ts.
// Exit codes: 2 usage, 3 Accessibility not granted, 4 an event could not be
// built, 5 no such window, 6 focus could not be verified, 7 the Hook (our
// parent) went away, 8 the Hook cancelled the action.
import ApplicationServices
import Carbon.HIToolbox
import Cocoa

// A closed pipe from the Hook must not kill us mid-keystroke.
_ = signal(SIGPIPE, SIG_IGN)
// SIGTERM is the badge's Stop: set a flag, then finish any press in flight.
_ = signal(SIGTERM, SIG_IGN)
let cancelLock = NSLock()
var cancelled = false
let cancelSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: DispatchQueue(label: "wininput-signal"))
cancelSource.setEventHandler {
    cancelLock.lock()
    cancelled = true
    cancelLock.unlock()
}
cancelSource.resume()

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
guard args.count >= 2 else { fail(2, "usage: wininput check | prompt | tap <id> <fx> <fy> | type <id> | key <id> <name> [cmd] [shift] [option] [control] | raise <id> | scroll <id> <fx> <fy> <dx> <dy> | drag <id> <fx1> <fy1> <fx2> <fy2> <durationMs>") }
let command = args[1]

// Gesture arguments are validated before the grant and the window lookups, so
// a bad scroll or drag exits 2 rather than 3 or 5.
var scrollArgs: (fx: Double, fy: Double, dx: Int32, dy: Int32)?
if command == "scroll" {
    guard args.count == 7, let fx = fraction(args[3]), let fy = fraction(args[4]),
          let dx = Int32(args[5]), let dy = Int32(args[6]),
          dx >= -240, dx <= 240, dy >= -240, dy <= 240, dx != 0 || dy != 0
    else { fail(2, "scroll needs fx fy in 0 to 1 and dx dy in -240 to 240, not both zero") }
    scrollArgs = (fx, fy, dx, dy)
}
var dragArgs: (fx1: Double, fy1: Double, fx2: Double, fy2: Double, durationMs: Int)?
if command == "drag" {
    guard args.count == 8, let fx1 = fraction(args[3]), let fy1 = fraction(args[4]),
          let fx2 = fraction(args[5]), let fy2 = fraction(args[6]),
          let durationMs = Int(args[7]), durationMs >= 80, durationMs <= 800
    else { fail(2, "drag needs fx1 fy1 fx2 fy2 in 0 to 1 and durationMs in 80 to 800") }
    dragArgs = (fx1, fy1, fx2, fy2, durationMs)
}

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
// Read again after raising: the raise may move the window.
func windowInfo(_ id: CGWindowID) -> (bounds: CGRect, pid: pid_t, name: String?)? {
    guard let infos = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
          let info = infos.first,
          let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
          let pid = info[kCGWindowOwnerPID as String] as? Int
    else { return nil }
    return (bounds, pid_t(pid), info[kCGWindowName as String] as? String)
}
guard let target = windowInfo(id) else { fail(5, "no window") }
let pid = target.pid
guard let app = NSRunningApplication(processIdentifier: pid) else { fail(5, "no window") }

// The Accessibility window with this frame is the one to raise; the window
// server drops a little precision, so 2 points of slack.
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
func axTitle(_ window: AXUIElement) -> String? {
    var ref: CFTypeRef?
    AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &ref)
    return ref as? String
}
let element = AXUIElementCreateApplication(pid)
var windowsRef: CFTypeRef?
AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &windowsRef)
let windows = (windowsRef as? [AXUIElement]) ?? []
// An unambiguous frame is the window; a stack of same-frame sheets is told
// apart by the window server's name, and anything left ambiguous is refused.
var matches = windows.filter { near(frame($0), target.bounds) }
if matches.count > 1, let name = target.name, !name.isEmpty { matches = matches.filter { axTitle($0) == name } }
guard matches.count == 1 else { fail(5, "no window") }
let window = matches[0]

// Both the app and its focused window must be the target before any event
// goes out, so focus cannot drift into another window mid-action.
func ensureFocus() {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { fail(6, "focus") }
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &ref) == .success,
          let focused = ref, CFEqual(focused, window) else { fail(6, "focus") }
}
func raise() {
    // A Stop or a dead Hook must not bring another app forward either.
    checkAlive()
    checkCancel()
    guard app.activate(options: []) else { fail(6, "focus") }
    guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { fail(6, "focus") }
    usleep(120_000)
    ensureFocus()
}
// The window under a screen point, found from the hit element itself or by
// walking up to the first ancestor with a window or the AXWindow role.
func pointWindow(_ point: CGPoint) -> AXUIElement? {
    var hitRef: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hitRef) == .success,
          var element = hitRef else { return nil }
    for _ in 0..<64 {
        var windowRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &windowRef) == .success,
           let value = windowRef, CFGetTypeID(value) == AXUIElementGetTypeID() {
            return value as! AXUIElement
        }
        var roleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef) == .success,
           let role = roleRef as? String, role == kAXWindowRole as String {
            return element
        }
        var parentRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parentRef) == .success,
              let value = parentRef, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        element = value as! AXUIElement
    }
    return nil
}
func post(_ event: CGEvent?, pause: useconds_t = 20_000) { event?.post(tap: .cghidEventTap); usleep(pause) }
func fraction(_ value: String) -> Double? {
    Double(value).flatMap { $0.isFinite && $0 >= 0 && $0 <= 1 ? $0 : nil }
}
// A fraction of the window's current bounds, in the top-left space CGEvent
// uses; the -1 keeps a point at 1.0 inside the frame.
func mappedPoint(_ bounds: CGRect, _ fx: Double, _ fy: Double) -> CGPoint {
    CGPoint(x: bounds.minX + CGFloat(fx) * (bounds.width - 1), y: bounds.minY + CGFloat(fy) * (bounds.height - 1))
}
// The window under a screen point must be the one being driven before anything
// is posted there: a panel or another window floating above the target hands
// hover, clicks and drags to itself.
func requireTarget(_ point: CGPoint) {
    guard let hitWindow = pointWindow(point), CFEqual(hitWindow, window) else { fail(6, "focus") }
}
// Absolute deadlines keep the drag's steps evenly spaced even when posting an
// event runs late; a step already due is not delayed.
func sleepUntil(_ deadline: UInt64) {
    let now = DispatchTime.now().uptimeNanoseconds
    guard deadline > now else { return }
    let remaining = deadline - now
    var request = timespec()
    request.tv_sec = Int(remaining / 1_000_000_000)
    request.tv_nsec = Int(remaining % 1_000_000_000)
    _ = nanosleep(&request, nil)
}
// Positive dy scrolls up and positive dx scrolls left: one pixel-unit wheel
// event with both axes at the mapped point. The source, the pointer move and
// the wheel must exist before anything is posted; the point is hit-tested
// before the move and again after it, before the wheel.
func scrollGesture(at point: CGPoint, dx: Int32, dy: Int32) {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let wheel = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    else { fail(4, "event") }
    wheel.location = point
    checkAlive()
    checkCancel()
    requireTarget(point)
    ensureFocus()
    post(move)
    // The move and the hit test take time: a Stop, a dead Hook or a window that
    // stopped being the target must not post the wheel.
    requireTarget(point)
    ensureFocus()
    checkAlive()
    checkCancel()
    wheel.post(tap: .cghidEventTap)
}
// Every event is built before the button goes down, so nothing can fail
// between down and up. The point is hit-tested before the move and again before
// the button. Once left-down is posted the gesture always ends with left-up,
// even when Stop or a dead Hook lands mid-drag; the bounded remaining steps are
// abandoned and the up goes out first.
func dragGesture(from start: CGPoint, to end: CGPoint, durationMs: Int) {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left),
          let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)
    else { fail(4, "event") }
    let steps = (durationMs + 15) / 16
    var dragged: [CGEvent] = []
    for step in 1...steps {
        let t = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        guard let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) else { fail(4, "event") }
        dragged.append(event)
    }
    checkAlive()
    checkCancel()
    requireTarget(start)
    ensureFocus()
    post(move)
    // The move and the hit test take time: a Stop, a dead Hook or a window that
    // stopped being the target must not press the button.
    requireTarget(start)
    ensureFocus()
    checkAlive()
    checkCancel()
    let began = DispatchTime.now().uptimeNanoseconds
    down.post(tap: .cghidEventTap)
    var stopped: Int32?
    for (index, event) in dragged.enumerated() {
        let deadline = began + UInt64(Double(durationMs) * 1_000_000 * Double(index + 1) / Double(steps))
        sleepUntil(deadline)
        if getppid() == 1 { stopped = 7; break }
        if isCancelled() { stopped = 8; break }
        event.post(tap: .cghidEventTap)
    }
    up.post(tap: .cghidEventTap)
    if let code = stopped { fail(code, code == 7 ? "orphaned" : "cancelled") }
}

// The Hook is our parent: if it dies we are reparented to launchd (pid 1) and
// must stop before the next press rather than send input into whatever is in
// front.
func checkAlive() {
    if getppid() == 1 { fail(7, "orphaned") }
}

// A cancel is only honoured between event pairs, so a press always gets its
// release; the Hook's bounded kill covers a helper that lingers.
func isCancelled() -> Bool {
    cancelLock.lock()
    defer { cancelLock.unlock() }
    return cancelled
}
func checkCancel() {
    if isCancelled() { fail(8, "cancelled") }
}

// Text arrives as Unicode key events, packed by scalar into chunks of at most
// 20 UTF-16 units so a surrogate pair is never split; a grapheme may span two
// chunks. A newline is Return, as the phone sends for submit.
func typeText(_ text: String) {
    checkAlive()
    checkCancel()
    var chunk: [UniChar] = []
    func flush() {
        guard !chunk.isEmpty else { return }
        ensureFocus()
        // The focus lookup blocks: a Stop or a dead Hook in that window must
        // not start the chunk.
        checkAlive()
        checkCancel()
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
        post(down, pause: 0); post(up, pause: 8_000)
        chunk.removeAll()
    }
    for scalar in text.unicodeScalars {
        if scalar.value == 10 {
            flush()
            ensureFocus()
            // The focus lookup blocks: a Stop or a dead Hook in that window
            // must not start the Return.
            checkAlive()
            checkCancel()
            post(CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_Return), keyDown: true), pause: 0)
            post(CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(kVK_Return), keyDown: false), pause: 8_000)
            continue
        }
        let units = Array(String(scalar).utf16)
        if chunk.count + units.count > 20 { flush() }
        chunk.append(contentsOf: units)
    }
    flush()
}

func press(_ code: CGKeyCode, modifiers: [String]) {
    ensureFocus()
    // The focus lookup blocks: a Stop or a dead Hook in that window must not
    // start the press.
    checkAlive()
    checkCancel()
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
    guard let raised = windowInfo(id), raised.pid == pid else { fail(5, "no window") }
    let point = mappedPoint(raised.bounds, fx, fy)
    checkAlive()
    checkCancel()
    // Hit-test before the pointer moves: a covering panel must not receive hover.
    requireTarget(point)
    ensureFocus()
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    // The move and the hit test take time, so the target and focus are checked
    // again before the click goes out.
    requireTarget(point)
    ensureFocus()
    checkAlive()
    checkCancel()
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
case "scroll":
    guard let gesture = scrollArgs else { fail(2, "scroll needs fx fy in 0 to 1 and dx dy in -240 to 240, not both zero") }
    raise()
    guard let raised = windowInfo(id), raised.pid == pid else { fail(5, "no window") }
    scrollGesture(at: mappedPoint(raised.bounds, gesture.fx, gesture.fy), dx: gesture.dx, dy: gesture.dy)
case "drag":
    guard let gesture = dragArgs else { fail(2, "drag needs fx1 fy1 fx2 fy2 in 0 to 1 and durationMs in 80 to 800") }
    raise()
    guard let raised = windowInfo(id), raised.pid == pid else { fail(5, "no window") }
    let bounds = raised.bounds
    dragGesture(from: mappedPoint(bounds, gesture.fx1, gesture.fy1), to: mappedPoint(bounds, gesture.fx2, gesture.fy2), durationMs: gesture.durationMs)
case "type":
    guard let stdinText = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) else { fail(2, "type needs UTF-8 on stdin") }
    // The limit is user-perceived characters, without a single submit newline.
    var typed = stdinText
    if typed.hasSuffix("\n") { typed.removeLast() }
    guard typed.count <= 2000 else { fail(2, "type needs at most 2000 characters") }
    raise()
    typeText(stdinText)
case "key":
    guard args.count >= 4, let code = keyCodes[args[3].lowercased()] else { fail(2, "key needs return, escape, tab, delete, forwarddelete, space, an arrow, home, end, pageup, pagedown, a-z or 0-9") }
    raise()
    press(code, modifiers: Array(args.dropFirst(4)))
default: fail(2, "unknown command \(command)")
}
