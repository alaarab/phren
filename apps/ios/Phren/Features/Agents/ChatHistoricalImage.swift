import ImageIO
import PhrenKit
import PhrenLive
import SwiftUI

@MainActor private enum TranscriptImageCache {
    final class Prepared: NSObject { let attachment: AgentAttachment; init(_ attachment: AgentAttachment) { self.attachment = attachment } }
    static let images: NSCache<NSString, Prepared> = {
        let cache = NSCache<NSString, Prepared>(); cache.totalCostLimit = 16_777_216; cache.countLimit = 16; return cache
    }()
}

/// Where a picture in the conversation lives on the computer.
enum ChatImageReference: Hashable {
    /// An image block inside a transcript row: a paste, or a Read of a screenshot.
    case transcript(line: Int, block: Int, inner: Int?)
    /// A picture the phone uploaded, which Claude Code's transcript names
    /// only by path; the Hook serves it back from its own uploads folder.
    case upload(path: String)
}

/// How a conversation image is drawn: as wide as its bubble or card, up to
/// 240pt tall; or as a thumbnail in the strip under a tool pill — 160pt
/// tall, as wide as that makes it, so several sit side by side.
enum ChatImageLayout { case inline, thumbnail }
private struct ChatImageLayoutKey: EnvironmentKey { static let defaultValue = ChatImageLayout.inline }
extension EnvironmentValues {
    var chatImageLayout: ChatImageLayout {
        get { self[ChatImageLayoutKey.self] } set { self[ChatImageLayoutKey.self] = newValue }
    }
}

struct ChatHistoricalImage: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let reference: ChatImageReference
    let active: Bool
    let preview: (ChatAttachmentDraft) -> Void
    @Environment(\.chatImageLayout) private var layout
    @State private var attachment: AgentAttachment?
    @State private var error: String?
    @State private var refresh = UUID()
    init(session: LiveAgentSession, target: AgentChatTarget, line: Int, block: Int, inner: Int? = nil, active: Bool, preview: @escaping (ChatAttachmentDraft) -> Void) {
        self.init(session: session, target: target, reference: .transcript(line: line, block: block, inner: inner), active: active, preview: preview)
    }
    init(session: LiveAgentSession, target: AgentChatTarget, upload path: String, active: Bool, preview: @escaping (ChatAttachmentDraft) -> Void) {
        self.init(session: session, target: target, reference: .upload(path: path), active: active, preview: preview)
    }
    init(session: LiveAgentSession, target: AgentChatTarget, reference: ChatImageReference, active: Bool, preview: @escaping (ChatAttachmentDraft) -> Void) {
        self.session = session; self.target = target; self.reference = reference; self.active = active; self.preview = preview
    }
    static let thumbnailHeight: CGFloat = 160
    var body: some View {
        Group {
            if let attachment {
                Button { preview(.init(attachment: attachment)) } label: {
                    sized(ChatAttachmentImage(attachment: attachment)).clipShape(RoundedRectangle(cornerRadius: 12))
                }.accessibilityLabel("View conversation image")
            } else if let error {
                Button { refresh = UUID() } label: { sized(Label(error, systemImage: "arrow.clockwise").font(.caption)) }
            } else { sized(ProgressView("Loading image…").font(.caption).frame(minHeight: 80)) }
        }
        .accessibilityIdentifier("chat-historical-image")
        .task(id: Run(active: active, refresh: refresh)) {
            guard active, attachment == nil else { return }
            error = nil
            do {
                let key = cacheKey as NSString
                if let cached = TranscriptImageCache.images.object(forKey: key) {
                    attachment = cached.attachment
                    ChatRenderCacheMetrics.record("historical-image", hit: true)
                    return
                }
                ChatRenderCacheMetrics.record("historical-image", hit: false)
                let bytes: Data
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { bytes = try AgentChatFixture.imageBytes(reference) }
                else { bytes = try await fetch() }
                #else
                bytes = try await fetch()
                #endif
                try Task.checkCancellation()
                let prepared = try await Task.detached(priority: .userInitiated) {
                    let started = CFAbsoluteTimeGetCurrent()
                    defer {
                        #if DEBUG
                        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
                            print("[PhrenPerformance] historical image decode off-main=\(!ChatRenderCacheMetrics.isMainThread) max=1600px: \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
                        }
                        #endif
                    }
                    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceThumbnailMaxPixelSize: 1_600, kCGImageSourceShouldCacheImmediately: true,
                            kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary),
                          let reduced = UIImage(cgImage: image).jpegData(compressionQuality: 0.9) else {
                        throw PhrenKitError.validation("The image is unavailable.")
                    }
                    let attachment = try AgentAttachment(name: "Conversation image.jpg", data: reduced, isImage: true)
                    ImageViewerOriginals.remember(bytes, for: attachment.id)
                    return attachment
                }.value
                try Task.checkCancellation()
                TranscriptImageCache.images.setObject(.init(prepared), forKey: key, cost: prepared.data.count)
                attachment = prepared
            } catch { if !Task.isCancelled { self.error = "Image unavailable · Retry" } }
        }
    }
    /// A thumbnail takes its width from its height; an inline picture takes
    /// its width from the row and its height from that.
    @ViewBuilder private func sized<Content: View>(_ content: Content) -> some View {
        if layout == .thumbnail { content.frame(height: Self.thumbnailHeight) } else { content.frame(maxHeight: 240) }
    }
    private var cacheKey: String {
        switch reference {
        case .transcript(let line, let block, let inner): return "\(target.id)/\(line)/\(block)/\(inner ?? -1)"
        case .upload(let path): return "\(session.host.id)/upload/\(path)"
        }
    }
    private func fetch() async throws -> Data {
        switch reference {
        case .transcript(let line, let block, let inner):
            return try await PhrenConnection.transcriptImage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, line: line, block: block, inner: inner)
        case .upload(let path):
            return try await PhrenConnection.uploadImage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), path: path)
        }
    }
    private struct Run: Equatable { let active: Bool; let refresh: UUID }
}
