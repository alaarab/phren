import Network
import XCTest

final class WebServersTests: XCTestCase {
    @MainActor
    func testCompactServerListAndBrowserNavigation() throws {
        let first = try WebPageFixture(port: 19473, name: "Phone app")
        let second = try WebPageFixture(port: 19474, name: "Dashboard app")
        defer { first.stop(); second.stop() }
        let app = launch()
        app.buttons["all-web-servers"].tap()
        let row = app.buttons["web-server:A1000000-0000-0000-0000-000000000001:19473"]
        let other = app.buttons["web-server:A1000000-0000-0000-0000-000000000001:19474"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(other.isHittable)
        XCTAssertLessThan(row.frame.height, 85, "Server rows should stay compact")
        row.tap()
        XCTAssertTrue(app.webViews.staticTexts["Phone app loaded"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.keyboards.count, 0)
        app.webViews.links["Next page"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 10), "Reconnect keeps the current page")
        XCTAssertTrue(app.buttons["Previous page"].isEnabled)
        app.buttons["Previous page"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Phone app loaded"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(other.waitForExistence(timeout: 5))
        other.tap()
        XCTAssertTrue(app.webViews.staticTexts["Dashboard app loaded"].waitForExistence(timeout: 10))
        attachUIScreenshot(app, "Web app browser")
        app.buttons["Done"].tap()
        app.navigationBars["Web servers"].buttons.firstMatch.tap()
        app.buttons["live-host:A1000000-0000-0000-0000-000000000001"].tap()
        XCTAssertTrue(app.buttons["host-web-servers"].waitForExistence(timeout: 5))
        app.buttons["host-web-servers"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        attachUIScreenshot(app, "Compact web servers on a computer")
    }

    @MainActor
    func testEmptyAndOfflineListsOfferUsefulStatus() {
        let empty = launch(extra: "--web-servers-empty")
        empty.buttons["all-web-servers"].tap()
        XCTAssertTrue(empty.staticTexts["No web servers running"].waitForExistence(timeout: 10))
        empty.terminate()
        let offline = launch(extra: "--web-servers-offline")
        offline.buttons["all-web-servers"].tap()
        XCTAssertTrue(offline.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "connection timed out")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(offline.buttons["Connection settings"].exists)
        XCTAssertTrue(offline.buttons["Refresh web servers"].exists)
    }

    @MainActor
    private func launch(extra: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--web-servers-fixture"] + (extra.map { [$0] } ?? [])
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
        app.tabBars.buttons["Agents"].tap()
        XCTAssertTrue(app.buttons["all-web-servers"].waitForExistence(timeout: 5))
        return app
    }
}

private final class WebPageFixture {
    let listener: NWListener
    init(port: UInt16, name: String) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                let request = String(decoding: data ?? Data(), as: UTF8.self)
                let js = request.hasPrefix("GET /asset.js ")
                let next = request.hasPrefix("GET /next ")
                let body = js ? "document.getElementById('status').textContent='\(name) loaded';" : """
                <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
                <style>body{font:20px system-ui;padding:24px;background:#fff;color:#202020}a{display:block;padding:20px 0}</style>
                <h1>\(next ? "Second page" : name)</h1><p id="status">Loading asset</p><a href="/next">Next page</a><script src="/asset.js"></script>
                """
                let response = "HTTP/1.1 200 OK\r\nContent-Type: \(js ? "application/javascript" : "text/html")\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        listener.start(queue: .global())
    }
    func stop() { listener.cancel() }
}
