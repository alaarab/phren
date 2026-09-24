import PhrenKit
import PhrenLive
import SwiftUI

/// Dictation writes straight into the composer: the words land in the
/// message as they are recognised, no separate box to review. Owned by the
/// chat screen; the chat's model stays the one source of the draft.
@Observable @MainActor
final class ChatDictationController {
    private(set) var session = DictationSession(recognizer: SpeechSettings.makeRecognizer(), transform: SpeechSettings.apply)
    /// The engine `session` was made with; a change in Settings > Voice (or
    /// Whisper finishing its download) takes effect at the next start.
    @ObservationIgnored private var engine = SpeechSettings.activeInput()
    /// Apple Intelligence's tightened candidate, shown until one is chosen.
    var preview: DictationCleanupPreview?
    @ObservationIgnored private var base = ""
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var cleanupTask: Task<Void, Never>?

    var isRecording: Bool { session.isRecording }
    var audioLevel: Float { session.audioLevel }

    /// Starts recognising into the composer after whatever is already typed.
    func start(model: AgentChatModel, host: LiveHost? = nil, isActive: @escaping @MainActor () -> Bool) {
        startTask?.cancel()
        cleanupTask?.cancel()
        preview = nil
        startTask = Task {
            guard await SpeechTranscriber.requestPermissions() == .authorized else {
                model.deliveryError = "Allow microphone and speech recognition in iPhone Settings to dictate."; return
            }
            guard !Task.isCancelled, isActive() else { return }
            let chosen = SpeechSettings.activeInput(capabilities: model.capabilities)
            // Scribe belongs to one computer: a new session per start keeps it on this chat's.
            if (chosen != engine || chosen == .scribe), !session.isRecording {
                session = DictationSession(recognizer: SpeechSettings.makeRecognizer(host: host, capabilities: model.capabilities),
                                           transform: SpeechSettings.apply)
                engine = chosen
            }
            base = model.draft + (model.draft.isEmpty || model.draft.hasSuffix(" ") || model.draft.hasSuffix("\n") ? "" : " ")
            attach(model)
            model.deliveryError = nil
            session.start(draft: model.draft)
        }
    }

    func restartSegment(model: AgentChatModel) {
        base = ""
        preview = nil
        // The send cleared the composer; reattach the draft binding before the
        // fresh segment starts so its first partial lands in the model again.
        attach(model)
        session.send()
    }

    private func attach(_ model: AgentChatModel) {
        session.readDraft = { [model] in model.draft }
        session.onDraftChange = { [model] in model.draft = $0 }
        session.onFailure = { [model] in model.deliveryError = $0 }
    }

    /// Stops and preserves the raw words in the draft. When opted in, Apple
    /// Intelligence prepares a candidate that remains separate until chosen.
    func stop(model: AgentChatModel, sendIfRequested: @escaping @MainActor () -> Void) {
        guard isRecording else { return }
        session.stop()
        model.draft = model.draft.trimmingCharacters(in: .whitespaces)
        let rawDraft = model.draft
        let base = self.base
        let rawInstruction = rawDraft.hasPrefix(base)
            ? String(rawDraft.dropFirst(base.count)) : rawDraft
        guard SpeechSettings.cleanupEnabled(in: AppRuntime.defaults), !rawInstruction.isEmpty else {
            sendIfRequested()
            return
        }
        cleanupTask?.cancel()
        cleanupTask = Task {
            do {
                let tightened = try await DictationCleanupService.clean(rawInstruction)
                guard !Task.isCancelled, model.draft == rawDraft else { return }
                guard let tightened else { sendIfRequested(); return }
                preview = DictationCleanupPreview(
                    rawDraft: rawDraft, rawInstruction: rawInstruction,
                    tightenedDraft: base.trimmingCharacters(in: .whitespaces).isEmpty
                        ? tightened : base + tightened,
                    tightenedInstruction: tightened
                )
            } catch {
                guard !Task.isCancelled else { return }
                sendIfRequested()
            }
        }
    }

    func resolvePreview(useTightened: Bool, model: AgentChatModel, sendIfRequested: @MainActor () -> Void) {
        guard let preview else { return }
        if model.draft == preview.rawDraft {
            model.draft = useTightened ? preview.tightenedDraft : preview.rawDraft
        }
        self.preview = nil
        sendIfRequested()
    }

    /// A send supersedes any cleanup still running for the old draft.
    func dropCleanup() {
        cleanupTask?.cancel()
        preview = nil
    }

    func cancelCleanupTask() { cleanupTask?.cancel() }

    /// The chat is going away: nothing keeps listening behind it.
    func tearDown() {
        startTask?.cancel(); cleanupTask?.cancel()
        session.stop()
    }
}
