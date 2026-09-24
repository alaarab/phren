import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class LiveSessionPreferencesStoreTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suiteName = "LiveSessionPreferencesStoreTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// Counts decodes so the test sees work the shared memo would hide.
    private func store(counting count: @escaping () -> Void) -> LiveSessionPreferencesStore {
        LiveSessionPreferencesStore(defaults: defaults) { data in
            count()
            return try LiveSessionPreferences.read(data)
        }
    }

    func testDecodesOncePerChangeNotPerRead() throws {
        let host = try LiveHost(name: "Desk", address: "desk.invalid", username: "sam")
        defaults.set(try LiveSessionPreferences.saving(host, in: Data()), forKey: LiveSessionPreferencesStore.key)
        var decodes = 0
        let store = store { decodes += 1 }
        XCTAssertEqual(decodes, 1)
        for _ in 0..<50 {
            XCTAssertEqual(store.hosts.map(\.name), ["Desk"])
            XCTAssertNotNil(store.preferences)
        }
        XCTAssertEqual(decodes, 1, "Reads never decode again")

        // An unrelated key changing in the same defaults leaves the bytes alone.
        defaults.set(true, forKey: "unrelated.setting")
        store.reload()
        XCTAssertEqual(decodes, 1)
    }

    func testWritesThroughToDefaultsAndDecodesTheNewBytesOnce() throws {
        var decodes = 0
        let store = store { decodes += 1 }
        XCTAssertEqual(decodes, 1)
        XCTAssertEqual(store.hosts, [])

        let host = try LiveHost(name: "Desk", address: "desk.invalid", username: "sam")
        try store.update { try LiveSessionPreferences.saving(host, in: $0) }
        XCTAssertEqual(decodes, 2)
        XCTAssertEqual(store.hosts.map(\.id), [host.id])
        // Same key, same defaults: the widget and every @AppStorage reader see it.
        let stored = try XCTUnwrap(defaults.data(forKey: LiveSessionPreferencesStore.key))
        XCTAssertEqual(stored, store.data)
        XCTAssertEqual(try LiveSessionPreferences.read(stored).hosts.map(\.id), [host.id])
        // The defaults change notification for the store's own write decodes nothing more.
        XCTAssertEqual(decodes, 2)

        // The binding writes through the same way.
        store.binding.wrappedValue = try LiveSessionPreferences.setPinned(
            true, for: LiveAgentSession.ID(hostID: host.id, workspace: "w1", tab: "w1:t1"),
            in: store.data)
        XCTAssertEqual(decodes, 3)
        XCTAssertEqual(defaults.data(forKey: LiveSessionPreferencesStore.key), store.data)
    }

    func testPicksUpAWriteMadeElsewhere() throws {
        var decodes = 0
        let store = store { decodes += 1 }
        let host = try LiveHost(name: "Laptop", address: "laptop.invalid", username: "sam")
        // What an @AppStorage writer elsewhere in the app does.
        defaults.set(try LiveSessionPreferences.saving(host, in: Data()), forKey: LiveSessionPreferencesStore.key)
        XCTAssertEqual(store.hosts.map(\.name), ["Laptop"])
        XCTAssertEqual(decodes, 2)
    }

    func testAFailedEditChangesNothingAndUnreadableBytesReadAsNil() throws {
        let store = store {}
        let before = store.data
        struct Refused: Error {}
        XCTAssertThrowsError(try store.update { _ in throw Refused() })
        XCTAssertEqual(store.data, before)
        XCTAssertNil(defaults.data(forKey: LiveSessionPreferencesStore.key))

        defaults.set(Data("not json".utf8), forKey: LiveSessionPreferencesStore.key)
        XCTAssertNil(store.preferences)
        XCTAssertNotNil(store.readError)
        XCTAssertEqual(store.hosts, [])
    }
}
