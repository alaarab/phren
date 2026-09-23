import CryptoKit
import PhrenKit
import PhrenLive
import SwiftUI
import UniformTypeIdentifiers

struct FileViewerItem: Identifiable {
    let name: String
    private let localID = UUID().uuidString
    var host: LiveHost?
    var remote: RemoteFile?
    var local: URL?
    var previewKind: FilePreviewKind?
    var load: (() async throws -> Data)?
    var id: String { (host.map { $0.id.uuidString } ?? "local") + "/" + (remote?.cacheIdentity ?? local?.path ?? localID) }

    init(host: LiveHost, file: RemoteFile) {
        name = (file.path as NSString).lastPathComponent; self.host = host; remote = file
    }
    init(name: String, local: URL) { self.name = name; self.local = local }
    init(name: String, load: @escaping () async throws -> Data) { self.name = name; self.load = load }
}

@MainActor @Observable final class FileViewerDownload {
    var received: Int64 = 0
    var total: Int64 = 0
    var url: URL?
    var contentType: String?
    var error: String?
    var paused = false
    var resumeOnForeground = false
    var running = false
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private static var assemblies: [URL: FileChunkAssembly] = [:]

    func pause(resumeWhenActive: Bool = false) {
        guard running else { return }
        resumeOnForeground = resumeWhenActive
        generation = UUID(); task?.cancel(); task = nil; running = false; paused = true
    }
    func start(_ item: FileViewerItem) {
        guard !running, url == nil else { return }
        let ticket = UUID(); generation = ticket
        paused = false; resumeOnForeground = false; error = nil; running = true
        task = Task {
            defer { if generation == ticket { running = false; task = nil } }
            do {
                if let local = item.local { url = local; return }
                let directory = try Self.directory(item)
                if let load = item.load {
                    let data = try await load()
                    try Task.checkCancellation()
                    let file = directory.appendingPathComponent(Self.safeName(item.name))
                    try await Task.detached { try data.write(to: file, options: .atomic) }.value
                    try Task.checkCancellation()
                    url = file; return
                }
                guard let host = item.host, let remote = item.remote else { return }
                #if DEBUG && targetEnvironment(simulator)
                if FileViewerFixture.enabled {
                    let file = try await FileViewerFixture.file(named: item.name)
                    try Task.checkCancellation(); url = file; return
                }
                #endif
                let key = try DeviceSSHKey.load(host.id)
                let info = try await PhrenConnection.fileRange(host: host, privateKey: key, file: remote, length: 0)
                try Task.checkCancellation()
                contentType = info.contentType; total = info.total
                let assembly = Self.assemblies[directory] ?? FileChunkAssembly(directory: directory, name: Self.safeName(item.name))
                Self.assemblies[directory] = assembly
                let resumed = try await assembly.prepare(info)
                try Task.checkCancellation()
                received = resumed
                while received < total {
                    try Task.checkCancellation()
                    let chunk = try await PhrenConnection.fileRange(host: host, privateKey: key, file: remote,
                        offset: received, version: info.version)
                    try Task.checkCancellation()
                    let assembled = try await assembly.append(chunk)
                    try Task.checkCancellation()
                    received = assembled
                }
                try Task.checkCancellation()
                url = assembly.file
            } catch {
                if generation == ticket, !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
    private static func safeName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
        return last.isEmpty || last == "." || last == ".." || last == ".download.json" ? "file" : last
    }
    private static func directory(_ item: FileViewerItem) throws -> URL {
        let identity = item.id
        let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let base = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("file-viewer").appendingPathComponent(key)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// Every computer file uses this entry point, including image attachments.
struct FileViewer: View {
    let item: FileViewerItem
    var actions: [PhrenControlAction] = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var download = FileViewerDownload()
    @State private var fullscreen = false
    @State private var sharing = false
    @State private var saving = false
    @State private var showingActions = false

    init(item: FileViewerItem, actions: [PhrenControlAction] = []) { self.item = item; self.actions = actions }
    init(attachment: AgentAttachment) {
        var source = FileViewerItem(name: attachment.name) { ImageViewerOriginals.data(for: attachment) }
        if attachment.isImage { source.previewKind = .image }
        item = source
    }
    static func kind(name: String, contentType: String?) -> FilePreviewKind {
        FilePreviewKind.detect(name: name, contentType: contentType)
    }
    var body: some View {
        VStack(spacing: 0) {
            if !fullscreen { header }
            if let url = download.url {
                content(url: url)
            } else { progress }
        }
        .background(PhrenTheme.bg.ignoresSafeArea())
        .foregroundStyle(PhrenTheme.text)
        .toolbar(.hidden, for: .navigationBar)
        .presentationDragIndicator(.hidden)
        .onAppear { download.start(item) }
        .onDisappear { download.pause() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { download.pause(resumeWhenActive: true) }
            else if phase == .active, download.paused, download.resumeOnForeground { download.start(item) }
        }
        .phrenActionSheet(isPresented: $showingActions, title: "File actions", actions: actions, identifier: "file-actions-sheet")
        .sheet(isPresented: $sharing) {
            if let url = download.url { FileShareView(url: url).presentationDragIndicator(.hidden) }
        }
        .sheet(isPresented: $saving) {
            if let url = download.url { FileSaveView(url: url).presentationDragIndicator(.hidden) }
        }
    }
    private var header: some View {
        HStack(spacing: 4) {
            Text(item.name).font(PhrenTypography.subheadline.weight(.semibold))
                .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            if !actions.isEmpty {
                PhrenIconButton(icon: "ellipsis", label: "File actions") { showingActions = true }.phrenIdentifier("file-actions")
            }
            if download.url != nil {
                PhrenIconButton(icon: "square.and.arrow.down", label: "Save to Files") { saving = true }
                    .phrenIdentifier("file-viewer-save")
                PhrenIconButton(icon: "square.and.arrow.up", label: "Share file") { sharing = true }
                    .phrenIdentifier("file-viewer-share")
            }
            PhrenIconButton(icon: "xmark", label: "Close file") { download.pause(); dismiss() }
                .phrenIdentifier("file-viewer-close")
        }.padding(.leading, 16).padding(.trailing, 6).frame(minHeight: 56).background(PhrenTheme.surface)
    }
    private var progress: some View {
        VStack(spacing: 16) {
            PhrenFileTypeIcon(path: item.name)
            Text(download.error ?? (download.paused ? "Download paused" : "Downloading file…"))
                .font(PhrenTypography.body).multilineTextAlignment(.center)
            FileProgressBar(value: download.total > 0 ? Double(download.received) / Double(download.total) : 0)
                .frame(height: 6).phrenIdentifier("file-download-progress")
                .accessibilityLabel("Download progress")
                .accessibilityValue("\(download.received) of \(download.total) bytes")
            Text("\(ByteCountFormatter.string(fromByteCount: download.received, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: download.total, countStyle: .file))")
                .font(PhrenTypography.monoCaption).foregroundStyle(PhrenTheme.textMuted)
            Button { if download.running { download.pause() } else { download.start(item) } } label: {
                PhrenRow(icon: download.running ? "xmark" : "arrow.down", title: download.running ? "Cancel download" : "Resume download", chevron: false)
            }.buttonStyle(.plain).phrenIdentifier("file-download-toggle")
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    @ViewBuilder private func content(url: URL) -> some View {
        let kind = item.previewKind ?? Self.kind(name: item.name, contentType: download.contentType)
        switch kind {
        case .video, .audio:
            FileMediaView(url: url, audio: kind == .audio, fullscreen: $fullscreen)
        case .pdf:
            FilePDFView(url: url)
        case .image:
            PhrenImageViewer(name: item.name, showsHeader: false) {
                try await Task.detached { try Data(contentsOf: url, options: .mappedIfSafe) }.value
            }
        case .markdown, .code, .json, .csv, .text:
            FileTextView(url: url, kind: kind)
        case .file:
            VStack(spacing: 16) {
                PhrenFileTypeIcon(path: item.name)
                Text(item.name).font(PhrenTypography.body)
                Text(download.contentType ?? "File").foregroundStyle(PhrenTheme.textMuted)
                Button { saving = true } label: { PhrenRow(icon: "square.and.arrow.down", title: "Save to Files", chevron: false) }
                    .buttonStyle(.plain)
                Button { sharing = true } label: { PhrenRow(icon: "square.and.arrow.up", title: "Share", chevron: false) }
                    .buttonStyle(.plain)
            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).phrenContainerMarker("file-viewer-file", label: "File")
        }
    }
}

struct FileProgressBar: View {
    var value: Double
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(PhrenTheme.surfaceRaised)
                Capsule().fill(PhrenTheme.accent).frame(width: geometry.size.width * min(1, max(0, value)))
            }
        }
    }
}

// The OS receives a file only after an explicit phren Save or Share action.
// These are system destinations, not toolbars for the viewer itself.
private struct FileShareView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
private struct FileSaveView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController { UIDocumentPickerViewController(forExporting: [url], asCopy: true) }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
}
