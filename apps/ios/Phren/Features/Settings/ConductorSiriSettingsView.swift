import SwiftUI

/// Settings → Siri and the Action button: the three phrases the App Shortcuts
/// provider answers, and a way into the Shortcuts app to assign one to the
/// Action button. The phrases are the shipped ones; this screen only names
/// them so they can be read and set up on the phone.
struct ConductorSiriSettingsView: View {
    @Environment(\.openURL) private var openURL

    private struct Phrase: Identifiable {
        let id: String
        let icon: String
        let text: String
        let detail: String
    }

    private let phrases = [
        Phrase(id: "tell", icon: "mic", text: "Tell my conductor",
               detail: "Say “Tell my conductor … in Phren” to send a line to the running conductor."),
        Phrase(id: "ask", icon: "questionmark.bubble", text: "Ask my conductor",
               detail: "Say “Ask my conductor … in Phren” and hear the conductor's next reply."),
        Phrase(id: "status", icon: "waveform.path.ecg", text: "What is Phren doing",
               detail: "Say “What is Phren doing” for how many sessions are working, waiting or idle, and the conductor's step."),
    ]

    var body: some View {
        PhrenScreen {
            PhrenGroup("Siri phrases", identifier: "conductor-siri-phrases") {
                ForEach(phrases) { phrase in
                    phraseRow(phrase)
                }
            }
            PhrenGroup("Action button", identifier: "conductor-siri-action") {
                Text("Assign “Tell my conductor” to the Action button in the Shortcuts app. The button then sends a line to the conductor without opening Phren.")
                    .font(PhrenTypography.caption)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    if let url = URL(string: "shortcuts://") { openURL(url) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "arrow.up.forward.app")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(PhrenTheme.accent)
                            .frame(width: 22)
                        Text("Open the Shortcuts app")
                            .font(PhrenTypography.body)
                            .foregroundStyle(PhrenTheme.text)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings-conductor-siri")
            }
        }
        .navigationTitle("Siri and the Action button")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func phraseRow(_ phrase: Phrase) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: phrase.icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(PhrenTheme.accent)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(phrase.text)
                    .font(PhrenTypography.subheadline.weight(.semibold))
                    .foregroundStyle(PhrenTheme.text)
                Text(phrase.detail)
                    .font(PhrenTypography.caption)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conductor-siri-phrase:\(phrase.id)")
    }
}