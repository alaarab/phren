import PhrenKit
import PhrenLive
import SwiftUI

extension TalkModeController {
    /// Talk mode bound to one agent chat: its send, its transcript, and its
    /// computer's voice when the Hook offers one.
    static func chat(model: AgentChatModel, session: LiveAgentSession) -> Environment {
        #if DEBUG && targetEnvironment(simulator)
        if TalkFixture.enabled { return TalkFixture.environment(model: model, session: session) }
        #endif
        let host = session.host
        let makeVoice: @MainActor (any DictationRecognizing) -> any TalkSpeaking = { recognizer in
            var fetch: TalkVoice.Fetch?
            if model.capabilities?.allows(.speech) == true {
                fetch = { text in
                    try await PhrenConnection.speech(host: host, privateKey: try DeviceSSHKey.load(host.id), text: text)
                }
            }
            return TalkVoice(fetch: fetch, transcriber: recognizer as? SpeechTranscriber)
        }
        let send: @MainActor (String) async -> Bool = { text in await Self.send(text, model: model, session: session) }
        return Environment(
            makeRecognizer: { SpeechTranscriber() },
            makeVoice: makeVoice,
            permissions: { await SpeechTranscriber.requestPermissions() == .authorized },
            lastLine: { model.history.totalLines - 1 },
            send: send,
            reply: { line in reply(model: model, after: line) })
    }

    static func reply(model: AgentChatModel, after line: Int) -> String? {
        TalkReply.finished(messages: model.messages, turns: model.progress.turns, activity: model.activityPhase,
                           awaitingReply: model.awaitingReply, after: line)
    }

    /// Sends spoken words through the chat's own send, leaving anything typed
    /// in the composer where it was.
    static func send(_ text: String, model: AgentChatModel, session: LiveAgentSession) async -> Bool {
        guard !model.sending, model.target != nil else { return false }
        let typed = model.draft
        model.draft = text
        await model.send(session, consumeDraft: { model.draft = typed })
        guard model.deliveryError == nil else { return false }
        if model.draft == text { model.draft = typed }
        return true
    }
}

/// Talk mode's state above the composer: what it is doing, the words it is
/// hearing, and a way out.
struct TalkStatusBar: View {
    let talk: TalkModeController

    private var title: String {
        if let failure = talk.failure, !talk.isOn { return failure }
        switch talk.phase {
        case .off: return "Talk is off"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }

    private var symbol: String {
        switch talk.phase {
        case .off: "exclamationmark.triangle"
        case .listening: "ear"
        case .thinking: "ellipsis"
        case .speaking: "speaker.wave.2"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(talk.isOn ? PhrenTheme.accent : PhrenTheme.warning)
                .symbolEffect(.pulse, isActive: talk.phase == .listening || talk.phase == .speaking)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.chatText)
                    .accessibilityIdentifier("talk-status")
                if talk.phase == .listening, !talk.heard.isEmpty {
                    Text(talk.heard).font(.footnote).foregroundStyle(PhrenTheme.textMuted).lineLimit(2)
                        .accessibilityIdentifier("talk-heard")
                } else if talk.phase == .speaking {
                    Text("Talk to interrupt").font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                }
            }
            Spacer(minLength: 4)
            if talk.isOn {
                Button("Stop") { talk.stop() }
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("talk-stop")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .phrenCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("talk-bar")
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .topLeading) {
            if TalkFixture.enabled {
                Text(TalkFixture.log.entries.joined(separator: " | "))
                    .font(.system(size: 1)).opacity(0.01)
                    .accessibilityIdentifier("talk-fixture-log")
            }
        }
        #endif
    }
}
