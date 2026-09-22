import UIKit

/// Decoded rasters shared by the phone's non-chat image surfaces, keyed by a
/// stable id so a re-created row never decodes the same bytes twice. Decoding
/// happens off the main actor; the view body only ever reads a ready image.
@MainActor
enum ImageRasterCache {
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 24 * 1_024 * 1_024
        cache.countLimit = 64
        return cache
    }()

    static func image(for key: String) -> UIImage? {
        images.object(forKey: key as NSString)
    }

    static func store(_ image: UIImage, for key: String) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(image, forKey: key as NSString, cost: cost)
    }
}

extension UIImage {
    /// A display-ready copy, decoded once by the caller. `preparingForDisplay`
    /// returns nil when the data could not be decoded.
    func preparedForDisplay() -> UIImage? { preparingForDisplay() }
}
