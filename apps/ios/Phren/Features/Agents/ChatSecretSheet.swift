import PhrenKit
import PhrenLive
import SwiftUI

/// Types a secret into the agent's terminal (a sudo password, a login). The
/// text lives only in this sheet's state and is cleared when it closes.
struct ChatSecretSheet: View {
    let model: AgentChatModel
    let session: LiveAgentSession
    @Environment(\.dismiss) private var dismiss
    @State private var secret = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("Typed into the agent's terminal and sent with Enter. It is not kept on this phone.")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                SecureField("Password", text: $secret)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .accessibilityIdentifier("chat-secret-field")
                Spacer(minLength: 0)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle("Password").navigationBarTitleDisplayMode(.inline)
            .phrenScreen()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { secret = ""; dismiss() }
                        .accessibilityIdentifier("chat-secret-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        let text = secret
                        secret = ""
                        dismiss()
                        Task { await model.answer(session, secret: text) }
                    }
                    .disabled(secret.isEmpty)
                    .accessibilityIdentifier("chat-secret-send")
                }
            }
        }
        .presentationDetents([.medium])
    }
}