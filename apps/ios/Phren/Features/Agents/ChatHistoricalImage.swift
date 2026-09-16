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

struct ChatHistoricalImage: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let line: Int
    let block: Int
    var inner: Int? = nil
    let active: Bool
    let preview: (ChatAttachmentDraft) -> Void
    @State private var attachment: AgentAttachment?
    @State private var error: String?
    @State private var refresh = UUID()
    var body: some View {
        Group {
            if let attachment {
                Button { preview(.init(attachment: attachment)) } label: {
                    ChatAttachmentImage(attachment: attachment).frame(maxHeight: 240).clipShape(RoundedRectangle(cornerRadius: 12))
                }.accessibilityLabel("View conversation image")
            } else if let error {
                Button { refresh = UUID() } label: { Label(error, systemImage: "arrow.clockwise").font(.caption) }
            } else { ProgressView("Loading image…").font(.caption).frame(minHeight: 80) }
        }
        .accessibilityIdentifier("chat-historical-image")
        .task(id: Run(active: active, refresh: refresh)) {
            guard active, attachment == nil else { return }
            error = nil
            do {
                let key = "\(target.id)/\(line)/\(block)/\(inner ?? -1)" as NSString
                if let cached = TranscriptImageCache.images.object(forKey: key) {
                    attachment = cached.attachment
                    ChatRenderCacheMetrics.record("historical-image", hit: true)
                    return
                }
                ChatRenderCacheMetrics.record("historical-image", hit: false)
                let bytes: Data
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { bytes = AgentChatFixture.image.data }
                else { bytes = try await PhrenConnection.transcriptImage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, line: line, block: block, inner: inner) }
                #else
                bytes = try await PhrenConnection.transcriptImage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, line: line, block: block, inner: inner)
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
                    return try AgentAttachment(name: "Conversation image.jpg", data: reduced, isImage: true)
                }.value
                try Task.checkCancellation()
                TranscriptImageCache.images.setObject(.init(prepared), forKey: key, cost: prepared.data.count)
                attachment = prepared
            } catch { if !Task.isCancelled { self.error = "Image unavailable · Retry" } }
        }
    }
    private struct Run: Equatable { let active: Bool; let refresh: UUID }
}
