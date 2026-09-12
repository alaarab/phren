import PhrenKit
import SwiftUI

/// Settings and the live panel share one versioned document, including disabled items.
struct TerminalShortcutStorage: DynamicProperty {
    @AppStorage(TerminalShortcutPreferences.storageKey) private var data = Data()
    @AppStorage("terminal.favorites.v1") private var favorites = "codex:/model,claude:/compact,copilot:/help"
    var saved: TerminalShortcutPreferences? { try? TerminalShortcutPreferences.read(data, favorites: favorites) }
    var preferences: TerminalShortcutPreferences { saved ?? .defaults(favorites: favorites) }
    func save(_ value: TerminalShortcutPreferences) throws {
        guard saved != nil else { throw PhrenKitError.validation("Restore defaults to edit unreadable saved shortcuts.") }
        data = try value.encoded()
    }
    func reset() { data = Data(); favorites = "codex:/model,claude:/compact,copilot:/help" }
}

struct TerminalShortcutSettingsView: View {
    var storage = TerminalShortcutStorage()
    @State private var error: String?
    @State private var selectedPanel: TerminalShortcutPanelID?
    @State private var toolbarSettings = false
    private var preferences: TerminalShortcutPreferences { storage.preferences }

    var body: some View {
        PhrenList {
            Section {
                Text("Hold Ctrl to open your shortcuts. Choose which panels appear, then tap a panel to edit its keys and icons.")
                    .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                ScrollView(.horizontal) {
                    HStack(spacing: 14) {
                        ForEach(preferences.visiblePanels) { panel in
                            Label(panel.id.title, systemImage: panel.id.symbol).font(.caption)
                        }
                    }.padding(12).background(PhrenTheme.chatPanel, in: Capsule())
                }.scrollIndicators(.hidden).accessibilityLabel("Shortcut panel preview")
            }
            if storage.saved == nil {
                Text("Saved shortcuts could not be read and have been preserved. Restore defaults to edit them.")
                    .font(.footnote).foregroundStyle(PhrenTheme.warning)
            }
            Section {
                ForEach(preferences.visiblePanels) { panel in panelRow(panel) }
                    .onMove { from, to in
                        change { value in
                            var active = value.visiblePanels; active.move(fromOffsets: from, toOffset: to)
                            value.panels = active + value.panels.filter { !$0.enabled }
                        }
                    }
            } header: { Text("Panel tabs") }
            footer: { Text("Tap − to disable a panel. Drag to reorder. Keep at least one panel active.") }
                .disabled(storage.saved == nil)
            Section("Inactive") {
                ForEach(preferences.panels.filter { !$0.enabled }) { panel in panelRow(panel) }
            }.disabled(storage.saved == nil)
            Section {
                Button { toolbarSettings = true } label: { Label("Toolbar keys & icons", systemImage: "keyboard") }
                Button("Restore all shortcut defaults") { storage.reset(); error = nil }
                    .accessibilityIdentifier("shortcuts-reset-all")
                if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle("Shortcuts").navigationBarTitleDisplayMode(.inline).phrenScreen()
        .navigationDestination(item: $selectedPanel) { TerminalShortcutPanelSettingsView(panelID: $0) }
        .navigationDestination(isPresented: $toolbarSettings) { TerminalToolbarSettingsView() }
    }
    private func panelRow(_ panel: TerminalShortcutPanel) -> some View {
        HStack(spacing: 14) {
            Button {
                change { value in
                    if let index = value.panels.firstIndex(where: { $0.id == panel.id }) { value.panels[index].enabled.toggle() }
                }
            } label: {
                Image(systemName: panel.enabled ? "minus.circle" : "plus.circle")
                    .font(.title2).foregroundStyle(panel.enabled ? Color.red : Color.green)
            }.buttonStyle(.borderless)
                .disabled(panel.enabled && preferences.visiblePanels.count == 1)
                .accessibilityLabel((panel.enabled ? "Disable " : "Enable ") + panel.id.title)
                .accessibilityIdentifier("panel-toggle:\(panel.id.rawValue)")
            Button { selectedPanel = panel.id } label: {
                Label {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(panel.id.title)
                        Text("\(panel.active.count) active · \(panel.shortcuts.count) shortcuts")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                } icon: { Image(systemName: panel.id.symbol).foregroundStyle(PhrenTheme.textMuted) }
            }.buttonStyle(.borderless).accessibilityIdentifier("panel-edit:\(panel.id.rawValue)")
        }.padding(.vertical, 4)
    }
    private func change(_ edit: (inout TerminalShortcutPreferences) -> Void) {
        var value = preferences; edit(&value)
        do { try storage.save(value); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct TerminalShortcutPanelSettingsView: View {
    let panelID: TerminalShortcutPanelID
    var storage = TerminalShortcutStorage()
    @State private var editing: TerminalShortcut?
    @State private var error: String?
    private var panel: TerminalShortcutPanel { storage.preferences.panels.first { $0.id == panelID }! }

    var body: some View {
        PhrenList {
            Section {
                ForEach(panel.active) { shortcut in shortcutRow(shortcut) }
                    .onMove { from, to in
                        change { panel in
                            var active = panel.active; active.move(fromOffsets: from, toOffset: to)
                            panel.shortcuts = active + panel.shortcuts.filter { !$0.enabled }
                        }
                    }
                if panel.active.isEmpty { Text("No active shortcuts").foregroundStyle(PhrenTheme.textMuted) }
            } header: { Text("Active") }
            footer: { Text("Tap − to disable, + to enable, or trash to delete inactive shortcuts. Drag to reorder. Tap a row to edit.") }
            Section("Inactive") {
                ForEach(panel.shortcuts.filter { !$0.enabled }) { shortcut in
                    HStack {
                        shortcutRow(shortcut)
                        Button(role: .destructive) { change { $0.shortcuts.removeAll { $0.id == shortcut.id } } } label: {
                            Image(systemName: "trash").frame(minWidth: 36, minHeight: 44)
                        }.buttonStyle(.borderless).accessibilityLabel("Delete " + shortcut.displayLabel)
                    }
                }
            }
            Section {
                Button { editing = TerminalShortcut() } label: { Label("Add Shortcut", systemImage: "plus") }
                    .disabled(panel.shortcuts.count >= 64).accessibilityIdentifier("shortcut-add")
                Button("Reset \(panelID.title)") {
                    change { $0.shortcuts = TerminalShortcutPreferences.defaults().panels.first { $0.id == panelID }!.shortcuts }
                }.accessibilityIdentifier("shortcut-panel-reset")
                if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            }
        }
        .disabled(storage.saved == nil)
        .environment(\.editMode, .constant(.active))
        .navigationTitle(panelID.title).navigationBarTitleDisplayMode(.inline).phrenScreen()
        .sheet(item: $editing) { shortcut in
            NavigationStack {
                TerminalShortcutEditor(shortcut: shortcut, isNew: !panel.shortcuts.contains { $0.id == shortcut.id }) { updated in
                    var value = storage.preferences
                    guard let index = value.panels.firstIndex(where: { $0.id == panelID }) else { return }
                    if let row = value.panels[index].shortcuts.firstIndex(where: { $0.id == updated.id }) {
                        value.panels[index].shortcuts[row] = updated
                    } else { value.panels[index].shortcuts.append(updated) }
                    try storage.save(value)
                }
            }
        }
    }
    private func shortcutRow(_ shortcut: TerminalShortcut) -> some View {
        HStack(spacing: 14) {
            Button {
                change { panel in
                    if let index = panel.shortcuts.firstIndex(where: { $0.id == shortcut.id }) { panel.shortcuts[index].enabled.toggle() }
                }
            } label: {
                Image(systemName: shortcut.enabled ? "minus.circle" : "plus.circle")
                    .font(.title2).foregroundStyle(shortcut.enabled ? Color.red : Color.green)
            }.buttonStyle(.borderless)
                .accessibilityLabel((shortcut.enabled ? "Disable " : "Enable ") + shortcut.displayLabel)
                .accessibilityIdentifier("shortcut-toggle:\(shortcut.id)")
            Button { editing = shortcut } label: {
                HStack(spacing: 12) {
                    if !shortcut.symbol.isEmpty { Image(systemName: shortcut.symbol).foregroundStyle(PhrenTheme.textMuted).frame(width: 25) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(shortcut.displayLabel).font(.system(.body, design: .monospaced))
                        Text(shortcut.bindingLabel).font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(2)
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }.contentShape(Rectangle())
            }.buttonStyle(.borderless).accessibilityIdentifier("shortcut-edit:\(shortcut.id)")
        }
    }
    private func change(_ edit: (inout TerminalShortcutPanel) -> Void) {
        var value = storage.preferences
        guard let index = value.panels.firstIndex(where: { $0.id == panelID }) else { return }
        edit(&value.panels[index])
        do { try storage.save(value); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct TerminalShortcutEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var shortcut: TerminalShortcut
    let isNew: Bool
    let save: (TerminalShortcut) throws -> Void
    @State private var error: String?
    private var validation: String? {
        do { try shortcut.validate(); return nil } catch { return error.localizedDescription }
    }

    var body: some View {
        PhrenForm {
            Section {
                HStack(spacing: 12) {
                    if !shortcut.symbol.isEmpty { Image(systemName: shortcut.symbol) }
                    Text(shortcut.value.isEmpty ? "—" : shortcut.bindingLabel)
                        .accessibilityIdentifier("shortcut-preview")
                }.font(.system(.title2, design: .monospaced))
                    .frame(maxWidth: .infinity, minHeight: 64)
            }
            Section {
                Picker("Shortcut type", selection: $shortcut.kind) {
                    Text("Key").tag(TerminalShortcut.Kind.key)
                    Text("Text").tag(TerminalShortcut.Kind.text)
                    Text("Advanced").tag(TerminalShortcut.Kind.binding)
                    Text("App action").tag(TerminalShortcut.Kind.action)
                }.pickerStyle(.menu)
            }
            if shortcut.kind == .key || shortcut.kind == .text { modifiers }
            keyInput
            Section {
                TextField("e.g. Submit", text: $shortcut.label).accessibilityIdentifier("shortcut-label")
                TextField("Optional description", text: $shortcut.hint).accessibilityIdentifier("shortcut-hint")
            } header: { Text("Button label & hint (optional)") }
            footer: { Text("The label replaces the full shortcut name on its button.") }
            Section("Icon (optional)") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))], spacing: 8) {
                    ForEach(TerminalShortcut.symbols, id: \.self) { symbol in
                        Button { shortcut.symbol = symbol } label: {
                            Group {
                                if symbol.isEmpty { Text("Aa") } else { Image(systemName: symbol) }
                            }.frame(maxWidth: .infinity, minHeight: 44)
                                .background(shortcut.symbol == symbol ? PhrenTheme.lavender.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.borderless)
                            .accessibilityLabel(symbol.isEmpty ? "No icon" : symbol)
                            .accessibilityIdentifier("shortcut-icon:\(symbol)")
                            .accessibilityAddTraits(shortcut.symbol == symbol ? .isSelected : [])
                    }
                }
            }
            if shortcut.kind != .action {
                Section {
                    Toggle("Send Enter after shortcut", isOn: $shortcut.appendEnter)
                } footer: { Text("When enabled, tapping this shortcut also submits its text or command.") }
            }
            if let message = error ?? (shortcut.value.isEmpty ? nil : validation) {
                Section { Text(message).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            }
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .navigationTitle(isNew ? "New Shortcut" : "Edit Shortcut").navigationBarTitleDisplayMode(.inline).phrenScreen()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    do { try shortcut.validate(); try save(shortcut); dismiss() }
                    catch { self.error = error.localizedDescription }
                }.disabled(validation != nil).accessibilityIdentifier("shortcut-save")
            }
        }
        .onChange(of: shortcut.kind) { _, kind in
            error = nil
            if kind == .binding || kind == .action { shortcut.modifiers = 0 }
            if kind == .action { shortcut.appendEnter = false; shortcut.value = TerminalShortcut.actions.first! }
        }
    }
    private var modifiers: some View {
        Section("Modifiers") {
            HStack(spacing: 8) {
                modifier("Ctrl", "control", 1)
                modifier("Opt", "option", 2)
                modifier("Shift", "shift", 4)
            }
        }
    }
    private func modifier(_ title: String, _ symbol: String, _ bit: Int) -> some View {
        let selected = shortcut.modifiers & bit != 0
        return Button { shortcut.modifiers ^= bit } label: {
            Label(title, systemImage: symbol).font(.system(.body, design: .monospaced))
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(selected ? PhrenTheme.lavender.opacity(0.25) : PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.borderless).accessibilityLabel(title).accessibilityValue(selected ? "On" : "Off")
            .accessibilityIdentifier("shortcut-modifier:\(title)")
    }
    @ViewBuilder private var keyInput: some View {
        switch shortcut.kind {
        case .key:
            Section("Key") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 8) {
                    ForEach(TerminalShortcut.namedKeys, id: \.self) { key in
                        Button { shortcut.value = key } label: {
                            Text(["BSpace": "⌫", "Up": "↑", "Down": "↓", "Left": "←", "Right": "→", "PageUp": "PgUp", "PageDown": "PgDn"][key] ?? key)
                                .font(.system(.body, design: .monospaced)).minimumScaleFactor(0.7).lineLimit(1)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(shortcut.value == key ? PhrenTheme.lavender.opacity(0.25) : PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.borderless).accessibilityIdentifier("shortcut-key:\(key)")
                    }
                }
                Button("Custom Key / Text…") { shortcut.kind = .text; shortcut.value = "" }
                    .accessibilityIdentifier("shortcut-custom-text")
                Button("Advanced binding…") { shortcut.kind = .binding; shortcut.value = "" }
                    .accessibilityIdentifier("shortcut-advanced")
            }
        case .text:
            Section {
                TextField("Key or text", text: $shortcut.value).font(.system(.body, design: .monospaced))
                    .accessibilityIdentifier("shortcut-text")
            } header: { Text("Custom Key / Text") }
            footer: { Text("Without modifiers, text is inserted exactly as written. With modifiers, b1 means a modified b followed by 1. Separate modified keys with a comma; use two commas for a literal comma.") }
        case .binding:
            Section {
                TextField("e.g. Ctrl+b, Shift+t", text: $shortcut.value).font(.system(.body, design: .monospaced))
                    .accessibilityIdentifier("shortcut-binding")
            } header: { Text("Advanced binding") }
            footer: { Text("Separate keystrokes with commas. Use Ctrl, Opt, Shift, or C-, M-, S-. Named keys include Esc, Tab, Enter, BSpace, arrows, Home, End, PageUp, PageDown and F1–F12. Use Space, Comma, Plus or Dash for punctuation.") }
        case .action:
            Section("App action") {
                Picker("Action", selection: $shortcut.value) {
                    ForEach(TerminalShortcut.actions, id: \.self) { action in
                        Text(["photos": "Photos", "camera": "Camera", "files": "Files", "workspaces": "Workspaces & panes", "webServers": "Web servers"][action] ?? action).tag(action)
                    }
                }
            }
        }
    }
}
