import PhrenKit
import PhrenLive
import SwiftUI
import ImageIO

/// Files the phone has put on a computer through Phren Hook. Upload from
/// Files or Photos, then copy the path to hand it to an agent.
struct HostFilesView: View {
    var hostID: UUID? = nil
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var refresh = UUID()
    /// Presented from the list, not a Section: a Section's own modifiers are
    /// not a view in the list, so its cover never appeared.
    @State private var preview: FileViewerItem?
    private var hosts: [LiveHost] {
        (preferencesStore.preferences?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }
    var body: some View {
        PhrenList {
            if hosts.isEmpty { Text("Add a computer in Agents to put files on it.").foregroundStyle(PhrenTheme.textMuted) }
            ForEach(hosts) { host in HostFilesSection(host: host, refresh: refresh, preview: $preview) }
        }
        .fullScreenCover(item: $preview) { FileViewer(item: $0) }
        .navigationTitle("Files").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .refreshable { refresh = UUID() }
    }
}

private struct HostFilesSection: View {
    let host: LiveHost
    let refresh: UUID
    @State private var files: [HostFile]?
    @State private var error: String?
    @State private var importing = false
    @State private var busy = false
    @State private var copied: String?
    @Binding var preview: FileViewerItem?
    var body: some View {
        Section {
            Button { importing = true } label: { Label(busy ? "Uploading…" : "Upload a file to \(host.name)", systemImage: "square.and.arrow.up") }
                .disabled(busy).accessibilityIdentifier("files-upload:\(host.id.uuidString)")
            if let files {
                if files.isEmpty { Text("Nothing uploaded yet.").foregroundStyle(PhrenTheme.textMuted) }
                ForEach(files) { file in
                    HStack {
                        HostFileThumbnail(host: host, file: file)
                        Button {
                            preview = FileViewerItem(host: host, file: RemoteFile(path: file.path, uploads: true))
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.name).foregroundStyle(PhrenTheme.text).lineLimit(1)
                                    Text("\(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)) · \(file.path)")
                                        .font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").foregroundStyle(PhrenTheme.textMuted)
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("files-row:\(file.name)")
                        PhrenIconButton(icon: copied == file.id ? "checkmark" : "doc.on.doc", label: "Copy file path") {
                            UIPasteboard.general.string = file.path; copied = file.id
                        }.phrenIdentifier("files-copy:\(file.name)")
                    }
                }
            } else if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            else { ProgressView("Asking \(host.name)…") }
        } header: { Text(host.name) } footer: { Text("Tap a file to open it. Use Copy to hand its path to an agent. Uploads are cleared after two weeks.") }
        .task(id: refresh) { await load() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            busy = true
            Task {
                defer { busy = false }
                do {
                    for url in urls.prefix(ChatAttachmentLimit.maximum) {
                        let attachment = try await Task.detached(priority: .userInitiated) { try ChatAttachmentPreparation.file(url) }.value
                        _ = try await PhrenConnection.uploadFile(host: host, privateKey: DeviceSSHKey.load(host.id), name: attachment.uploadName, data: attachment.data)
                    }
                    await load()
                } catch { self.error = error.localizedDescription }
            }
        }
    }
    private func load() async {
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { files = FileViewerFixture.hostFiles; return }
            #endif
            files = try await PhrenConnection.files(host: host, privateKey: DeviceSSHKey.load(host.id)); error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct HostFileThumbnail: View {
    let host: LiveHost
    let file: HostFile
    @State private var image: UIImage?
    private var cacheKey: String { "\(host.id)/\(file.path)" }
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { PhrenFileTypeIcon(path: file.name) }
        }.frame(width: 44, height: 44).clipped()
            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 8))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityHidden(true)
            .task(id: file.path) {
                guard ["png", "jpg", "jpeg", "gif", "webp"].contains((file.name as NSString).pathExtension.lowercased()), file.size <= 8_388_608 else { return }
                if let cached = ImageRasterCache.image(for: cacheKey) { image = cached; return }
                guard let bytes = try? await PhrenConnection.uploadedImage(host: host, privateKey: DeviceSSHKey.load(host.id), path: file.path), !Task.isCancelled else { return }
                let decoded = await Task.detached(priority: .userInitiated) {
                    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                          let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceShouldCacheImmediately: true,
                            kCGImageSourceThumbnailMaxPixelSize: 132,
                          ] as CFDictionary) else { return UIImage?.none }
                    return UIImage(cgImage: thumbnail).preparingForDisplay()
                }.value
                guard !Task.isCancelled, let decoded else { return }
                ImageRasterCache.store(decoded, for: cacheKey)
                image = decoded
            }
    }
}
