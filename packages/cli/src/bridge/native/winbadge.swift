// The on-Mac indicator that the phone is controlling this Mac: a red pill at
// the top of every screen and a dot in the menu bar whose menu stops the
// session. No grant is needed. Built on demand by Phren Hook with swiftc and
// stopped with SIGTERM; see mac-windows.ts.
import Cocoa

func fail(_ code: Int32, _ message: String) -> Never { FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(code) }

// The pill itself: a rounded system-red bar with the white label on top.
final class PillView: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemRed.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
    }
}

final class Controller: NSObject, NSApplicationDelegate {
    private var panels: [NSPanel] = []
    private var statusItem: NSStatusItem?
    private var signalSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        statusItem = makeStatusItem()
        rebuild()
        // A signal is not evidence of a panel: a session with no screens, or
        // panels that never became visible, must not report ready.
        guard !NSScreen.screens.isEmpty, panels.contains(where: { $0.isVisible }) else { fail(4, "no screen") }
        // The Hook waits for this line before admitting an action, so the
        // panels must be ordered front by now.
        print("ready")
        fflush(stdout)
        watchSignal()
        watchStdin()
        // A forgotten badge should not outlive the session by much.
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(4 * 60 * 60)) { exit(0) }
    }

    @objc private func stop() { exit(10) }

    @objc private func screensChanged() { rebuild() }

    private func makeStatusItem() -> NSStatusItem {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.attributedTitle = NSAttributedString(string: "●", attributes: [
                .foregroundColor: NSColor.systemRed,
                .font: NSFont.systemFont(ofSize: 14),
            ])
        }
        let menu = NSMenu()
        let stopItem = NSMenuItem(title: "Stop phone control", action: #selector(stop), keyEquivalent: "")
        stopItem.target = self
        menu.addItem(stopItem)
        item.menu = menu
        return item
    }

    // One floating pill per screen, rebuilt when screens are added or removed.
    private func rebuild() {
        for panel in panels { panel.orderOut(nil) }
        panels.removeAll()
        for screen in NSScreen.screens { panels.append(makePanel(for: screen)) }
    }

    private func makePanel(for screen: NSScreen) -> NSPanel {
        let text = "● Your phone is controlling this Mac"
        let padding: CGFloat = 14, height: CGFloat = 28
        let font = NSFont.boldSystemFont(ofSize: 13)
        let textSize = (text as NSString).size(withAttributes: [.font: font])
        let size = NSSize(width: textSize.width.rounded(.up) + padding * 2, height: height)

        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Phren phone control"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isExcludedFromWindowsMenu = true

        let pill = PillView(frame: NSRect(origin: .zero, size: size))
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = .white
        label.alignment = .center
        label.frame = NSRect(x: padding, y: (height - textSize.height) / 2, width: size.width - padding * 2, height: textSize.height)
        pill.addSubview(label)
        panel.contentView = pill

        let visible = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height))
        panel.orderFrontRegardless()
        return panel
    }

    private func watchSignal() {
        _ = signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { exit(0) }
        source.resume()
        signalSource = source
    }

    // The Hook holds our stdin open for the session: EOF means it died.
    private func watchStdin() {
        DispatchQueue.global(qos: .utility).async {
            while true {
                if FileHandle.standardInput.availableData.isEmpty { exit(0) }
            }
        }
    }
}

let application = NSApplication.shared
_ = application.setActivationPolicy(.accessory)
let controller = Controller()
application.delegate = controller
application.run()
