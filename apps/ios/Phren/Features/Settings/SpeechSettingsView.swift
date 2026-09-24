import PhrenKit
import Speech
import SwiftUI

/// Dictation: the language, a place to try it, and word replacements for the
/// names the recogniser keeps getting wrong. Recognition stays on the phone.
enum SpeechSettings {
    static let localeKey = "speech.locale.v1"              // "" = the phone's language
    static let replacementsKey = "speech.replacements.v1"  // JSON [[from, to]]
    static let cleanupKey = "speech.apple-intelligence-cleanup.v1"
    static let projectsKey = "speech.vocabulary.projects.v1"  // [String], from the stores

    static let micButtonKey = "voice.mic-button.v1"
    static let replyVoiceKey = "voice.reply-voice.v1"

    /// What the composer's mic does. Dictate writes into the message box and
    /// never sends; Talk starts talk mode.
    enum MicButton: String, CaseIterable { case dictate, talk }
    /// Who reads talk mode's replies: the computer's ElevenLabs voice, or
    /// Apple's best installed voice (also the fallback when the Mac can't).
    enum ReplyVoice: String, CaseIterable { case elevenLabs, apple }

    static let inputKey = "voice.input.v1"
    /// Who turns speech into words. Apple is built in; Whisper runs on the
    /// phone once its model is downloaded; Scribe runs through the computer.
    enum Input: String, CaseIterable { case apple, whisper, scribe }

    static func input(in defaults: UserDefaults = AppRuntime.defaults) -> Input {
        defaults.string(forKey: inputKey).flatMap(Input.init(rawValue:)) ?? .apple
    }

    /// Whisper's language: the chosen one's code, or nil to let it detect.
    static var whisperLanguage: String? {
        let id = AppRuntime.defaults.string(forKey: localeKey) ?? ""
        return id.isEmpty ? Locale.current.language.languageCode?.identifier : Locale(identifier: id).language.languageCode?.identifier
    }

    /// The recogniser for the chosen engine, falling back to Apple's
    /// silently when the choice can't run yet (Whisper still downloading).
    /// `host` is the computer the chat is on: Scribe runs through its Hook
    /// when that Hook offers it.
    @MainActor static func makeRecognizer(host: LiveHost? = nil, capabilities: LiveCapabilities? = nil) -> any DictationRecognizing {
        switch activeInput(capabilities: capabilities) {
        case .whisper: WhisperRecognizer()
        case .scribe: host.map { ScribeRecognizer(host: $0) } ?? SpeechTranscriber()
        case .apple: SpeechTranscriber()
        }
    }

    /// The engine that actually runs: the choice, or Apple while it can't
    /// (Whisper not downloaded, or a computer without Scribe).
    @MainActor static func activeInput(capabilities: LiveCapabilities? = nil) -> Input {
        switch input() {
        case .whisper where WhisperModelStore.shared.isReady: .whisper
        case .scribe where capabilities?.allows(.transcribe) == true: .scribe
        default: .apple
        }
    }

    static func micButton(in defaults: UserDefaults = AppRuntime.defaults) -> MicButton {
        defaults.string(forKey: micButtonKey).flatMap(MicButton.init(rawValue:)) ?? .dictate
    }
    static func replyVoice(in defaults: UserDefaults = AppRuntime.defaults) -> ReplyVoice {
        defaults.string(forKey: replyVoiceKey).flatMap(ReplyVoice.init(rawValue:)) ?? .elevenLabs
    }

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
    /// Words the recogniser should prefer over similar-sounding ones: the
    /// app's name, the stores' project names and every replacement target.
    static func vocabulary(in defaults: UserDefaults = AppRuntime.defaults) -> [String] {
        let projects = defaults.stringArray(forKey: projectsKey) ?? []
        let spoken = projects.flatMap { name in
            let words = name.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." }).map(String.init)
            return words.count > 1 ? [name, words.joined(separator: " ")] : [name]
        }
        var seen = Set<String>()
        return (["phren"] + spoken + replacements.map(\.to))
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }

    /// Called whenever the stores are read; the recogniser picks the names
    /// up at its next start.
    static func rememberProjects(_ names: [String], in defaults: UserDefaults = AppRuntime.defaults) {
        let sorted = Array(Set(names)).sorted()
        guard defaults.stringArray(forKey: projectsKey) != sorted else { return }
        defaults.set(sorted, forKey: projectsKey)
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
    @AppStorage(SpeechSettings.micButtonKey) private var micButton = SpeechSettings.MicButton.dictate.rawValue
    @AppStorage(SpeechSettings.replyVoiceKey) private var replyVoice = SpeechSettings.ReplyVoice.elevenLabs.rawValue
    @AppStorage(TalkPause.key) private var pause = TalkPause.normal.rawValue
    @AppStorage(SpeechSettings.inputKey) private var input = SpeechSettings.Input.apple.rawValue
    @State private var showingInput = false
    private var whisper: WhisperModelStore { .shared }
    private let inputOptions = [PhrenOption(id: "apple", value: "apple", title: "Apple · built in"),
                                PhrenOption(id: "whisper", value: "whisper", title: "Whisper · on the phone, \(WhisperModelStore.sizeLabel) download"),
                                PhrenOption(id: "scribe", value: "scribe", title: "ElevenLabs Scribe · through your computer, paid")]
    @State private var showingMic = false
    @State private var showingReply = false
    @State private var showingPause = false
    private let micOptions = [PhrenOption(id: "dictate", value: "dictate", title: "Dictate into the message"),
                              PhrenOption(id: "talk", value: "talk", title: "Talk with the agent")]
    private let replyOptions = [PhrenOption(id: "elevenLabs", value: "elevenLabs", title: "ElevenLabs, through your computer"),
                                PhrenOption(id: "apple", value: "apple", title: "Apple, on the phone")]
    private let pauseOptions = TalkPause.allCases.map { PhrenOption(id: $0.rawValue, value: $0.rawValue, title: $0.title) }
    @AppStorage(SpeechSettings.cleanupKey) private var cleanup = false
    @State private var replacements = SpeechSettings.replacements
    @State private var newFrom = ""
    @State private var newTo = ""
    @State private var testing = false
    @State private var showingLanguage = false
    private var locales: [Locale] {
        SFSpeechRecognizer.supportedLocales().sorted { ($0.localizedString(forIdentifier: $0.identifier) ?? $0.identifier) < ($1.localizedString(forIdentifier: $1.identifier) ?? $1.identifier) }
    }
    private var localeOptions: [PhrenOption<String>] {
        [PhrenOption(id: "automatic", value: "",
                     title: "Automatic (\(Locale.current.localizedString(forIdentifier: Locale.current.identifier) ?? "phone language"))")]
            + locales.map {
                PhrenOption(id: $0.identifier, value: $0.identifier,
                            title: $0.localizedString(forIdentifier: $0.identifier) ?? $0.identifier)
            }
    }

    /// Whisper's model: download it (Wi-Fi only), follow the download, or
    /// remove it to free the space.
    @ViewBuilder private var whisperRow: some View {
        switch whisper.state {
        case .absent:
            Button { whisper.download() } label: {
                Label("Download the Whisper model · \(WhisperModelStore.sizeLabel), Wi-Fi only", systemImage: "arrow.down.circle")
            }
            .accessibilityIdentifier("voice-whisper-download")
            Text("Using Apple until it's downloaded.").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                .accessibilityIdentifier("voice-fallback-note")
        case .downloading(let fraction):
            HStack {
                ProgressView(value: fraction).tint(PhrenTheme.accent)
                Text("\(Int(fraction * 100))%").font(.caption.monospacedDigit()).foregroundStyle(PhrenTheme.textMuted)
                Button("Cancel") { whisper.cancelDownload() }.font(.caption)
            }
            .accessibilityIdentifier("voice-whisper-progress")
            Text("Using Apple until it's downloaded.").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                .accessibilityIdentifier("voice-fallback-note")
        case .ready:
            HStack {
                Label("Whisper model downloaded · \(WhisperModelStore.sizeLabel)", systemImage: "checkmark.circle")
                    .foregroundStyle(PhrenTheme.text)
                Spacer()
                Button("Remove", role: .destructive) { whisper.remove() }.font(.caption)
                    .accessibilityIdentifier("voice-whisper-remove")
            }
        case .failed(let reason):
            Text(reason).font(.caption).foregroundStyle(PhrenTheme.warning)
            Button { whisper.download() } label: { Label("Try the download again", systemImage: "arrow.clockwise") }
                .accessibilityIdentifier("voice-whisper-download")
        }
    }

    var body: some View {
        PhrenList {
            Section {
                PhrenSingleSelect(options: inputOptions, selection: $input, placeholder: "Input",
                                  identifier: "voice-input", isPresented: $showingInput)
                if input == SpeechSettings.Input.whisper.rawValue { whisperRow }
                Button { testing = true } label: { Label("Tap to try a test transcription", systemImage: "mic.circle.fill") }
                    .accessibilityIdentifier("speech-test")
            } header: { Text("Input") } footer: {
                Text(input == SpeechSettings.Input.whisper.rawValue
                     ? "Whisper is better with technical words and stays on the phone. Until its model is downloaded, Apple's engine is used."
                     : input == SpeechSettings.Input.scribe.rawValue
                     ? "The most accurate. Your voice goes to ElevenLabs through the computer the chat is on, using its key; each use is billed to that account. Apple's engine is used when that computer can't."
                     : "Recognition runs on the phone with Apple's speech engine. Nothing leaves the device.")
            }
            Section {
                PhrenSingleSelect(options: micOptions, selection: $micButton, placeholder: "Mic button",
                                  identifier: "voice-mic-button", isPresented: $showingMic)
            } header: { Text("Mic button") } footer: {
                Text("Dictate puts your words in the message box and never sends on its own. Talk sends when you pause and reads the reply aloud; the talk button starts it either way.")
            }
            Section {
                PhrenSingleSelect(options: pauseOptions, selection: $pause, placeholder: "Auto-send pause",
                                  identifier: "voice-pause", isPresented: $showingPause)
            } header: { Text("Talk: send after a pause") } footer: {
                Text("A ring counts the pause down; tap it to hold while you think, tap again to send. Words that trail off (\"and\", \"so\", a comma) wait two seconds longer.")
            }
            Section {
                PhrenSingleSelect(options: replyOptions, selection: $replyVoice, placeholder: "Reply voice",
                                  identifier: "voice-reply", isPresented: $showingReply)
            } header: { Text("Talk: reply voice") } footer: {
                Text("ElevenLabs needs a key on your computer; Apple's voice takes over when it can't be reached.")
            }
            Section("Language") {
                PhrenSingleSelect(options: localeOptions, selection: $localeID,
                                  placeholder: "Language", identifier: "speech-language",
                                  isPresented: $showingLanguage)
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
                    PhrenTextField("Heard", text: $newFrom, identifier: "speech-replacement-from", surface: .bare)
                    Image(systemName: "arrow.right").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    PhrenTextField("Meant", text: $newTo, identifier: "speech-replacement-to", surface: .bare)
                    Button("Add") {
                        replacements.append((from: newFrom.trimmingCharacters(in: .whitespaces), to: newTo.trimmingCharacters(in: .whitespaces)))
                        SpeechSettings.replacements = replacements; newFrom = ""; newTo = ""
                    }.disabled(newFrom.trimmingCharacters(in: .whitespaces).isEmpty).accessibilityIdentifier("speech-replacement-add")
                }
            } header: { Text("Word replacements") } footer: { Text("Fix words the engine hears wrong: \"fren\" → \"phren\". Applied to every dictation, whole words only.") }
        }
        .sheet(isPresented: $testing) {
            ChatDictationView { _ in }
        }
        .phrenSingleSelectSheet(isPresented: $showingLanguage, title: "Language", options: localeOptions,
                                selection: $localeID, rowPrefix: "speech-language")
        .phrenSingleSelectSheet(isPresented: $showingInput, title: "Input", options: inputOptions,
                                selection: $input, rowPrefix: "voice-input")
        .phrenSingleSelectSheet(isPresented: $showingMic, title: "Mic button", options: micOptions,
                                selection: $micButton, rowPrefix: "voice-mic-button")
        .phrenSingleSelectSheet(isPresented: $showingPause, title: "Send after a pause", options: pauseOptions,
                                selection: $pause, rowPrefix: "voice-pause")
        .phrenSingleSelectSheet(isPresented: $showingReply, title: "Reply voice", options: replyOptions,
                                selection: $replyVoice, rowPrefix: "voice-reply")
        .navigationTitle("Voice").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}
