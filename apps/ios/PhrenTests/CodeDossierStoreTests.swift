import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class CodeDossierStoreTests: XCTestCase {
    private enum Recorded: Error { case request }

    func testProjectDossierKeepsItsStoreWithoutAChatOrigin() async throws {
        let dossier = CodeSymbolDossier(storeId: "sam/team", project: "demo", symbol: "src/app.ts::run", hosts: [])
        XCTAssertNil(dossier.origin)
        var reads = 0
        do {
            _ = try await dossier.requests.definition { project, symbol, storeID in
                XCTAssertEqual(storeID, "sam/team")
                XCTAssertEqual(project, "demo")
                XCTAssertEqual(symbol, "src/app.ts::run")
                reads += 1
                throw Recorded.request
            }
            XCTFail("Expected the recording reader to stop the request")
        } catch Recorded.request { }
        do {
            _ = try await dossier.requests.references { project, symbol, storeID in
                XCTAssertEqual(storeID, "sam/team")
                XCTAssertEqual(project, "demo")
                XCTAssertEqual(symbol, "src/app.ts::run")
                reads += 1
                throw Recorded.request
            }
            XCTFail("Expected the recording reader to stop the request")
        } catch Recorded.request { }
        XCTAssertEqual(reads, 2)

        let note = dossier.requests.note(file: "src/app.ts", line: 2, text: "Check cancellation", target: nil)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(note)) as? [String: Any])
        XCTAssertEqual(body["store"] as? String, "sam/team")
        XCTAssertEqual(body["project"] as? String, "demo")
        XCTAssertEqual(body["symbol"] as? String, "src/app.ts::run")
    }
}
