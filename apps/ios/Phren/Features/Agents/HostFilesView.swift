import PhrenKit
import PhrenLive
import SwiftUI
import ImageIO

/// Files the phone has put on a computer through Phren Hook — upload from
/// Files or Photos, then copy the path to hand it to an agent.
struct HostFilesView: View {
    var hostID: UUID? = nil
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @State private var refresh = UUID()
    private var hosts: [LiveHost] {
        ((try? LiveSessionPreferences.read(data))?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }
    var body: some View {
        PhrenList {
            if hosts.isEmpty { Text("Add a computer in Agents to put files on it.").foregroundStyle(PhrenTheme.textMuted) }
            ForEach(hosts) { host in HostFilesSection(host: host, refresh: refresh) }
        }
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
    var body: some View {
        Section {
            Button { importing = true } label: { Label(busy ? "Uploading…" : "Upload a file to \(host.name)", systemImage: "square.and.arrow.up") }
                .disabled(busy).accessibilityIdentifier("files-upload:\(host.id.uuidString)")
            if let files {
                if files.isEmpty { Text("Nothing uploaded yet.").foregroundStyle(PhrenTheme.textMuted) }
                ForEach(files) { file in
                    Button {
                        UIPasteboard.general.string = file.path; copied = file.id
                    } label: {
                        HStack {
                            HostFileThumbnail(host: host, file: file)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(file.name).foregroundStyle(PhrenTheme.text).lineLimit(1)
                                Text("\(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)) · \(file.path)")
                                    .font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1).truncationMode(.middle)
                            }
                            Spacer()
                            Image(systemName: copied == file.id ? "checkmark" : "doc.on.doc").foregroundStyle(copied == file.id ? PhrenTheme.success : PhrenTheme.textMuted)
                        }
                    }.accessibilityIdentifier("files-row:\(file.name)")
                }
            } else if let error { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            else { ProgressView("Asking \(host.name)…") }
        } header: { Text(host.name) } footer: { Text("Tap a file to copy its path on the computer. Uploads live under ~/.local/share/phren/bridge/uploads/files and are cleared after two weeks.") }
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
            if AgentChatFixture.enabled { files = [HostFile(name: "design.pdf", path: "/Users/fixture/.local/share/phren/bridge/uploads/files/design.pdf", size: 120_000, modified: "2026-09-13T10:00:00Z")]; return }
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
