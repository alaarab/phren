import PhrenKit
import SwiftUI

/// The rows of an agent's slash-command menu, drawn natively. Choosing one
/// types the command and walks the terminal menu to that row.
struct ChatMenuPickerSheet: View {
    let title: String
    let command: String
    let rows: [AgentMenuChoice]
    let choose: (Int) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PhrenList {
                Section {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        Button { choose(index) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.name).foregroundStyle(PhrenTheme.text)
                                if let description = row.description {
                                    Text(description).font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(3)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-menu:\(index)")
                    }
                } footer: {
                    Text("Sends \(command) and picks the row in the agent's own menu.")
                }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("chat-menu-cancel") } }
            .phrenScreen()
        }
        .presentationDetents([.medium, .large])
    }
}

/// The slash command a menu sheet is for; a sheet item needs an identity.
struct ChatMenuCommand: Identifiable, Equatable {
    let command: String
    var id: String { command }
}
