import SwiftTerm
import SwiftUI

/// Terminal behaviour that has no place on the toolbar: the cursor, the
/// screen, autocorrection — each applied to every open terminal.
enum TerminalSettings {
    static let cursorStyleKey = "terminal.cursorStyle.v1"   // block | underline | bar
    static let cursorBlinkKey = "terminal.cursorBlink.v1"
    static let keepScreenOnKey = "terminal.keepScreenOn.v1"
    static let autocorrectionKey = "terminal.autocorrection.v1"
    static let pinchKey = "terminal.gestures.pinch.v1"
    static let holdSelectKey = "terminal.gestures.holdSelect.v1"
    static let twoFingerKey = "terminal.twoFingerGestures.v1"
    static let changed = Notification.Name("phren.terminalSettingsChanged")

    static var cursorStyle: CursorStyle {
        let defaults = AppRuntime.defaults
        let blink = defaults.object(forKey: cursorBlinkKey) as? Bool ?? true
        switch defaults.string(forKey: cursorStyleKey) ?? "block" {
        case "underline": return blink ? .blinkUnderline : .steadyUnderline
        case "bar": return blink ? .blinkBar : .steadyBar
        default: return blink ? .blinkBlock : .steadyBlock
        }
    }
    static var keepsScreenOn: Bool { AppRuntime.defaults.bool(forKey: keepScreenOnKey) }
    static var autocorrects: Bool { AppRuntime.defaults.bool(forKey: autocorrectionKey) }
    static func enabled(_ key: String) -> Bool { AppRuntime.defaults.object(forKey: key) as? Bool != false }
}

struct TerminalAdvancedSettingsView: View {
    @AppStorage(TerminalSettings.cursorStyleKey) private var cursorStyle = "block"
    @AppStorage(TerminalSettings.cursorBlinkKey) private var cursorBlink = true
    @AppStorage(TerminalSettings.keepScreenOnKey) private var keepScreenOn = false
    @AppStorage(TerminalSettings.autocorrectionKey) private var autocorrection = false

    var body: some View {
        PhrenList {
            Section("Cursor") {
                PhrenStepSlider(options: [
                    PhrenOption(id: "block", value: "block", title: "▮ Block"),
                    PhrenOption(id: "underline", value: "underline", title: "▁ Underline"),
                    PhrenOption(id: "bar", value: "bar", title: "▏Bar"),
                ], selection: $cursorStyle, identifier: "terminal-cursor-style")
                PhrenSwitch("Cursor blink", isOn: $cursorBlink).accessibilityIdentifier("terminal-cursor-blink")
            }
            Section {
                PhrenSwitch(isOn: $keepScreenOn) { Label { Text("Keep screen on"); Text("Don't sleep while a terminal is open").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "sun.max") } }
                    .accessibilityIdentifier("terminal-keep-screen-on")
            } header: { Text("Behaviour") }
            Section {
                PhrenSwitch(isOn: $autocorrection) { Label("Terminal autocorrection", systemImage: "textformat.abc.dottedunderline") }
                    .accessibilityIdentifier("terminal-autocorrection")
            } header: { Text("Input") } footer: { Text("Off keeps the keyboard from rewriting commands. Chat has its own switch under Chat.") }
        }
        .onChange(of: cursorStyle) { _, _ in NotificationCenter.default.post(name: TerminalSettings.changed, object: nil) }
        .onChange(of: cursorBlink) { _, _ in NotificationCenter.default.post(name: TerminalSettings.changed, object: nil) }
        .onChange(of: autocorrection) { _, _ in NotificationCenter.default.post(name: TerminalSettings.changed, object: nil) }
        .navigationTitle("Advanced").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}

struct TerminalGesturesSettingsView: View {
    @AppStorage(TerminalSettings.pinchKey) private var pinch = true
    @AppStorage(TerminalSettings.holdSelectKey) private var holdSelect = true
    @AppStorage(TerminalSettings.twoFingerKey) private var twoFinger = true

    var body: some View {
        PhrenList {
            Section {
                PhrenSwitch(isOn: $pinch) { Label { Text("Pinch"); Text("Adjust the text size").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "arrow.up.left.and.arrow.down.right") } }
                    .accessibilityIdentifier("gesture-pinch")
                PhrenSwitch(isOn: $holdSelect) { Label { Text("Hold"); Text("Select text, then drag").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "hand.tap") } }
                    .accessibilityIdentifier("gesture-hold")
                PhrenSwitch(isOn: $twoFinger) { Label { Text("Two-finger swipe"); Text("Up opens shortcuts, down hides the keyboard").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "hand.point.up.left.and.text") } }
                    .accessibilityIdentifier("gesture-two-finger")
            } header: { Text("Terminal") } footer: { Text("Taps always go to the terminal: they click links, menus and buttons in the agent's own screen. Swipe with one finger to scroll.") }
        }
        .navigationTitle("Gestures").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}
