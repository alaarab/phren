import ImageIO
import UIKit
import XCTest
@testable import Phren

final class ImageViewerTests: XCTestCase {
    private let geometry = ImageViewerGeometry(pixels: CGSize(width: 2_400, height: 1_600),
                                               viewport: CGSize(width: 300, height: 400))

    func testFitAndPixelZoomPreserveAspectRatio() {
        XCTAssertEqual(geometry.fitScale, 0.125)
        XCTAssertEqual(geometry.fittedSize, CGSize(width: 300, height: 200))
        XCTAssertEqual(geometry.pixelZoom, 8)
        XCTAssertEqual(geometry.maximumZoom, 8)
        let small = ImageViewerGeometry(pixels: CGSize(width: 120, height: 80), viewport: CGSize(width: 300, height: 400))
        XCTAssertEqual(small.fitScale, 1)
        XCTAssertEqual(small.maximumZoom, 4)
        XCTAssertEqual(small.clampedZoom(100), 4)
        XCTAssertEqual(geometry.clampedZoom(0.1), 1)
    }

    func testFitCannotPanAndFourTimesCannotLeaveTheViewport() {
        XCTAssertEqual(geometry.bounds(at: 1), .zero)
        XCTAssertEqual(geometry.clamped(CGPoint(x: 500, y: -500), at: 1), .zero)
        XCTAssertEqual(geometry.bounds(at: 4), CGSize(width: 450, height: 200))
        XCTAssertEqual(geometry.clamped(CGPoint(x: 900, y: -900), at: 4), CGPoint(x: 450, y: -200))
        XCTAssertEqual(geometry.clamped(CGPoint(x: -900, y: 900), at: 4), CGPoint(x: -450, y: 200))
        XCTAssertEqual(geometry.clamped(CGPoint(x: 120, y: -40), at: 4), CGPoint(x: 120, y: -40))
    }

    func testTallImagesStayCenteredOnTheShortAxis() {
        let tall = ImageViewerGeometry(pixels: CGSize(width: 100, height: 2_000), viewport: CGSize(width: 300, height: 400))
        XCTAssertEqual(tall.fitScale, 0.2)
        XCTAssertEqual(tall.bounds(at: 4), CGSize(width: 0, height: 600))
        XCTAssertEqual(tall.clamped(CGPoint(x: 70, y: 40), at: 4), CGPoint(x: 0, y: 40))
    }

    func testPinchAndDoubleTapKeepTheirAnchorUntilAnEdgeClamps() {
        let anchor = CGPoint(x: 180, y: 220)
        let offset = geometry.anchoredOffset(.zero, from: 1, to: 4, anchor: anchor, destination: anchor)
        XCTAssertEqual(offset, CGPoint(x: -90, y: -60))
        let moved = geometry.anchoredOffset(.zero, from: 1, to: 4, anchor: anchor, destination: CGPoint(x: 195, y: 240))
        XCTAssertEqual(moved, CGPoint(x: -75, y: -40))
        XCTAssertEqual(geometry.anchoredOffset(offset, from: 4, to: 1, anchor: anchor, destination: anchor), .zero)
    }

    func testDismissalRequiresFitAndADownwardStartThenEnoughDistance() {
        XCTAssertTrue(ImageViewerGeometry.startsDismissal(zoom: 1, movement: CGPoint(x: 5, y: 20)))
        XCTAssertFalse(ImageViewerGeometry.startsDismissal(zoom: 1.1, movement: CGPoint(x: 0, y: 20)))
        XCTAssertFalse(ImageViewerGeometry.startsDismissal(zoom: 1, movement: CGPoint(x: 0, y: -20)))
        XCTAssertFalse(ImageViewerGeometry.startsDismissal(zoom: 1, movement: CGPoint(x: 25, y: 20)))
        XCTAssertEqual(geometry.dismissalThreshold, 80)
        XCTAssertFalse(geometry.shouldDismiss(translation: CGPoint(x: 0, y: 79)))
        XCTAssertTrue(geometry.shouldDismiss(translation: CGPoint(x: 0, y: 80)))
        XCTAssertFalse(geometry.shouldDismiss(translation: CGPoint(x: 100, y: 80)))
        let tablet = ImageViewerGeometry(pixels: geometry.pixels, viewport: CGSize(width: 800, height: 1_200))
        XCTAssertEqual(tablet.dismissalThreshold, 160)
    }

    @MainActor
    func testFullResolutionKeepsOriginalPixelsAndSharesTheDecode() async throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let data = UIGraphicsImageRenderer(size: CGSize(width: 2_500, height: 40), format: format).pngData { context in
            UIColor.cyan.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2_500, height: 40))
        }
        let prepared = await ImageViewerRasterCache.load(data, fullResolution: false)
        let preview = try XCTUnwrap(prepared)
        XCTAssertEqual(preview.image.cgImage?.width, 2_048)
        XCTAssertEqual(preview.pixels.width, 2_500)
        async let first = ImageViewerRasterCache.load(data, fullResolution: true)
        async let second = ImageViewerRasterCache.load(data, fullResolution: true)
        let (a, b) = await (first, second)
        let full = try XCTUnwrap(a), repeated = try XCTUnwrap(b)
        XCTAssertEqual(full.image.cgImage?.width, 2_500)
        XCTAssertTrue(full.image === repeated.image)
    }

    @MainActor
    func testUploadAndSentThumbnailsKeepTheOriginalForTheViewer() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let original = UIGraphicsImageRenderer(size: CGSize(width: 2_500, height: 40), format: format).pngData { context in
            UIColor.cyan.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2_500, height: 40))
        }
        let attachment = try ChatAttachmentPreparation.image(original)
        let sent = try XCTUnwrap(ChatAttachmentPreparation.preview(attachment))
        XCTAssertEqual(ImageViewerOriginals.data(for: sent), original)
    }
}
