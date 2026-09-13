import CoreText
import SwiftUI
import UniformTypeIdentifiers

/// The terminal's typeface: the system monospace by default, a curated font
/// fetched on demand, or one imported from Files. Font files live in
/// Application Support/Fonts and are registered with CoreText at launch, so
/// the same renderer the terminal uses draws them.
@Observable @MainActor
final class TerminalFonts {
    static let shared = TerminalFonts()
    static let sizeKey = "terminal.textSize.v1"
    static let familyKey = "terminal.fontFile.v1"
    static let changed = Notification.Name("phren.terminalFontChanged")

    struct Curated: Identifiable {
        let name: String
        let file: String
        let url: URL
        let detail: String
        var id: String { file }
    }
    /// Open-licence monospace fonts served straight from their repositories.
    static let curated: [Curated] = [
        .init(name: "JetBrains Mono", file: "JetBrainsMono-Regular.ttf", url: URL(string: "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/JetBrainsMono-Regular.ttf")!, detail: "Ligatures for code · OFL"),
        .init(name: "Fira Code", file: "FiraCode-Regular.ttf", url: URL(string: "https://raw.githubusercontent.com/tonsky/FiraCode/master/distr/ttf/FiraCode-Regular.ttf")!, detail: "Ligatures for code · OFL"),
        .init(name: "Hack", file: "Hack-Regular.ttf", url: URL(string: "https://raw.githubusercontent.com/source-foundry/Hack/master/build/ttf/Hack-Regular.ttf")!, detail: "Based on DejaVu · MIT"),
    ]

    struct Installed: Identifiable, Equatable {
        let file: String
        let postScriptName: String
        let displayName: String
        var id: String { file }
    }
    private(set) var installed: [Installed] = []
    private(set) var downloading: Set<String> = []
    var error: String?

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appending(path: "Fonts", directoryHint: .isDirectory)
    }
    /// The chosen font file, "" for the system monospace.
    var selectedFile: String {
        get { AppRuntime.defaults.string(forKey: Self.familyKey) ?? "" }
        set { AppRuntime.defaults.set(newValue, forKey: Self.familyKey); NotificationCenter.default.post(name: Self.changed, object: nil) }
    }
    var selectedName: String { installed.first { $0.file == selectedFile }?.displayName ?? "System monospace" }

    private init() { registerAll() }

    /// Registers every file in the folder and lists what is usable.
    func registerAll() {
        let directory = Self.directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let files = ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { ["ttf", "otf", "ttc", "otc"].contains($0.pathExtension.lowercased()) }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        var list: [Installed] = []
        for url in files {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor], let first = descriptors.first,
                  let postScript = CTFontDescriptorCopyAttribute(first, kCTFontNameAttribute) as? String else { continue }
            let display = (CTFontDescriptorCopyAttribute(first, kCTFontFamilyNameAttribute) as? String) ?? postScript
            list.append(.init(file: url.lastPathComponent, postScriptName: postScript, displayName: display))
        }
        installed = list
        if !selectedFile.isEmpty, !list.contains(where: { $0.file == selectedFile }) { selectedFile = "" }
    }

    /// The terminal font at `size` — the chosen family, or the system's.
    static func font(size: CGFloat) -> UIFont {
        let file = AppRuntime.defaults.string(forKey: familyKey) ?? ""
        if !file.isEmpty, let name = shared.installed.first(where: { $0.file == file })?.postScriptName, let font = UIFont(name: name, size: size) { return font }
        return .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    func download(_ font: Curated) async {
        guard !downloading.contains(font.file) else { return }
        downloading.insert(font.file); error = nil
        defer { downloading.remove(font.file) }
        do {
            let (data, response) = try await URLSession.shared.data(from: font.url)
            guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true, data.count > 10_000, data.count < 20_000_000 else {
                throw URLError(.badServerResponse)
            }
            try data.write(to: Self.directory.appending(path: font.file), options: .atomic)
            registerAll(); selectedFile = font.file
        } catch { self.error = "Couldn't download \(font.name): \(error.localizedDescription)" }
    }

    /// A font the user picked in Files, copied in and registered.
    func importFont(from url: URL) {
        error = nil
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let destination = Self.directory.appending(path: url.lastPathComponent)
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: url, to: destination)
            registerAll()
            guard installed.contains(where: { $0.file == url.lastPathComponent }) else {
                try? FileManager.default.removeItem(at: destination); registerAll()
                throw CocoaError(.fileReadCorruptFile)
            }
            selectedFile = url.lastPathComponent
        } catch { self.error = "Couldn't import \(url.lastPathComponent): the file is not a font this iPhone can read." }
    }

    func remove(_ font: Installed) {
        try? FileManager.default.removeItem(at: Self.directory.appending(path: font.file))
        registerAll()
    }
}

struct TerminalFontSettingsView: View {
    @State private var fonts = TerminalFonts.shared
    @AppStorage(TerminalFonts.sizeKey) private var size = 12.0
    @State private var importing = false

    var body: some View {
        PhrenList {
            Section("Terminal text") {
                HStack {
                    Label("Font size", systemImage: "textformat.size")
                    Spacer()
                    Stepper("\(Int(size.rounded()))pt", value: $size, in: 6...24, step: 1)
                        .frame(maxWidth: 170).accessibilityIdentifier("font-size-stepper")
                }
                Text("Sample: fn main() { let x = 0; } → ≠ ~")
                    .font(Font(TerminalFonts.font(size: max(6, size)))).foregroundStyle(PhrenTheme.text)
                    .lineLimit(1).minimumScaleFactor(0.6).accessibilityIdentifier("font-sample")
            }
            Section {
                fontRow(name: "System monospace", detail: "SF Mono, always available", file: "")
                ForEach(fonts.installed) { font in
                    fontRow(name: font.displayName, detail: font.file, file: font.file)
                        .swipeActions { Button("Remove", role: .destructive) { fonts.remove(font) } }
                }
            } header: { Text("Terminal fonts") } footer: { Text("Pinch the terminal to change the size too. The chosen font is also used for code in chat.") }
            Section {
                ForEach(TerminalFonts.curated.filter { curated in !fonts.installed.contains { $0.file == curated.file } }) { font in
                    Button {
                        Task { await fonts.download(font) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(font.name).foregroundStyle(PhrenTheme.text)
                                Text("Download on demand · \(font.detail)").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                            Spacer()
                            if fonts.downloading.contains(font.file) { ProgressView() } else { Image(systemName: "arrow.down.circle").foregroundStyle(PhrenTheme.accent) }
                        }
                    }.accessibilityIdentifier("font-download:\(font.file)")
                }
                Button {
                    importing = true
                } label: {
                    Label { VStack(alignment: .leading, spacing: 2) { Text("Import font…"); Text(".ttf, .otf, .ttc or .otc from Files").font(.caption).foregroundStyle(PhrenTheme.textMuted) } }
                        icon: { Image(systemName: "square.and.arrow.down") }
                }.accessibilityIdentifier("font-import")
                if let error = fonts.error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            } header: { Text("More fonts") } footer: {
                Text("Downloaded and imported fonts are stored inside Phren and registered with the same renderer the terminal uses. Nothing is sent anywhere.")
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.font, UTType(filenameExtension: "ttf") ?? .font, UTType(filenameExtension: "otf") ?? .font]) { result in
            if case .success(let url) = result { fonts.importFont(from: url) }
        }
        .navigationTitle("Fonts & Size").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }

    private func fontRow(name: String, detail: String, file: String) -> some View {
        Button { fonts.selectedFile = file } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(PhrenTheme.text)
                    Text(detail).font(.caption).foregroundStyle(PhrenTheme.textMuted)
                }
                Spacer()
                if fonts.selectedFile == file { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.accent) }
            }
        }.accessibilityIdentifier("font-choice:\(file.isEmpty ? "system" : file)")
    }
}
