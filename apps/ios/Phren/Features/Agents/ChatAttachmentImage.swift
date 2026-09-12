import ImageIO
import PhrenKit
import SwiftUI

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
            let data = attachment.data, pixels = maximumPixels
            let decoded = await Task.detached(priority: .userInitiated) {
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
            image = decoded
        }
        .onDisappear { image = nil }
    }
}
