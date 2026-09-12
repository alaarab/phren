import PhrenKit
import SwiftUI
import UIKit

struct TerminalControls: View {
    let terminal: TouchTerminalView
    let hostID: UUID
    let source: String
    let enabled: Bool
    @Binding var control: Bool
    @Binding var shortcuts: Bool
    let send: (String) -> Void
    let attach: ([AgentAttachment]) -> Void
    @State private var attachmentSource: ChatAttachmentSource?
    @State private var pendingAttachments: [AgentAttachment] = []
    @State private var directions = false
    @State private var workspaces = false
    @State private var servers = false
    @AppStorage(TerminalToolbarPreferences.storageKey) private var toolbarData = Data()
    private var toolbarItems: [TerminalToolbarItem] { ((try? TerminalToolbarPreferences.read(toolbarData)) ?? .defaults).items }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(toolbarItems) { item in
                controlView(item).accessibilityIdentifier("terminal-control:\(item.rawValue)")
            }
        }
        .font(.system(size: 15, weight: .medium, design: .monospaced))
        .buttonStyle(.plain).foregroundStyle(PhrenTheme.text)
        .padding(.horizontal, 5).padding(.vertical, 2)
        .background(PhrenTheme.chatPanel, in: Capsule())
        .overlay { Capsule().strokeBorder(PhrenTheme.borderStrong, lineWidth: 0.5) }
        .contentShape(Capsule())
        .dismissKeyboardOnDownwardDrag { _ = terminal.resignFirstResponder() }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("terminal-toolbar")
        .disabled(!enabled)
        .onChange(of: toolbarItems) { _, items in
            if !items.contains(.control) { terminal.controlModifier = false; control = false }
        }
        .popover(isPresented: $shortcuts) {
            TerminalShortcutMenu(source: source, enabled: enabled, send: send, close: { shortcuts = false },
                                 openWorkspaces: { shortcuts = false; workspaces = true },
                                 openServers: { shortcuts = false; servers = true },
                                 upload: { source in shortcuts = false; attachmentSource = source })
                .presentationBackground(PhrenTheme.chatPanel)
                .presentationCompactAdaptation(.popover)
        }
        .sheet(item: $attachmentSource, onDismiss: {
            if !pendingAttachments.isEmpty { let items = pendingAttachments; pendingAttachments = []; attach(items) }
        }) { source in
            ChatAttachmentPicker(initialSource: source, canAdd: pendingAttachments.count < 4, add: {
                if pendingAttachments.count < 4 { pendingAttachments.append($0) }
            }, context: nil)
        }
        .navigationDestination(isPresented: $workspaces) { HerdrWorkspacesView(hostID: hostID) }
        .navigationDestination(isPresented: $servers) { WebServersView(hostID: hostID) }
    }

    @ViewBuilder private func controlView(_ item: TerminalToolbarItem) -> some View {
        switch item {
        case .control:
            TerminalControlKey(selected: control, tap: {
                terminal.controlModifier.toggle(); control = terminal.controlModifier
            }, hold: { shortcuts = true })
                .frame(maxWidth: .infinity).frame(height: 44)
        case .arrows:
            icon("dpad", "Arrow keys") { directions.toggle() }
                .popover(isPresented: $directions) {
                    VStack(spacing: 5) {
                        HStack(spacing: 5) {
                            arrow("delete.left", "Backspace", "\u{7F}")
                            arrow("chevron.up", "Up", "\u{1B}[A")
                            arrow("eraser", "Clear line", "\u{05}\u{15}")
                        }
                        HStack(spacing: 5) {
                            arrow("chevron.left", "Left", "\u{1B}[D")
                            arrow("return", "Enter", "\r")
                            arrow("chevron.right", "Right", "\u{1B}[C")
                        }
                        arrow("chevron.down", "Down", "\u{1B}[B")
                    }.padding(10).buttonStyle(.plain)
                        .presentationBackground(PhrenTheme.chatPanel)
                        .presentationCompactAdaptation(.popover)
                }
        case .shortcuts: icon(item.symbol, item.title) { shortcuts.toggle() }
        case .paste: icon(item.symbol, item.title) { terminal.paste(nil) }
        case .keyboard: icon(item.symbol, item.title) { terminal.toggleKeyboard() }
        case .attachments: icon(item.symbol, item.title) { attachmentSource = .photos }
        case .workspaces: icon(item.symbol, item.title) { workspaces = true }
        case .webServers: icon(item.symbol, item.title) { servers = true }
        default:
            if let sequence = item.sequence {
                if let label = item.keyLabel { key(label, sequence).accessibilityLabel(item.title) }
                else { icon(item.symbol, item.title) { send(sequence) } }
            }
        }
    }

    private func key(_ title: String, _ sequence: String) -> some View {
        Button { send(sequence) } label: {
            Text(title).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
    }
    private func icon(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }.accessibilityLabel(title)
    }
    private func arrow(_ symbol: String, _ title: String, _ sequence: String) -> some View {
        Button { send(sequence) } label: {
            Image(systemName: symbol).font(.system(size: 20, weight: .medium))
                .foregroundStyle(title == "Enter" ? PhrenTheme.cyan : PhrenTheme.text)
                .frame(width: 56, height: 48)
                .background(PhrenTheme.surface.opacity(0.45), in: RoundedRectangle(cornerRadius: 15))
                .contentShape(Rectangle())
        }.accessibilityLabel(title)
    }
}

/// A cancelled UIKit touch cannot also trigger the Ctrl tap after a hold.
private struct TerminalControlKey: UIViewRepresentable {
    let selected: Bool
    let tap: () -> Void
    let hold: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .custom)
        button.setTitle("Ctrl", for: .normal)
        button.titleLabel?.font = .monospacedSystemFont(ofSize: 15, weight: .medium)
        button.layer.cornerRadius = 18
        button.addTarget(context.coordinator, action: #selector(Coordinator.tap), for: .touchUpInside)
        let hold = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.hold(_:)))
        hold.minimumPressDuration = 0.4
        hold.cancelsTouchesInView = true
        button.addGestureRecognizer(hold)
        button.accessibilityLabel = "Ctrl"
        button.accessibilityHint = "Tap for Control. Hold for shortcuts."
        button.accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Open shortcuts", target: context.coordinator, selector: #selector(Coordinator.accessibleHold))]
        return button
    }
    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.parent = self
        button.isEnabled = context.environment.isEnabled
        button.isUserInteractionEnabled = context.environment.isEnabled
        button.setTitleColor(UIColor(selected ? PhrenTheme.cyan : PhrenTheme.text), for: .normal)
        button.backgroundColor = selected ? UIColor(PhrenTheme.cyan.opacity(0.14)) : .clear
        button.accessibilityValue = selected ? "On" : "Off"
    }
    final class Coordinator: NSObject {
        var parent: TerminalControlKey
        init(_ parent: TerminalControlKey) { self.parent = parent }
        @objc func tap() { parent.tap() }
        @objc func hold(_ gesture: UILongPressGestureRecognizer) {
            if gesture.state == .began { UISelectionFeedbackGenerator().selectionChanged(); parent.hold() }
        }
        @objc func accessibleHold() -> Bool { parent.hold(); return true }
    }
}

private struct TerminalShortcutMenu: View {
    let source: String
    let enabled: Bool
    let send: (String) -> Void
    let close: () -> Void
    let openWorkspaces: () -> Void
    let openServers: () -> Void
    let upload: (ChatAttachmentSource) -> Void
    var storage = TerminalShortcutStorage()
    @State private var tab = ""
    @State private var settings = false
    @State private var customize = false
    @State private var editing: TerminalShortcut?
    @State private var editingPanel: TerminalShortcutPanelID = .favorites
    @State private var error: String?
    @State private var sequenceTask: Task<Void, Never>?
    @ScaledMetric(relativeTo: .caption) private var tileWidth = 100.0
    private var preferences: TerminalShortcutPreferences { storage.preferences }
    private var selected: TerminalShortcutPanel { preferences.selectedPanel(preferred: tab, source: source) }

    var body: some View {
        VStack(spacing: 10) {
            header
            if settings {
                TerminalGestureSettings()
                Button { customize = true } label: { Label("Customize shortcut panels", systemImage: "rectangle.grid.2x2") }
                    .frame(minHeight: 44).accessibilityIdentifier("terminal-customize-shortcuts")
            } else {
                ScrollView {
                    if selected.active.isEmpty {
                        Text("Add a shortcut here, or hold a shortcut in another panel to add it to Favorites.")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted).padding()
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: tileWidth))], spacing: 8) {
                        ForEach(selected.active) { shortcut in shortcutTile(shortcut) }
                    }
                }.frame(maxHeight: 220)
                HStack {
                    Text("Hold a shortcut to edit it.").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                    Spacer()
                    Button {
                        editingPanel = selected.id; editing = TerminalShortcut()
                    } label: { Label("Add", systemImage: "plus").font(.caption).frame(minHeight: 36) }
                        .disabled(storage.saved == nil || selected.shortcuts.count >= 64)
                        .accessibilityIdentifier("terminal-add-shortcut")
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning) }
        }.padding(10).frame(idealWidth: 370, maxWidth: 400)
            .buttonStyle(.plain).foregroundStyle(PhrenTheme.text)
            .accessibilityElement(children: .contain).accessibilityIdentifier("terminal-shortcut-menu")
            .sheet(isPresented: $customize) {
                NavigationStack {
                    TerminalShortcutSettingsView().toolbar {
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { customize = false } }
                    }
                }
            }
            .sheet(item: $editing) { shortcut in
                NavigationStack {
                    TerminalShortcutEditor(shortcut: shortcut, isNew: !preferences.panels.flatMap(\.shortcuts).contains { $0.id == shortcut.id }) { updated in
                        var value = preferences
                        guard let index = value.panels.firstIndex(where: { $0.id == editingPanel }) else { return }
                        if let row = value.panels[index].shortcuts.firstIndex(where: { $0.id == updated.id }) {
                            value.panels[index].shortcuts[row] = updated
                        } else { value.panels[index].shortcuts.append(updated) }
                        try storage.save(value)
                    }
                }
            }
            .onDisappear { sequenceTask?.cancel() }
            .onChange(of: enabled) { _, enabled in if !enabled { sequenceTask?.cancel() } }
    }

    private var header: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 4) {
                    ForEach(preferences.visiblePanels) { panel in tabButton(panel.id) }
                }
            }.scrollIndicators(.hidden)
            Button { settings.toggle() } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                .accessibilityLabel("Terminal gestures")
                .accessibilityHint("Gesture options and shortcut customization")
            Button(action: close) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                .accessibilityLabel("Close shortcuts")
        }
    }

    private func tabButton(_ id: TerminalShortcutPanelID) -> some View {
        Button { tab = id.rawValue; settings = false } label: {
            Group {
                if id == .favorites || id == .uploads { Image(systemName: id.symbol) }
                else { Text(id.title) }
            }
                .font(.caption.weight(.semibold)).padding(.horizontal, 11).frame(height: 44)
                .foregroundStyle(selected.id == id ? PhrenTheme.lavender : PhrenTheme.text)
                .background(selected.id == id ? PhrenTheme.lavender.opacity(0.14) : .clear, in: Capsule())
        }.accessibilityLabel(id.title + " shortcuts")
            .accessibilityAddTraits(selected.id == id ? .isSelected : [])
    }

    private func shortcutTile(_ shortcut: TerminalShortcut) -> some View {
        Button { run(shortcut) } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    if !shortcut.symbol.isEmpty { Image(systemName: shortcut.symbol).foregroundStyle(PhrenTheme.cyan) }
                    Text(shortcut.displayLabel).font(.system(.caption, design: .monospaced)).lineLimit(2)
                }
                if !shortcut.hint.isEmpty {
                    Text(shortcut.hint).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(2)
                }
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(8)
                .background(PhrenTheme.surface.opacity(0.45), in: RoundedRectangle(cornerRadius: 16))
        }.accessibilityIdentifier(shortcut.id.contains(":/") ? "terminal-command:" + shortcut.id : "terminal-shortcut:" + shortcut.id)
            .accessibilityLabel(shortcut.kind == .action && ["photos", "camera", "files"].contains(shortcut.value)
                                ? "Attach from " + shortcut.displayLabel
                                : shortcut.displayLabel + (shortcut.hint.isEmpty ? "" : ", " + shortcut.hint))
            .disabled(!enabled || sequenceTask != nil || (shortcut.kind == .action && shortcut.value == "camera" && !UIImagePickerController.isSourceTypeAvailable(.camera)))
            .contextMenu {
                Button("Edit Shortcut", systemImage: "pencil") { editingPanel = selected.id; editing = shortcut }
                if selected.id == .favorites {
                    Button("Remove from Favorites", systemImage: "star.slash") {
                        change { value in
                            if let index = value.panels.firstIndex(where: { $0.id == .favorites }) {
                                value.panels[index].shortcuts.removeAll { $0.id == shortcut.id }
                            }
                        }
                    }
                } else {
                    Button("Add to Favorites", systemImage: "star") {
                        change { value in
                            guard let index = value.panels.firstIndex(where: { $0.id == .favorites }) else { return }
                            var copy = shortcut; copy.id = "favorite:" + shortcut.id; copy.enabled = true
                            if let row = value.panels[index].shortcuts.firstIndex(where: { $0.id == copy.id }) {
                                value.panels[index].shortcuts[row] = copy
                            } else { value.panels[index].shortcuts.append(copy) }
                        }
                    }
                }
                Button("Disable Shortcut", systemImage: "minus.circle") {
                    change { value in
                        guard let index = value.panels.firstIndex(where: { $0.id == selected.id }),
                              let row = value.panels[index].shortcuts.firstIndex(where: { $0.id == shortcut.id }) else { return }
                        value.panels[index].shortcuts[row].enabled = false
                    }
                }
            }.disabled(storage.saved == nil)
    }

    private func run(_ shortcut: TerminalShortcut) {
        guard enabled, sequenceTask == nil else { return }
        do {
            try shortcut.validate()
            if shortcut.kind == .action {
                switch shortcut.value {
                case "photos": upload(.photos)
                case "camera": upload(.camera)
                case "files": upload(.files)
                case "workspaces": openWorkspaces()
                case "webServers": openServers()
                default: break
                }
                return
            }
            let steps = try shortcut.steps()
            error = nil
            sequenceTask = Task { @MainActor in
                defer { sequenceTask = nil }
                for (index, step) in steps.enumerated() {
                    guard !Task.isCancelled, enabled else { return }
                    if index > 0 {
                        do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                    }
                    guard !Task.isCancelled else { return }
                    send(step)
                }
            }
        } catch { self.error = error.localizedDescription }
    }
    private func change(_ edit: (inout TerminalShortcutPreferences) -> Void) {
        var value = preferences; edit(&value)
        do { try storage.save(value); error = nil } catch { self.error = error.localizedDescription }
    }
}

private struct TerminalGestureSettings: View {
    @AppStorage("terminal.twoFingerGestures.v1") private var enabled = true
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("Two-finger gestures", isOn: $enabled).font(.subheadline).tint(PhrenTheme.cyan)
            Text("Swipe up with two fingers for shortcuts. Swipe down with two fingers to hide the keyboard.")
            Text("Swipe with one finger to scroll. Pinch to resize. Hold to select text. Tap controls and links to open them.")
                .foregroundStyle(PhrenTheme.textMuted)
        }.font(.caption).padding(8).fixedSize(horizontal: false, vertical: true)
    }
}
