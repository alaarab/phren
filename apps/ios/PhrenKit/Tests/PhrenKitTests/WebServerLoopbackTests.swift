import XCTest
@testable import PhrenKit

final class WebServerLoopbackTests: XCTestCase {
    func testLoopbackLinksNameTheServerOnTheAgentsComputer() throws {
        let vite = try XCTUnwrap(WebServer.loopback(URL(string: "http://localhost:5173/admin?tab=2")!))
        XCTAssertEqual(vite.port, 5173); XCTAssertEqual(vite.loopbackHost, "127.0.0.1"); XCTAssertEqual(vite.scheme, "http")
        XCTAssertEqual(WebServer.loopback(URL(string: "http://127.0.0.1:8000")!)?.port, 8000)
        XCTAssertEqual(WebServer.loopback(URL(string: "http://0.0.0.0:3000/")!)?.port, 3000)
        XCTAssertEqual(WebServer.loopback(URL(string: "http://[::1]:4000/")!)?.loopbackHost, "::1")
        XCTAssertEqual(WebServer.loopback(URL(string: "http://localhost/")!)?.port, 80)
    }

    func testOtherLinksAreNotLocal() {
        for link in ["https://example.com:5173/", "http://192.168.1.4:3000/", "file:///tmp/a.html", "http://user:pw@localhost:3000/", "ftp://localhost:21/"] {
            XCTAssertNil(WebServer.loopback(URL(string: link)!), link)
        }
    }
}
