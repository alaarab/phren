import ImageIO
import PhrenKit
import PhrenLive
import SwiftUI

@MainActor private enum TranscriptImageCache {
    static let data: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>(); cache.totalCostLimit = 16_777_216; cache.countLimit = 16; return cache
    }()
}

struct ChatHistoricalImage: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let line: Int
    let block: Int
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
                let key = "\(target.id)/\(line)/\(block)" as NSString
                var bytes = TranscriptImageCache.data.object(forKey: key).map { $0 as Data }
                if bytes == nil {
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled { bytes = AgentChatFixture.image.data }
                    else { bytes = try await PhrenConnection.transcriptImage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, line: line, block: block) }
                    #else
                    bytes = try await PhrenConnection.transcriptImage(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, line: line, block: block)
                    #endif
                }
                try Task.checkCancellation()
                guard let bytes else { throw PhrenKitError.validation("The image is unavailable.") }
                let prepared = try await Task.detached(priority: .userInitiated) {
                    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceThumbnailMaxPixelSize: 1_600, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary),
                          let reduced = UIImage(cgImage: image).jpegData(compressionQuality: 0.9) else {
                        throw PhrenKitError.validation("The image is unavailable.")
                    }
                    return try AgentAttachment(name: "Conversation image.jpg", data: reduced, isImage: true)
                }.value
                try Task.checkCancellation()
                TranscriptImageCache.data.setObject(bytes as NSData, forKey: key, cost: bytes.count)
                attachment = prepared
            } catch { if !Task.isCancelled { self.error = "Image unavailable · Retry" } }
        }
    }
    private struct Run: Equatable { let active: Bool; let refresh: UUID }
}
