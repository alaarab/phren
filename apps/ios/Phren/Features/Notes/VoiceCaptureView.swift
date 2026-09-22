import SwiftUI
import UIKit
import PhrenKit

/// One writable (store, project) pair a voice note can be filed under —
/// same shape as `AddTaskSheet.Target` (Features/Tasks/TasksView.swift) for
/// the same reason: the destination is ambiguous whenever more than one
/// store/project is writable.
struct VoiceCaptureTarget: Identifiable, Hashable {
    let storeId: String
    let storeName: String
    let project: String
    var id: String { "\(storeId)|\(project)" }
}

/// Bridges UIKit's "attempted interactive dismiss while disabled" delegate
/// callback into SwiftUI. `.interactiveDismissDisabled(true)` alone just
/// blocks the swipe silently — this makes the swipe attempt actionable so we
/// can show a proper discard confirmation instead of a dead bounce.
private struct DismissAttemptDetector: UIViewControllerRepresentable {
    let onAttempt: () -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        controller.view.backgroundColor = .clear
        DispatchQueue.main.async {
            controller.parent?.presentationController?.delegate = context.coordinator
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onAttempt: onAttempt) }

    final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
        let onAttempt: () -> Void
        init(onAttempt: @escaping () -> Void) { self.onAttempt = onAttempt }

        func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
            onAttempt()
        }
    }
}

/// Voice quick-capture sheet: tap the mic to start/stop live dictation into
/// an editable `TextEditor`, optionally keep dictating (appends to whatever
/// text is currently there, edits and all), pick the destination project,
/// and save as a note via `model.perform(.addNote(...))`.
struct VoiceCaptureView: View {
    /// What the dictated text becomes on save. Notes carry a timestamp and
    /// land in notes/YYYY-MM-DD.md; tasks append to the project's queue.
    enum CaptureKind: String, CaseIterable {
        case note = "Note"
        case task = "Task"
    }

    /// Every writable (store, project) pair the note could be filed under.
    let targets: [VoiceCaptureTarget]
    /// Pins the destination when opened from a project's own Notes tab.
    let preselected: VoiceCaptureTarget?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var transcriber = DictationSession(recognizer: SpeechTranscriber(), transform: SpeechSettings.apply)
    @State private var text = ""
    @State private var selectedTarget: VoiceCaptureTarget?
    @State private var permission: SpeechTranscriber.PermissionState = .notDetermined
    @State private var recognizerUnavailable = false
    @State private var recordingStartedAt: Date?
    @State private var now = Date()
    @State private var pulse = false
    @State private var confirmDiscard = false
    @State private var saving = false
    @State private var kind: CaptureKind = .note
    @State private var showingTarget = false

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    init(targets: [VoiceCaptureTarget], preselected: VoiceCaptureTarget? = nil) {
        self.targets = targets
        self.preselected = preselected
    }

    var body: some View {
        NavigationStack {
            Group {
                if targets.isEmpty {
                    PhrenEmptyState(
                        title: "No writable store yet",
                        message: "Your GitHub token needs Contents: Read and write on the store repo before you can add notes."
                    )
                } else {
                    VStack(spacing: 20) {
                        PhrenTextSegment(items: CaptureKind.allCases.map {
                            PhrenOption(id: $0.rawValue, value: $0, title: $0.rawValue)
                        }, selection: $kind, identifier: "voice-capture-kind")
                        micArea
                        editorSection
                        destinationFooter
                    }
                    .padding()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .phrenScreen()
            .navigationTitle(kind == .note ? "Dictate a note" : "Dictate a task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { attemptDismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: {
                        if saving {
                            ProgressView()
                        } else {
                            Text("Save")
                        }
                    }
                    .disabled(!canSave || saving)
                }
            }
        }
        .background(DismissAttemptDetector { confirmDiscard = true })
        .interactiveDismissDisabled(hasUnsavedText)
        .phrenDialog(
            isPresented: $confirmDiscard,
            title: kind == .note ? "Discard this note?" : "Discard this task?",
            message: "The text you dictated will be lost.",
            actions: [
                .init(id: "discard", title: "Discard", role: .destructive) { dismiss() },
                .init(id: "keep", title: "Keep editing", role: .cancel) {},
            ],
            identifier: "voice-capture-discard-dialog"
        )
        .phrenSingleSelectSheet(isPresented: $showingTarget, title: "Project", options: targetOptions,
                                selection: $selectedTarget, rowPrefix: "voice-capture-project")
        .task {
            selectedTarget = preselected ?? Self.defaultTarget(in: targets)
            await preparePermissions()
        }
        .onReceive(ticker) { now = $0 }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background, .inactive:
                // Never leave the mic listening once we're not visible.
                transcriber.stop()
            case .active:
                Task { await preparePermissions() }
            default:
                break
            }
        }
        .onDisappear {
            transcriber.stop()
        }
    }

    // MARK: - Mic / permission area

    @ViewBuilder
    private var micArea: some View {
        if permission == .denied {
            permissionDeniedGuidance
        } else {
            micButtonSection
        }
    }

    private var micButtonSection: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(PhrenTheme.surfaceRaised)
                    .frame(width: 132, height: 132)
                    .overlay(Circle().stroke(PhrenTheme.border, lineWidth: 1))

                if transcriber.isRecording {
                    Circle()
                        .stroke(PhrenTheme.cyan.opacity(0.45), lineWidth: 3)
                        .frame(width: 132 + CGFloat(transcriber.audioLevel) * 44,
                               height: 132 + CGFloat(transcriber.audioLevel) * 44)
                        .animation(.easeOut(duration: 0.1), value: transcriber.audioLevel)
                    Circle()
                        .stroke(PhrenTheme.cyan.opacity(0.25), lineWidth: 2)
                        .frame(width: pulse ? 176 : 132, height: pulse ? 176 : 132)
                        .opacity(pulse ? 0 : 1)
                        .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulse)
                }

                Button(action: toggleRecording) {
                    Image(systemName: transcriber.isRecording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 38, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 96, height: 96)
                        .background(Circle().fill(transcriber.isRecording ? PhrenTheme.danger : PhrenTheme.accentSolid))
                        .shadow(color: (transcriber.isRecording ? PhrenTheme.danger : PhrenTheme.accent).opacity(0.5), radius: 16)
                }
                .buttonStyle(.plain)
                .disabled(recognizerUnavailable || permission != .authorized)
                .accessibilityLabel(transcriber.isRecording ? "Stop dictation" : "Start dictation")
            }
            .onAppear { pulse = true }

            if transcriber.isRecording {
                Text(elapsedText)
                    .font(.title3.monospacedDigit())
                    .foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityLabel("Recording, \(elapsedText) elapsed")
            } else if let reason = transcriber.failureReason {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(PhrenTheme.warning)
                    .multilineTextAlignment(.center)
            } else if recognizerUnavailable {
                Text("Dictation isn't available in this language on this device. You can still type below.")
                    .font(.footnote)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .multilineTextAlignment(.center)
            } else if permission == .notDetermined {
                Text("Requesting microphone & speech access…")
                    .font(.footnote)
                    .foregroundStyle(PhrenTheme.textMuted)
            } else {
                Text(text.isEmpty ? "Tap to start dictating" : "Tap to keep dictating")
                    .font(.footnote)
                    .foregroundStyle(PhrenTheme.textMuted)
            }
        }
    }

    private var permissionDeniedGuidance: some View {
        VStack(spacing: 12) {
            Image(systemName: "mic.slash.fill")
                .font(.system(size: 40))
                .foregroundStyle(PhrenTheme.textMuted)
            Text("Microphone & speech access needed")
                .font(.headline)
                .foregroundStyle(PhrenTheme.text)
            Text("Phren dictates notes on this device. Allow microphone and speech recognition access in Settings to use voice capture — you can still type below in the meantime.")
                .font(.footnote)
                .foregroundStyle(PhrenTheme.textMuted)
                .multilineTextAlignment(.center)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("Open Settings", systemImage: "gearshape")
            }
            .buttonStyle(.borderedProminent).tint(PhrenTheme.accentSolid)
        }
        .padding(.vertical, 8)
    }

    // MARK: - Editor + destination

    private var editorSection: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .font(.body)
                .foregroundStyle(PhrenTheme.text)
                .scrollContentBackground(.hidden)
                .padding(8)
                .frame(minHeight: 140, maxHeight: .infinity)
                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(PhrenTheme.border, lineWidth: 1))

            if text.isEmpty {
                Text("Your dictation appears here — edit freely, or type.")
                    .font(.body)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 16)
                    .allowsHitTesting(false)
            }
        }
    }

    @ViewBuilder
    private var destinationFooter: some View {
        if targets.count > 1 {
            VStack(alignment: .leading, spacing: 4) {
                PhrenSingleSelect(options: targetOptions, selection: $selectedTarget,
                                  placeholder: "Choose a project…", identifier: "voice-capture-project",
                                  isPresented: $showingTarget)

                if selectedTarget == nil {
                    Text("Pick where this goes — phren won't choose for you. Set a default in Settings → Quick capture.")
                        .font(.footnote)
                        .foregroundStyle(PhrenTheme.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let only = targets.first {
            Text("Saving to \(targetLabel(only))")
                .font(.footnote)
                .foregroundStyle(PhrenTheme.textMuted)
        }
    }

    private func targetLabel(_ target: VoiceCaptureTarget) -> String {
        model.hasMultipleStores ? "\(target.project) · \(target.storeName)" : target.project
    }

    /// A real, visible "nothing picked yet" row: with several projects, a
    /// preselected one the user didn't choose is how a capture lands
    /// somewhere nobody can name later.
    private var targetOptions: [PhrenOption<VoiceCaptureTarget?>] {
        [PhrenOption(id: "none", value: VoiceCaptureTarget?.none, title: "Choose a project…")]
            + targets.map { PhrenOption(id: $0.id, value: VoiceCaptureTarget?.some($0), title: targetLabel($0)) }
    }

    // MARK: - Recording

    private func toggleRecording() {
        if transcriber.isRecording {
            transcriber.stop()
        } else {
            let draft = $text
            transcriber.readDraft = { draft.wrappedValue }
            transcriber.onDraftChange = { draft.wrappedValue = $0 }
            transcriber.start(draft: text)
            recordingStartedAt = .now
            now = .now
        }
    }

    private func preparePermissions() async {
        let current = SpeechTranscriber.currentPermissionState()
        permission = current == .notDetermined ? await SpeechTranscriber.requestPermissions() : current
        recognizerUnavailable = !transcriber.isRecognizerAvailable
    }

    private var elapsedText: String {
        guard let start = recordingStartedAt else { return "0:00" }
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// Same precedence the App Intents path uses, plus the one tier a visible
    /// sheet can safely add: the configured default, then the last project
    /// anything was captured into — and then *nothing*. With several writable
    /// projects the sheet opens unset rather than pointing at whichever one
    /// sorts first; the only case that preselects on its own is a single
    /// writable project, where the footer names it in place of the picker.
    private static func defaultTarget(in targets: [VoiceCaptureTarget]) -> VoiceCaptureTarget? {
        if let preferred = QuickCaptureDefault.load(),
           let match = targets.first(where: { $0.storeId == preferred.storeId && $0.project == preferred.project }) {
            return match
        }
        if let last = VoiceCaptureLastTarget.load(),
           let match = targets.first(where: { $0.storeId == last.storeId && $0.project == last.project }) {
            return match
        }
        return targets.count == 1 ? targets.first : nil
    }

    // MARK: - Dismiss / save

    private var hasUnsavedText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSave: Bool {
        hasUnsavedText && selectedTarget != nil
    }

    private func attemptDismiss() {
        if hasUnsavedText {
            confirmDiscard = true
        } else {
            dismiss()
        }
    }

    private func save() {
        guard let target = selectedTarget else { return }
        transcriber.stop()
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }

        saving = true

        let op: PendingOp
        switch kind {
        case .note:
            let timestamp = AppModel.nowNoteTimestamp()
            op = .addNote(project: target.project, date: timestamp.date, time: timestamp.time, text: value)
        case .task:
            op = .addTask(project: target.project, text: value)
        }

        Task { @MainActor in
            await model.perform(op, in: target.storeId)
            // `perform` clears lastActionError on success and parks the reason
            // there otherwise — the banner behind this sheet shows it. Only a
            // write that was actually accepted gets remembered or logged.
            let accepted = model.lastActionError == nil
            if accepted {
                VoiceCaptureLastTarget.save(storeId: target.storeId, project: target.project)
                CaptureLog.record(
                    kind: kind == .note ? .note : .task,
                    storeId: target.storeId,
                    project: target.project,
                    text: value,
                    source: .app
                )
            }
            UINotificationFeedbackGenerator().notificationOccurred(accepted ? .success : .error)
            dismiss()
        }
    }
}
