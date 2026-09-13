import SwiftUI

/// How sessions open and how the composer behaves — the chat half of
/// Moshi's "Chat Mode" screen, without the mode switch (phren always has
/// both chat and the terminal one tap apart).
enum ChatSettings {
    static let openInKey = "chat.openSessionsIn.v1"          // "chat" | "terminal"
    static let autoSendDictationKey = "chat.autoSendDictation.v1"
    static let autocorrectionKey = "chat.autocorrection.v1"
    static var opensInTerminal: Bool { AppRuntime.defaults.string(forKey: openInKey) == "terminal" }
    static var autoSendsDictation: Bool { AppRuntime.defaults.bool(forKey: autoSendDictationKey) }
    static var autocorrects: Bool { AppRuntime.defaults.object(forKey: autocorrectionKey) as? Bool ?? true }
}

struct ChatSettingsView: View {
    @AppStorage(ChatSettings.openInKey) private var openIn = "chat"
    @AppStorage(ChatSettings.autoSendDictationKey) private var autoSend = false
    @AppStorage(ChatSettings.autocorrectionKey) private var autocorrection = true

    var body: some View {
        PhrenList {
            Section {
                Picker(selection: $openIn) {
                    Text("Chat").tag("chat")
                    Text("Herdr terminal").tag("terminal")
                } label: { Label("Open sessions in", systemImage: "bubble.left.and.text.bubble.right") }
                    .accessibilityIdentifier("chat-open-in")
            } header: { Text("Sessions") } footer: {
                Text("What a tap on a session opens. The other view is always one tap away from the header.")
            }
            Section {
                Toggle(isOn: $autoSend) { Label { Text("Send after dictation"); Text("Dictated text goes straight to the agent").font(.caption).foregroundStyle(PhrenTheme.textMuted) } icon: { Image(systemName: "paperplane") } }
                    .accessibilityIdentifier("chat-auto-send")
                Toggle(isOn: $autocorrection) { Label("Autocorrection in chat", systemImage: "textformat.abc.dottedunderline") }
                    .accessibilityIdentifier("chat-autocorrection")
            } header: { Text("Composer") }
            Section {
                HStack(spacing: 14) {
                    ForEach(["claude", "codex", "copilot", "phren"], id: \.self) { source in
                        VStack(spacing: 6) {
                            AgentProviderGlyph(source: source, size: 28)
                            Text(source == "claude" ? "Claude Code" : source == "phren" ? "phren-agent" : source.capitalized).font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                        }.frame(maxWidth: .infinity)
                    }
                }.padding(.vertical, 6)
            } header: { Text("Agents supported") } footer: {
                Text("Chat reads the agent's own transcript on your computer over SSH. Messages never pass through a Phren server.")
            }
        }
        .navigationTitle("Chat").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}
