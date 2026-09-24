import XCTest

/// Images and attachments: picking, pasting, previewing, sending, and pictures in the transcript.
final class AgentChatImageTests: AgentChatUITestCase {
    @MainActor
    func testClaudePastedImageReplacesPendingTwinAndHidesImageTokens() {
        let app = launch(extra: ["--chat-claude-image", "--chat-working"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let pending = app.descendants(matching: .any)["chat-queued-tag:2:0"].firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["queued"].exists)
        XCTAssertFalse(app.buttons["View conversation image"].exists)
        capture(app, "Pending pasted image turn")
        app.buttons["chat-stop"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        XCTAssertFalse(pending.exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat-message:2:0"].firstMatch.exists)
        XCTAssertTrue(app.staticTexts["Why does this terminal wrap?"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "[Image #1]")).firstMatch.exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Attached files on this computer:")).firstMatch.exists)
        let real = app.descendants(matching: .any)["chat-message:3:0"].firstMatch
        XCTAssertTrue(real.buttons["View conversation image"].exists)
        capture(app, "Landed pasted image in one bubble")
    }

    @MainActor
    func testConversationImageDoubleTapZoomsAndCloses() {
        let app = launch(extra: ["--chat-historical-image", "--chat-image-zoom"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let picture = app.buttons["View conversation image"]
        XCTAssertTrue(picture.waitForExistence(timeout: 8))
        picture.tap()
        let viewer = app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 8))
        XCTAssertEqual(viewer.value as? String, "Fit")
        viewer.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)).doubleTap()
        let zoomed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", "Fit"), object: viewer)
        XCTAssertEqual(XCTWaiter.wait(for: [zoomed], timeout: 5), .completed)
        capture(app, "Conversation image zoom")
        viewer.doubleTap()
        let fitted = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Fit"), object: viewer)
        XCTAssertEqual(XCTWaiter.wait(for: [fitted], timeout: 5), .completed)
        app.buttons["file-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        XCTAssertTrue(picture.exists)
    }

    @MainActor
    func testHistoricalImageDiffAndNativeHerdrNavigation() {
        let app = launch(extra: ["--chat-historical-image"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        app.buttons["View conversation image"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch.waitForExistence(timeout: 5))
        // A file on the computer opens in the file viewer, which wraps the image viewer.
        app.buttons["file-viewer-close"].tap()
        openRepositoryChanges(in: app)
        // The header's Changes screen: staged, unstaged and untracked files
        // in List mode, the change itself in Diff mode.
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "changes-header").firstMatch.waitForExistence(timeout: 5))
        app.buttons["changes-mode-list"].tap()
        let listed = { (path: String) in app.staticTexts.matching(NSPredicate(format: "label == %@", path)).firstMatch }
        XCTAssertTrue(listed("Sources/App.swift").waitForExistence(timeout: 5))
        XCTAssertTrue(listed("Sources/App/Settings.swift").exists, "Staged and unstaged files are listed in their own groups")
        XCTAssertTrue(listed("Notes.md").exists, "Untracked files are listed too")
        capture(app, "Repository changes list")
        app.buttons["changes-mode-diff"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "-let accent = green")).firstMatch.exists)
        capture(app, "Native repository diff")
        // A file under a folder nests under it in the working tree, like
        // Finder or VS Code's source control view; expand the folder to reach
        // it, and the file opens its own diff with the side-by-side option.
        app.buttons["changes-tab-tree"].tap()
        let sources = app.buttons["changes-tree-entry:Sources"]
        XCTAssertTrue(sources.waitForExistence(timeout: 5)); sources.tap()
        let appFile = app.buttons["changes-tree-entry:Sources/App.swift"]
        XCTAssertTrue(appFile.waitForExistence(timeout: 5)); appFile.tap()
        let fileBar = app.navigationBars["App.swift"]
        XCTAssertTrue(fileBar.waitForExistence(timeout: 5))
        app.buttons["diff-options"].tap()
        app.buttons["Side by side"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "-let accent = green, +let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        capture(app, "Side-by-side repository diff")
        app.buttons["diff-options"].tap()
        app.buttons["Inline"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "+let accent = purple")).firstMatch.waitForExistence(timeout: 5))
        fileBar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["changes-tab-tree"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["chat-composer-terminal"].tap()
        XCTAssertTrue(app.otherElements["herdr-terminal-header"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Toggle terminal keyboard"].waitForExistence(timeout: 8))
        capture(app, "Native Herdr terminal")
    }

    /// Words and a picture sent together stay one bubble: the image sits
    /// above the text inside it, and the path list the phone appended is gone.
    @MainActor
    func testImageAndTextOfOneTurnShareABubble() {
        let app = launch(extra: ["--chat-image-turn"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.buttons["View conversation image"].waitForExistence(timeout: 8))
        let bubbles = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "chat-message:", "Your message"))
        let bubble = bubbles.allElementsBoundByIndex.first { $0.staticTexts["Look at this header"].exists }
        XCTAssertNotNil(bubble, "The paste marker and the path list are gone")
        XCTAssertTrue(bubble?.buttons["View conversation image"].exists == true, "The picture is inside the same bubble")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Attached files on this computer")).firstMatch.exists)
        XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-message:")).count, 3, "Two fixture turns plus this one — not a fourth bubble for the image")
        capture(app, "Image and text in one bubble")
    }

    /// Every picture the agent read shows under its tool pill without opening
    /// the card, and the pictures sent from the phone — which the transcript
    /// names only by path — sit in the bubble in place of their markers.
    @MainActor
    func testReadImagesShowUnderThePillAndUploadedPicturesInTheBubble() {
        let app = launch(extra: ["--chat-read-images"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        let pictures = app.buttons.matching(NSPredicate(format: "label == %@", "View conversation image"))
        XCTAssertTrue(pictures.firstMatch.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Look at these"].waitForExistence(timeout: 5))
        XCTAssertEqual(pictures.count, 4, "Two frames of the read, two pictures from the phone")
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "chat-tool-group:", "Read")).firstMatch
        XCTAssertTrue(card.exists)
        XCTAssertEqual(card.value as? String, "Collapsed", "The frames show without opening the card")
        let bubble = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "chat-message:", "Your message"))
            .allElementsBoundByIndex.first { $0.staticTexts["Look at these"].exists }
        XCTAssertNotNil(bubble, "The markers are gone from the words")
        XCTAssertEqual(bubble?.buttons.matching(NSPredicate(format: "label == %@", "View conversation image")).count, 2, "Both pictures are inside the bubble")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "[Image: source:")).firstMatch.exists)
        capture(app, "Read frames under the pill, uploaded pictures in the bubble")
        pictures.firstMatch.tap()
        let viewer = app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Conversation image.jpg"].exists)
        XCTAssertEqual(viewer.value as? String, "Fit")
        app.buttons["file-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        XCTAssertEqual(card.value as? String, "Collapsed")
        XCTAssertEqual(pictures.count, 4)
    }

    /// Pick, add, reopen, pick another: the second session starts with
    /// nothing selected and the first photo is not added twice. Needs at
    /// least two photos in the simulator's library (`xcrun simctl addmedia`).
    @MainActor
    func testReopenedPhotoPickerStartsEmptyAndAddsOnlyTheNewPhoto() throws {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let previews = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Preview Image."))
        func pick(_ index: Int) throws {
            app.buttons["Add attachment"].tap()
            app.buttons["chat-attach-menu:photos"].tap()
            let picker = app.scrollViews["photosView_content_scroll_view"]
            XCTAssertTrue(picker.waitForExistence(timeout: 8))
            let introduction = picker.buttons["Close"].firstMatch
            if introduction.exists { introduction.tap() }
            let photos = picker.images
            guard photos.element(boundBy: 1).waitForExistence(timeout: 8) else {
                throw XCTSkip("Seed the UI test simulator with two photos to exercise the system picker")
            }
            // Photos' remote grid exposes its image frame but not AX hit testing.
            photos.element(boundBy: index).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            let done = app.navigationBars["Photos"].buttons["Done"]
            if done.waitForExistence(timeout: 3) { done.tap() } else { app.buttons["Add"].firstMatch.tap() }
        }
        try pick(0)
        XCTAssertTrue(previews.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(previews.count, 1)
        try pick(1)
        let two = NSPredicate { _, _ in previews.count == 2 }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: two, object: nil)], timeout: 10), .completed,
                       "The second session adds only the newly picked photo")
        // With the old bound selection the first photo came back with the
        // second, so the count passed through 2 on its way to 3.
        let duplicate = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in previews.count > 2 }, object: nil)
        duplicate.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [duplicate], timeout: 3), .completed, "The first photo is not added again")
        capture(app, "Two photos from two picker sessions")
    }

    @MainActor
    func testImageAttachmentCanBeRemovedPreviewedAndSent() {
        let app = launch()
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        attachImage(app)
        XCTAssertTrue(app.buttons["Preview Screenshot.png"].waitForExistence(timeout: 5))
        app.buttons["Preview Screenshot.png"].tap()
        let viewer = app.descendants(matching: .any).matching(identifier: "image-viewer").firstMatch
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Screenshot.png"].exists)
        XCTAssertEqual(viewer.value as? String, "Fit")
        app.buttons["file-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        app.buttons["Remove Screenshot.png"].tap()
        XCTAssertFalse(app.buttons["Preview Screenshot.png"].exists)
        attachImage(app)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Review this screenshot")
        capture(app, "Image and prompt ready to send")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.buttons["View attached Screenshot.png"].waitForExistence(timeout: 8))
        app.buttons["View attached Screenshot.png"].tap()
        XCTAssertTrue(viewer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Screenshot.png"].exists)
        app.buttons["file-viewer-close"].tap()
        XCTAssertTrue(viewer.waitForNonExistence(timeout: 5))
        capture(app, "Sent image in conversation")
        if app.buttons["Latest messages"].isHittable { app.buttons["Latest messages"].tap() }
        XCTAssertTrue(app.staticTexts["Received in codex on w7:p1: Review this screenshot"].waitForExistence(timeout: 8))
        // The upload note is its own paragraph, below the echoed reply.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "/tmp/phren-fixture/")).firstMatch.exists)
        XCTAssertFalse(app.buttons["Remove Screenshot.png"].exists)
    }

    /// A screenshot on the clipboard pastes into the composer as an
    /// attachment, the same chip the + picker adds, not as nothing.
    @MainActor
    func testPastedImageBecomesAnAttachment() {
        let app = launch(extra: ["--chat-paste-image"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap()
        let paste = app.menuItems["Paste"].firstMatch
        if !paste.waitForExistence(timeout: 2) { composer.tap() }
        if !paste.waitForExistence(timeout: 3) { composer.press(forDuration: 0.8) }
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste is offered when the clipboard holds an image")
        paste.tap()
        XCTAssertTrue(app.buttons["Preview Clipboard.png"].waitForExistence(timeout: 8), "The pasted image is an attachment chip")
        XCTAssertEqual((composer.value as? String) ?? "", "", "The image is not pasted into the draft as text")
        capture(app, "Pasted image attachment")
    }

    @MainActor
    func testFailedUploadRetainsImageAndTextWithoutSending() {
        let app = launch(extra: ["--chat-upload-fails"])
        app.buttons["live-chat:w7:w7:t9"].tap()
        XCTAssertTrue(app.staticTexts["The project screen is ready. What would you like to change?"].waitForExistence(timeout: 5))
        attachImage(app)
        let composer = app.descendants(matching: .any).matching(identifier: "chat-composer").firstMatch
        composer.tap(); composer.typeText("Keep my screenshot")
        app.buttons["chat-send"].tap()
        XCTAssertTrue(app.staticTexts["chat-delivery-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["chat-delivery-error"].label.contains("message hasn't been sent"))
        XCTAssertEqual(composer.value as? String, "Keep my screenshot")
        XCTAssertTrue(app.buttons["Remove Screenshot.png"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Received in codex")).firstMatch.exists)
    }

}
