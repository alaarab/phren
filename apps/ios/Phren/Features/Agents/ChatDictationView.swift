import SwiftUI

struct ChatDictationView: View {
    let insert: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var transcriber = SpeechTranscriber()
    @State private var text = ""
    @State private var prefix = ""
    @State private var error: String?
    @State private var starting = false
    @State private var permissionTask: Task<Void, Never>?
    var body: some View {
        NavigationStack {
            PhrenForm {
                Section {
                    TextEditor(text: $text).frame(minHeight: 180).disabled(transcriber.isRecording)
                        .accessibilityLabel("Dictated message")
                    Button(transcriber.isRecording ? "Stop dictation" : "Start dictation", systemImage: transcriber.isRecording ? "stop.circle" : "mic") {
                        if transcriber.isRecording { transcriber.stop() }
                        else {
                            starting = true
                            permissionTask = Task {
                                defer { starting = false }
                                guard await SpeechTranscriber.requestPermissions() == .authorized else {
                                    error = "Allow microphone and speech recognition in iPhone Settings to dictate."; return
                                }
                                guard !Task.isCancelled, phase == .active else { return }
                                prefix = text + (text.isEmpty ? "" : " ")
                                do { try transcriber.start(); error = nil } catch { self.error = error.localizedDescription }
                            }
                        }
                    }.disabled(starting)
                } footer: { Text("Review your words before adding them to the message. Dictation uses on-device recognition when available.") }
                if let error { Text(error).foregroundStyle(PhrenTheme.warning) }
            }
            .navigationTitle("Dictate message").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add to draft") { transcriber.stop(); insert(SpeechSettings.apply(text)); dismiss() }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .onChange(of: transcriber.transcript) { _, value in if !value.isEmpty { text = prefix + value } }
        .onChange(of: phase) { _, phase in if phase != .active { transcriber.stop() } }
        .onDisappear { permissionTask?.cancel(); transcriber.stop() }
    }
}
