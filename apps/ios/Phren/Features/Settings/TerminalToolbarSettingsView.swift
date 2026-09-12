import PhrenKit
import SwiftUI

struct TerminalToolbarSettingsView: View {
    @AppStorage(TerminalToolbarPreferences.storageKey) private var data = Data()
    @State private var error: String?
    private var saved: TerminalToolbarPreferences? { try? TerminalToolbarPreferences.read(data) }
    private var preferences: TerminalToolbarPreferences { saved ?? .defaults }

    var body: some View {
        PhrenList {
            Section {
                HStack(spacing: 2) {
                    ForEach(preferences.items) { item in
                        Group {
                            if let title = item.keyLabel { Text(title) }
                            else { Image(systemName: item.symbol) }
                        }.frame(maxWidth: .infinity, minHeight: 44)
                    }
                }.font(.system(size: 15, weight: .medium, design: .monospaced))
                    .background(PhrenTheme.chatPanel, in: Capsule())
                    .accessibilityLabel("Terminal toolbar preview")
            }
            if saved == nil {
                Text("Saved controls could not be read and have been preserved. Restore defaults to edit them.")
                    .font(.footnote).foregroundStyle(PhrenTheme.warning)
            }
            Section {
                ForEach(preferences.items) { item in
                    Label(item.title, systemImage: item.symbol)
                        .deleteDisabled(item == .keyboard)
                        .accessibilityIdentifier("toolbar-selected:\(item.rawValue)")
                }
                .onMove { from, to in
                    var value = preferences; value.items.move(fromOffsets: from, toOffset: to); save(value)
                }
                .onDelete { offsets in
                    var value = preferences
                    value.items = value.items.enumerated().filter { !offsets.contains($0.offset) || $0.element == .keyboard }.map(\.element)
                    save(value)
                }
            } header: { Text("Visible controls") }
            footer: { Text("Drag to reorder. Remove a control to make room for another. Keyboard stays available so you can always type.") }
                .disabled(saved == nil)
            Section("Add controls") {
                ForEach(TerminalToolbarItem.allCases.filter { !preferences.items.contains($0) }) { item in
                    Button {
                        var value = preferences
                        value.items.insert(item, at: value.items.firstIndex(of: .keyboard) ?? value.items.endIndex)
                        save(value)
                    } label: {
                        HStack { Label(item.title, systemImage: item.symbol); Spacer(); Image(systemName: "plus.circle") }
                    }
                    .disabled(saved == nil || preferences.items.count >= TerminalToolbarPreferences.maximumItems)
                    .accessibilityIdentifier("toolbar-add:\(item.rawValue)")
                }
                Text("Choose up to eight controls. Changes apply to every terminal on this iPhone.")
                    .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
            }
            Section {
                Button("Restore defaults") { data = Data(); error = nil }
                    .accessibilityIdentifier("toolbar-restore-defaults")
                if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle("Terminal toolbar")
        .navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
    private func save(_ value: TerminalToolbarPreferences) {
        guard saved != nil else { return }
        do { data = try value.encoded(); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
