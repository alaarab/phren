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
            if model.capabilities?.allows(.speech) == true, SpeechSettings.replyVoice() == .elevenLabs {
                fetch = { text in
                    try await PhrenConnection.speech(host: host, privateKey: try DeviceSSHKey.load(host.id), text: text)
                }
            }
            return TalkVoice(fetch: fetch, transcriber: recognizer as? SpeechTranscriber)
        }
        // What was typed before talking stays; heard words follow it in the
        // message box, and a send takes only the spoken words.
        let typed = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = typed.isEmpty ? "" : typed + " "
        let send: @MainActor (String) async -> Bool = { text in
            model.draft = typed
            return await Self.send(text, model: model, session: session)
        }
        return Environment(
            makeRecognizer: { SpeechTranscriber() },
            makeVoice: makeVoice,
            permissions: { await SpeechTranscriber.requestPermissions() == .authorized },
            lastLine: { model.history.totalLines - 1 },
            send: send,
            reply: { line in reply(model: model, after: line) },
            showHeard: { words in model.draft = words.isEmpty ? typed : prefix + words })
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

/// Talk mode's state above the composer: what it is doing, the pause
/// counting down to a send (tap to hold, tap again to send), the reply being
/// read in full, and a way out. The words heard are in the message box.
struct TalkStatusBar: View {
    let talk: TalkModeController

    private var title: String {
        if let failure = talk.failure, !talk.isOn { return failure }
        switch talk.phase {
        case .off: return "Talk is off"
        case .listening:
            if talk.held { return "Holding · tap to send" }
            if talk.countdown != nil { return talk.pause == .manual ? "Tap to send" : "Sending when you pause · tap to hold" }
            return talk.pause == .manual ? "Listening · tap Send when done" : "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking · talk to interrupt"
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
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Button { talk.tapCountdown() } label: {
                    ZStack {
                        if talk.phase == .listening, talk.countdown != nil || talk.held {
                            Circle().stroke(PhrenTheme.textDim.opacity(0.35), lineWidth: 3)
                            Circle().trim(from: 0, to: talk.held ? 1 : CGFloat(talk.countdown ?? 0))
                                .stroke(talk.held ? PhrenTheme.textMuted : PhrenTheme.accent,
                                        style: StrokeStyle(lineWidth: 3, lineCap: .round))
                                .rotationEffect(.degrees(-90))
                                .animation(.linear(duration: 0.2), value: talk.countdown)
                            Image(systemName: talk.held ? "pause.fill" : "hand.raised.fill")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(PhrenTheme.accent)
                        } else {
                            Image(systemName: symbol)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(talk.isOn ? PhrenTheme.accent : PhrenTheme.warning)
                                .symbolEffect(.pulse, isActive: talk.phase == .listening || talk.phase == .speaking)
                        }
                    }
                    .frame(width: 28, height: 28).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(talk.phase != .listening)
                .accessibilityLabel(talk.held ? "Send now" : "Hold, keep thinking")
                .accessibilityValue(talk.countdown.map { "\(Int($0 * 100)) percent" } ?? "")
                .accessibilityIdentifier("talk-countdown")
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.chatText)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("talk-status")
                Spacer(minLength: 4)
                if talk.phase == .listening, !talk.heard.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Send") { talk.sendNow() }
                        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                        .accessibilityIdentifier("talk-send")
                }
                if talk.isOn {
                    Button("Stop") { talk.stop() }
                        .font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                        .accessibilityIdentifier("talk-stop")
                }
            }
            if talk.phase == .speaking, !talk.replyText.isEmpty {
                // The whole reply, not two cut-off lines; long ones scroll.
                ScrollView {
                    Text(talk.replyText).font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("talk-reply")
                }
                .frame(maxHeight: 160)
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .padding(.leading, 2).padding(.trailing, 12).padding(.vertical, 2)
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
