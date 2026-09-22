import XCTest
import UIKit
@testable import Phren

@MainActor final class ChatComposerTests: XCTestCase {
    func testComposerGrowsToFourLinesAndLeavesLongDraftScrollable() {
        let view = ChatSelectionTextView()
        view.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        view.textContainerInset = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = true
        view.text = "First line"
        let one = ChatComposer.fittingSize(view, width: 300)
        view.text = "First line\nSecond line\nThird line"
        let three = ChatComposer.fittingSize(view, width: 300)
        XCTAssertGreaterThan(three.height, one.height)
        view.text = (1...20).map { "Line \($0)" }.joined(separator: "\n")
        let many = ChatComposer.fittingSize(view, width: 300)
        XCTAssertEqual(many.height, ceil(4 * view.font!.lineHeight + 16))
        view.frame = CGRect(origin: .zero, size: many)
        view.layoutIfNeeded()
        XCTAssertTrue(view.isScrollEnabled)
        XCTAssertTrue(view.hasScrollableDraft)
    }

    func testActualTextRangeLocksTranscriptAndCollapseRestoresIt() {
        let controller = UIViewController()
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let previousWindow = scene?.keyWindow
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKey() }
        let view = ChatSelectionTextView(frame: CGRect(x: 0, y: 0, width: 300, height: 90))
        controller.view.addSubview(view)
        view.text = "Alpha Bravo Charlie"
        let selection = ChatTextSelection()
        selection.composerView = view
        view.selectionActivityChanged = { selection.composerSelecting = $0 }
        XCTAssertTrue(view.becomeFirstResponder())
        view.selectedRange = NSRange(location: 0, length: 5)
        XCTAssertTrue(selection.preventsTranscriptScrolling)
        XCTAssertTrue(selection.preventsKeyboardDismissal)
        view.selectedRange = NSRange(location: 5, length: 0)
        XCTAssertFalse(selection.preventsTranscriptScrolling)
        XCTAssertFalse(selection.preventsKeyboardDismissal)
        view.selectedRange = NSRange(location: 6, length: 5)
        XCTAssertTrue(view.resignFirstResponder())
        XCTAssertFalse(selection.preventsTranscriptScrolling)
    }

    func testMessageSelectionSurvivesLayoutScrollAndReleasesOnDone() {
        let selection = ChatTextSelection()
        selection.scrolled(to: 30)
        selection.begin(owner: "reply", block: 0, at: nil)
        selection.scrolled(to: 80)
        XCTAssertNotNil(selection.active)
        XCTAssertTrue(selection.preventsTranscriptScrolling)
        selection.end()
        XCTAssertFalse(selection.preventsTranscriptScrolling)
        selection.begin(owner: "reply", block: 1, at: .zero)
        selection.messageSelectionChanged(false, target: selection.active)
        XCTAssertFalse(selection.preventsTranscriptScrolling)
        selection.scrolled(to: 110)
        XCTAssertNil(selection.active)
    }
}
