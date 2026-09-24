import XCTest

final class FileViewerUITests: XCTestCase {
    @MainActor private func files() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8)); app.tabBars.buttons["Agents"].tap()
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        for _ in 0..<14 { if host.exists && host.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(host.waitForExistence(timeout: 8)); host.tap()
        let files = app.buttons["host-files"]
        XCTAssertTrue(files.waitForExistence(timeout: 8)); files.tap()
        return app
    }
    @MainActor func testVideoHasPhrenTransportAndFullscreen() {
        let app = files()
        let row = app.buttons["files-row:render.mp4"]
        XCTAssertTrue(row.waitForExistence(timeout: 8)); row.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "file-viewer-video").firstMatch.waitForExistence(timeout: 15))
        let play = app.buttons["file-media-play"]
        XCTAssertTrue(play.waitForExistence(timeout: 8))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: play); waitForExpectations(timeout: 15)
        play.tap()
        XCTAssertTrue(app.buttons["file-media-mute"].exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "file-media-scrubber").firstMatch.exists)
        app.buttons["file-media-fullscreen"].tap()
        XCTAssertFalse(app.buttons["file-viewer-close"].exists)
        app.buttons["file-media-fullscreen"].tap()
        XCTAssertTrue(app.buttons["file-viewer-close"].exists)
        attachUIScreenshot(app, "Video with phren transport")
    }
    @MainActor func testPDFHasPhrenPageControls() {
        let app = files()
        let row = app.buttons["files-row:design.pdf"]
        XCTAssertTrue(row.waitForExistence(timeout: 8)); row.tap()
        let page = app.staticTexts["file-pdf-page"]
        XCTAssertTrue(page.waitForExistence(timeout: 8))
        expectation(for: NSPredicate(format: "label == %@", "Page 1 of 2"), evaluatedWith: page); waitForExpectations(timeout: 8)
        app.buttons["file-pdf-next"].tap()
        expectation(for: NSPredicate(format: "label == %@", "Page 2 of 2"), evaluatedWith: page); waitForExpectations(timeout: 8)
        XCTAssertTrue(app.buttons["file-viewer-save"].exists)
        XCTAssertTrue(app.buttons["file-viewer-share"].exists)
        attachUIScreenshot(app, "PDF with phren page controls")
    }
    @MainActor func testJSONFoldsThroughPhrenControls() {
        let app = files()
        let row = app.buttons["files-row:result.json"]
        XCTAssertTrue(row.waitForExistence(timeout: 8)); row.tap()
        let fold = app.buttons["file-json-fold:root"]
        XCTAssertTrue(fold.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["frames: 60"].exists)
        fold.tap(); XCTAssertFalse(app.staticTexts["frames: 60"].exists)
        fold.tap(); XCTAssertTrue(app.staticTexts["frames: 60"].exists)
        attachUIScreenshot(app, "Foldable JSON")
    }
    @MainActor func testChatChecksFileLinksAndOpensVideo() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture", "--chat-file-links"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8)); app.tabBars.buttons["Agents"].tap()
        let host = app.buttons["live-host:A1000000-0000-0000-0000-000000000001"]
        for _ in 0..<14 { if host.exists && host.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(host.waitForExistence(timeout: 8)); host.tap()
        let chat = app.buttons["live-chat:w7:w7:t9"]
        XCTAssertTrue(chat.waitForExistence(timeout: 8)); chat.tap()
        let video = app.links["video/render.mp4"]
        XCTAssertTrue(video.waitForExistence(timeout: 10))
        XCTAssertFalse(app.links["missing.xyz"].exists)
        video.tap()
        XCTAssertTrue(app.buttons["file-media-play"].waitForExistence(timeout: 15))
    }

}
