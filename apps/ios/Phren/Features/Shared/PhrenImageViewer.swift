import CryptoKit
import ImageIO
import PhrenKit
import SwiftUI

/// Geometry uses image pixels, viewport points and a zoom relative to fit.
struct ImageViewerGeometry {
    let pixels: CGSize
    let viewport: CGSize

    var fitScale: CGFloat {
        guard pixels.width > 0, pixels.height > 0, viewport.width > 0, viewport.height > 0 else { return 1 }
        return min(1, viewport.width / pixels.width, viewport.height / pixels.height)
    }
    var fittedSize: CGSize { CGSize(width: pixels.width * fitScale, height: pixels.height * fitScale) }
    var pixelZoom: CGFloat { max(1, 1 / fitScale) }
    var maximumZoom: CGFloat { max(4, pixelZoom) }
    func clampedZoom(_ zoom: CGFloat) -> CGFloat { min(maximumZoom, max(1, zoom)) }
    func bounds(at zoom: CGFloat) -> CGSize {
        CGSize(width: max(0, (fittedSize.width * clampedZoom(zoom) - viewport.width) / 2),
               height: max(0, (fittedSize.height * clampedZoom(zoom) - viewport.height) / 2))
    }
    func clamped(_ offset: CGPoint, at zoom: CGFloat) -> CGPoint {
        let limit = bounds(at: zoom)
        return CGPoint(x: min(limit.width, max(-limit.width, offset.x)),
                       y: min(limit.height, max(-limit.height, offset.y)))
    }
    /// Keep the image point under the fingers, including a moving pinch midpoint.
    func anchoredOffset(_ offset: CGPoint, from oldZoom: CGFloat, to newZoom: CGFloat,
                        anchor: CGPoint, destination: CGPoint) -> CGPoint {
        let ratio = clampedZoom(newZoom) / clampedZoom(oldZoom)
        let center = CGPoint(x: viewport.width / 2, y: viewport.height / 2)
        return clamped(CGPoint(x: destination.x - center.x - (anchor.x - center.x - offset.x) * ratio,
                               y: destination.y - center.y - (anchor.y - center.y - offset.y) * ratio), at: newZoom)
    }
    static func startsDismissal(zoom: CGFloat, movement: CGPoint) -> Bool {
        zoom <= 1.0001 && movement.y > abs(movement.x)
    }
    var dismissalThreshold: CGFloat { max(80, min(160, viewport.height * 0.18)) }
    func shouldDismiss(translation: CGPoint) -> Bool {
        translation.y >= dismissalThreshold && translation.y > abs(translation.x)
    }
}

/// Keep source bytes when upload preparation or transcript rows make thumbnails.
/// Only memory is used. Access also comes from detached attachment preparation.
enum ImageViewerOriginals {
    private static let lock = NSLock()
    private static var originals: [UUID: Data] = [:]
    static func remember(_ data: Data, for id: UUID) {
        lock.lock(); defer { lock.unlock() }
        if originals[id] == nil { originals[id] = data }
    }
    static func data(for attachment: AgentAttachment) -> Data {
        lock.lock(); defer { lock.unlock() }
        return originals[attachment.id] ?? attachment.data
    }
}

struct ImageViewerRaster {
    let image: UIImage
    let pixels: CGSize

    /// ImageIO applies orientation and eagerly decodes on the calling worker.
    static func decode(_ data: Data, maximumPixels: Int?) -> ImageViewerRaster? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        let pixels = (5...8).contains(orientation) ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
        guard let raster = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixels ?? max(width, height),
        ] as CFDictionary) else { return nil }
        return ImageViewerRaster(image: UIImage(cgImage: raster), pixels: pixels)
    }
}

/// Completed full decodes and in-flight work stay shared for the app session.
/// Content keys also deduplicate reopening the same file through another surface.
@MainActor enum ImageViewerRasterCache {
    private static var full: [String: Task<ImageViewerRaster?, Never>] = [:]
    static func load(_ data: Data, fullResolution: Bool) async -> ImageViewerRaster? {
        let key = await Task.detached(priority: .userInitiated) {
            SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }.value
        if let task = full[key] { return await task.value }
        guard fullResolution else {
            return await Task.detached(priority: .userInitiated) { ImageViewerRaster.decode(data, maximumPixels: 2_048) }.value
        }
        let task = Task.detached(priority: .userInitiated) { ImageViewerRaster.decode(data, maximumPixels: nil) }
        full[key] = task
        return await task.value
    }
}

struct PhrenImageViewer: View {
    let name: String
    let load: () async throws -> Data
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var original: Data?
    @State private var raster: ImageViewerRaster?
    @State private var wantsFullResolution = false
    @State private var error: String?

    init(attachment: AgentAttachment) {
        name = attachment.name
        load = { ImageViewerOriginals.data(for: attachment) }
    }
    init(name: String, load: @escaping () async throws -> Data) {
        self.name = name; self.load = load
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: PhrenTheme.Space.medium) {
                Text(name).font(PhrenTypography.subheadline.weight(.semibold))
                    .foregroundStyle(PhrenTheme.text).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                PhrenIconButton(icon: "xmark", label: "Close image") { dismiss() }
                    .accessibilityIdentifier("image-viewer-close")
            }
            .padding(.leading, PhrenTheme.Space.large).padding(.trailing, 6).frame(minHeight: 56)
            if let raster {
                ImageViewerCanvas(raster: raster, reduceMotion: reduceMotion,
                                  zoomed: { wantsFullResolution = true }, dismiss: { dismiss() })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Text(error ?? "Loading image…").font(PhrenTypography.body).foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(PhrenTheme.bg.ignoresSafeArea())
        .interactiveDismissDisabled()
        .presentationDragIndicator(.hidden)
        .task {
            do {
                let bytes = try await load()
                let preview = await ImageViewerRasterCache.load(bytes, fullResolution: false)
                guard !Task.isCancelled else { return }
                original = bytes; raster = preview
                if preview == nil { error = "This image could not be opened." }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .task(id: wantsFullResolution) {
            guard wantsFullResolution, let original else { return }
            let full = await ImageViewerRasterCache.load(original, fullResolution: true)
            guard !Task.isCancelled, let full else { return }
            raster = full
        }
    }
}

private struct ImageViewerCanvas: UIViewRepresentable {
    let raster: ImageViewerRaster
    let reduceMotion: Bool
    let zoomed: () -> Void
    let dismiss: () -> Void
    func makeUIView(context: Context) -> ImageViewerSurface { ImageViewerSurface() }
    func updateUIView(_ view: ImageViewerSurface, context: Context) {
        view.reduceMotion = reduceMotion; view.zoomed = zoomed; view.dismiss = dismiss
        view.setRaster(raster)
    }
}

/// UIKit supplies touch locations only. All rendering and chrome belong to phren.
private final class ImageViewerSurface: UIView, UIGestureRecognizerDelegate {
    var reduceMotion = false
    var zoomed: () -> Void = {}
    var dismiss: () -> Void = {}
    private let picture = UIImageView()
    private var pixels = CGSize.zero
    private var zoom: CGFloat = 1
    private var offset = CGPoint.zero
    private var previousAnchor = CGPoint.zero
    private var draggingToDismiss = false
    private var dismissalDrag = CGPoint.zero
    private var previousSize = CGSize.zero
    private var geometry: ImageViewerGeometry { ImageViewerGeometry(pixels: pixels, viewport: bounds.size) }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        addSubview(picture)
        picture.contentMode = .scaleToFill
        picture.isAccessibilityElement = false
        isAccessibilityElement = true
        accessibilityIdentifier = "image-viewer"
        accessibilityLabel = "Image viewer"
        accessibilityHint = "Pinch to zoom. Double tap to toggle actual size. Drag to pan when zoomed, or drag down to close at fit."
        accessibilityTraits = [.image, .adjustable]
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched))
        pinch.delegate = self
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
        pan.maximumNumberOfTouches = 1; pan.delegate = self
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(pinch); addGestureRecognizer(pan); addGestureRecognizer(doubleTap)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setRaster(_ raster: ImageViewerRaster) {
        pixels = raster.pixels; picture.image = raster.image
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        if previousSize != bounds.size {
            previousSize = bounds.size
            zoom = geometry.clampedZoom(zoom); offset = geometry.clamped(offset, at: zoom)
        }
        draw()
    }
    private func draw() {
        let fitted = geometry.fittedSize
        picture.frame = CGRect(x: (bounds.width - fitted.width * zoom) / 2 + offset.x,
                               y: (bounds.height - fitted.height * zoom) / 2 + offset.y + (reduceMotion ? 0 : dismissalDrag.y),
                               width: fitted.width * zoom, height: fitted.height * zoom)
        accessibilityValue = zoom <= 1.0001 ? "Fit" : "\(Int((zoom * 100).rounded()))% of fit"
    }
    private func changeZoom(to requested: CGFloat, anchor: CGPoint, destination: CGPoint, animated: Bool) {
        let next = geometry.clampedZoom(requested)
        offset = geometry.anchoredOffset(offset, from: zoom, to: next, anchor: anchor, destination: destination)
        zoom = next
        if zoom > 1.0001 { zoomed() }
        if animated && !reduceMotion {
            UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) { self.draw() }
        } else { draw() }
    }
    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            dismissalDrag = .zero; draggingToDismiss = false
            previousAnchor = point
        case .changed:
            changeZoom(to: zoom * gesture.scale, anchor: previousAnchor, destination: point, animated: false)
            previousAnchor = point; gesture.scale = 1
        default: break
        }
    }
    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        changeZoom(to: zoom > 1.0001 ? 1 : geometry.pixelZoom, anchor: point, destination: point, animated: true)
    }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        draggingToDismiss = ImageViewerGeometry.startsDismissal(zoom: zoom, movement: pan.velocity(in: self))
        return zoom > 1.0001 || draggingToDismiss
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        (gestureRecognizer is UIPinchGestureRecognizer && otherGestureRecognizer is UIPanGestureRecognizer)
            || (gestureRecognizer is UIPanGestureRecognizer && otherGestureRecognizer is UIPinchGestureRecognizer)
    }
    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: self)
        switch gesture.state {
        case .began:
            if draggingToDismiss { dismissalDrag = CGPoint(x: 0, y: max(0, translation.y)); draw() }
            else { offset = geometry.clamped(CGPoint(x: offset.x + translation.x, y: offset.y + translation.y), at: zoom); gesture.setTranslation(.zero, in: self); draw() }
        case .changed:
            if draggingToDismiss { dismissalDrag = CGPoint(x: 0, y: max(0, translation.y)) }
            else {
                offset = geometry.clamped(CGPoint(x: offset.x + translation.x, y: offset.y + translation.y), at: zoom)
                gesture.setTranslation(.zero, in: self)
            }
            draw()
        case .ended, .cancelled, .failed:
            let close = gesture.state == .ended && draggingToDismiss && geometry.shouldDismiss(translation: translation)
            draggingToDismiss = false; dismissalDrag = .zero
            if close { dismiss() }
            else if reduceMotion { draw() }
            else { UIView.animate(withDuration: 0.18) { self.draw() } }
        default: break
        }
    }
    override func accessibilityIncrement() { accessibilityZoom(to: zoom * 2) }
    override func accessibilityDecrement() { accessibilityZoom(to: zoom / 2) }
    override func accessibilityPerformEscape() -> Bool { dismiss(); return true }
    private func accessibilityZoom(to scale: CGFloat) {
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        changeZoom(to: scale, anchor: center, destination: center, animated: true)
    }
}
