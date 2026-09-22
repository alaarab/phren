import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class ProjectsModelTests: XCTestCase {
    private func project(_ name: String, store: String = "sample/brain") -> StoreProject {
        StoreProject(storeId: store, storeName: store, project: Project(name: name))
    }

    /// The grid's list is derived once per input change, not once per body.
    func testFilteredListComputesOncePerInputChange() {
        let model = ProjectsModel()
        let merged = [project("atlas"), project("billing"), project("atlas-two", store: "other/brain")]
        let writable = [merged[1]]
        let key = ProjectsModel.Key(stores: [.init(id: "sample/brain", revision: UUID(), name: "sample/brain")],
                                    storeFilter: nil, filter: "at", writable: writable.map(\.id))

        model.update(key: key, merged: merged, writable: writable)
        XCTAssertEqual(model.projects.map(\.project.name), ["atlas", "atlas-two"])
        XCTAssertEqual(model.count, 2)
        XCTAssertEqual(model.voiceCaptureTargets.map(\.project), ["billing"])
        XCTAssertEqual(model.computationCount, 1)

        model.update(key: key, merged: merged, writable: writable)
        XCTAssertEqual(model.computationCount, 1, "The same key must reuse the derived list")

        model.filter = "bill"
        let next = ProjectsModel.Key(stores: key.stores, storeFilter: nil, filter: model.filter, writable: key.writable)
        model.update(key: next, merged: merged, writable: writable)
        XCTAssertEqual(model.projects.map(\.project.name), ["billing"])
        XCTAssertEqual(model.computationCount, 2, "A filter change recomputes once")
    }

    func testStoreEmptinessTracksTheWholeListNotTheFilter() {
        let model = ProjectsModel()
        let key = ProjectsModel.Key(stores: [], storeFilter: nil, filter: "zzz", writable: [])
        model.update(key: key, merged: [project("atlas")], writable: [])
        XCTAssertTrue(model.projects.isEmpty)
        XCTAssertFalse(model.storeIsEmpty, "An unmatched filter is not an empty store")

        let emptyKey = ProjectsModel.Key(stores: [], storeFilter: nil, filter: "zzz", writable: ["x"])
        model.update(key: emptyKey, merged: [], writable: [])
        XCTAssertTrue(model.storeIsEmpty)
    }
}
