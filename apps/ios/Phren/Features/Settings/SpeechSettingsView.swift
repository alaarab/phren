import Speech
import SwiftUI

/// Dictation: the language, a place to try it, and word replacements for the
/// names the recogniser keeps getting wrong. Recognition stays on the phone.
enum SpeechSettings {
    static let localeKey = "speech.locale.v1"              // "" = the phone's language
    static let replacementsKey = "speech.replacements.v1"  // JSON [[from, to]]
    static let cleanupKey = "speech.apple-intelligence-cleanup.v1"

    static func cleanupEnabled(in defaults: UserDefaults = AppRuntime.defaults) -> Bool {
        defaults.bool(forKey: cleanupKey)
    }

    static var locale: Locale {
        let id = AppRuntime.defaults.string(forKey: localeKey) ?? ""
        return id.isEmpty ? .current : Locale(identifier: id)
    }
    static var replacements: [(from: String, to: String)] {
        get {
            guard let data = AppRuntime.defaults.data(forKey: replacementsKey), let rows = try? JSONDecoder().decode([[String]].self, from: data) else { return [] }
            return rows.compactMap { $0.count == 2 && !$0[0].isEmpty ? (from: $0[0], to: $0[1]) : nil }
        }
        set { AppRuntime.defaults.set(try? JSONEncoder().encode(newValue.map { [$0.from, $0.to] }), forKey: replacementsKey) }
    }
    /// The transcript with every replacement applied, whole words only, case-insensitive.
    static func apply(_ text: String) -> String {
        replacements.reduce(text) { result, pair in
            let pattern = "(?<![\\p{L}\\p{N}])" + NSRegularExpression.escapedPattern(for: pair.from) + "(?![\\p{L}\\p{N}])"
            guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return result }
            return regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: NSRegularExpression.escapedTemplate(for: pair.to))
        }
    }
}

struct SpeechSettingsView: View {
    @AppStorage(SpeechSettings.localeKey) private var localeID = ""
    @AppStorage(SpeechSettings.cleanupKey) private var cleanup = false
    @State private var replacements = SpeechSettings.replacements
    @State private var newFrom = ""
    @State private var newTo = ""
    @State private var testing = false
    private var locales: [Locale] {
        SFSpeechRecognizer.supportedLocales().sorted { ($0.localizedString(forIdentifier: $0.identifier) ?? $0.identifier) < ($1.localizedString(forIdentifier: $1.identifier) ?? $1.identifier) }
    }

    var body: some View {
        PhrenList {
            Section {
                Button { testing = true } label: { Label("Tap to try a test transcription", systemImage: "mic.circle.fill") }
                    .accessibilityIdentifier("speech-test")
            } footer: { Text("Recognition runs on the phone with Apple's speech engine. Nothing leaves the device.") }
            Section("Language") {
                Picker(selection: $localeID) {
                    Text("Automatic (\(Locale.current.localizedString(forIdentifier: Locale.current.identifier) ?? "phone language"))").tag("")
                    ForEach(locales, id: \.identifier) { locale in
                        Text(locale.localizedString(forIdentifier: locale.identifier) ?? locale.identifier).tag(locale.identifier)
                    }
                } label: { Label("Language", systemImage: "globe") }
                    .accessibilityIdentifier("speech-language")
            }
            Section {
                PhrenSwitch(isOn: $cleanup) {
                    Label {
                        Text("Tighten agent dictation")
                        Text("Preview an on-device Apple Intelligence rewrite before using it")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    } icon: { Image(systemName: "apple.intelligence") }
                }
                .accessibilityIdentifier("speech-dictation-cleanup")
            } footer: {
                Text("When Apple Intelligence is available, Phren can clarify punctuation and sequential requests. You choose the original or tightened wording before it is sent.")
            }
            Section {
                ForEach(Array(replacements.enumerated()), id: \.offset) { index, pair in
                    HStack { Text(pair.from); Image(systemName: "arrow.right").font(.caption).foregroundStyle(PhrenTheme.textMuted); Text(pair.to).foregroundStyle(PhrenTheme.accent) }
                        .accessibilityIdentifier("speech-replacement:\(index)")
                }
                .onDelete { offsets in replacements.remove(atOffsets: offsets); SpeechSettings.replacements = replacements }
                HStack {
                    TextField("Heard", text: $newFrom).accessibilityIdentifier("speech-replacement-from")
                    Image(systemName: "arrow.right").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    TextField("Meant", text: $newTo).accessibilityIdentifier("speech-replacement-to")
                    Button("Add") {
                        replacements.append((from: newFrom.trimmingCharacters(in: .whitespaces), to: newTo.trimmingCharacters(in: .whitespaces)))
                        SpeechSettings.replacements = replacements; newFrom = ""; newTo = ""
                    }.disabled(newFrom.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityIdentifier("speech-replacement-add")
                }
            } header: { Text("Word replacements") } footer: { Text("Fix words the engine hears wrong — \"fren\" → \"phren\". Applied to every dictation, whole words only.") }
        }
        .sheet(isPresented: $testing) {
            ChatDictationView { _ in }
        }
        .navigationTitle("Speech").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}
