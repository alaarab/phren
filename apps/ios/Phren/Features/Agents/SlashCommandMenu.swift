import PhrenKit
import SwiftUI

/// Suggestions fill the draft; only Send executes a command. The live menu
/// remains available for commands supplied by skills and agent extensions.
struct SlashCommandMenu: View {
    let source: String
    let draft: String
    let choose: (String) -> Void
    let openAll: () -> Void
    @ScaledMetric(relativeTo: .caption) private var rowHeight = 58.0

    var body: some View {
        let commands = AgentSlashCommand.menu(source: source, draft: draft)
        VStack(spacing: 0) {
            if !commands.isEmpty {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(commands) { command in
                            Button { choose(command.name) } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(command.name).font(.system(.subheadline, design: .monospaced, weight: .semibold))
                                            .foregroundStyle(PhrenTheme.text)
                                        Text(command.detail).font(.system(.caption, design: .monospaced))
                                            .foregroundStyle(PhrenTheme.textMuted).fixedSize(horizontal: false, vertical: true)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "return").font(.caption).foregroundStyle(PhrenTheme.textDim)
                                }.padding(.horizontal, 16).padding(.vertical, 10)
                                    .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
                                    .contentShape(Rectangle())
                            }.accessibilityIdentifier("chat-command:" + command.name)
                        }
                    }
                }.frame(height: min(rowHeight * Double(commands.count), min(220, rowHeight * 3.5)))
                    .scrollIndicators(.visible)
                    .accessibilityIdentifier("chat-command-list")
                Rectangle().fill(PhrenTheme.borderStrong).frame(height: 0.5).padding(.horizontal, 16)
            }
            Button(action: openAll) {
                HStack {
                    Text("All commands").font(.caption.weight(.medium))
                    Spacer()
                    Image(systemName: "terminal").font(.caption)
                }.padding(.horizontal, 16).frame(minHeight: 44).contentShape(Rectangle())
            }.foregroundStyle(PhrenTheme.cyan).accessibilityIdentifier("chat-all-commands")
        }.buttonStyle(.plain)
            .background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(PhrenTheme.borderStrong, lineWidth: 0.5) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-command-menu")
    }
}
