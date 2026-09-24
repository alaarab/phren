import Foundation
import XCTest
@testable import PhrenKit

final class WebServersTests: XCTestCase {
    func testSnapshotUsesStableOriginsAndDoesNotExposeOtherNetworkDestinations() throws {
        let data = Data(#"{"servers":[{"id":"server_9","name":"App","port":5173,"origin":"http://127.0.0.1:5173","process":"node"},{"id":"server_1","name":"Duplicate","port":5173,"origin":"http://127.0.0.1:5173"},{"name":"Error response","port":3000,"origin":"http://localhost:3000"},{"port":24543,"origin":"http://user:secret@127.0.0.1:24543"},{"port":22,"origin":"ssh://127.0.0.1:22"},{"port":1234,"origin":"http://other-computer:1234"},{"port":0,"origin":"http://127.0.0.1:0"},{"port":3001,"origin":"http://127.0.0.1:3002"}]}"#.utf8)
        let servers = try WebServer.readSnapshot(data)
        XCTAssertEqual(servers.map(\.port), [3000, 5173])
        XCTAssertEqual(servers[0].displayName, "Web server on port 3000")
        XCTAssertEqual(servers[1].detail, "node · Port 5173")
        let reordered = try WebServer.readSnapshot(Data(#"{"servers":[{"id":"server_1","name":"App","port":5173,"origin":"http://127.0.0.1:5173","process":"node"}]}"#.utf8))
        XCTAssertEqual(servers[1], reordered[0])
    }

    func testMissingServerFieldIsAnUnsupportedSnapshotInsteadOfAnEmptyList() throws {
        XCTAssertThrowsError(try WebServer.readSnapshot(Data(#"{"workspaces":[]}"#.utf8)))
        XCTAssertEqual(try WebServer.readSnapshot(Data(#"{"servers":[]}"#.utf8)), [])
        XCTAssertThrowsError(try WebServer.readSnapshot(Data(repeating: 32, count: 1_048_577)))
    }
}
