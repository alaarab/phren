import ImageIO
import PhrenKit
import SwiftUI

@MainActor private enum AttachmentRasterCache {
    static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 24 * 1_024 * 1_024; cache.countLimit = 32
        return cache
    }()
}

/// Decode at display size off the main actor, once per visible attachment.
/// Releasing the raster on disappearance bounds memory while scrolling history.
struct ChatAttachmentImage: View {
    let attachment: AgentAttachment
    var maximumPixels = 768
    @State private var image: UIImage?
    private struct Request: Equatable { let attachment: AgentAttachment; let pixels: Int }

    var body: some View {
        ZStack {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: "photo").foregroundStyle(PhrenTheme.textMuted) }
        }
        .task(id: Request(attachment: attachment, pixels: maximumPixels)) {
            let key = "\(attachment.id):\(maximumPixels)" as NSString
            if let cached = AttachmentRasterCache.images.object(forKey: key) {
                image = cached
                ChatRenderCacheMetrics.record("image", hit: true)
                return
            }
            ChatRenderCacheMetrics.record("image", hit: false)
            let data = attachment.data, pixels = maximumPixels
            let decoded = await Task.detached(priority: .userInitiated) {
                let started = CFAbsoluteTimeGetCurrent()
                defer {
                    #if DEBUG
                    if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
                        print("[PhrenPerformance] attachment decode off-main=\(!ChatRenderCacheMetrics.isMainThread) max=\(pixels)px: \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
                    }
                    #endif
                }
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceShouldCacheImmediately: true,
                        kCGImageSourceThumbnailMaxPixelSize: pixels,
                      ] as CFDictionary) else { return UIImage?.none }
                return UIImage(cgImage: image)
            }.value
            guard !Task.isCancelled else { return }
            if let decoded, let raster = decoded.cgImage {
                AttachmentRasterCache.images.setObject(decoded, forKey: key, cost: raster.bytesPerRow * raster.height)
            }
            image = decoded
        }
        .onDisappear { image = nil }
    }
}
