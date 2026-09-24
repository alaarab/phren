import XCTest
@testable import Phren

final class ReleaseNotesStoreTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "release-notes-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testSeenIsPerBuildNotPerVersion() throws {
        try XCTSkipIf(AppRuntime.isUITesting || ReleaseNotesStore.current?.isEmpty ?? true, "Needs bundled notes for this version")
        let defaults = defaults()
        XCTAssertTrue(ReleaseNotesStore.shouldPresent(defaults: defaults), "A fresh install shows the notes")
        // The old marker held the marketing version alone, which every
        // TestFlight build shares: it must count as unseen for this build.
        defaults.set(ReleaseNotesStore.version, forKey: ReleaseNotesStore.seenVersionKey)
        XCTAssertTrue(ReleaseNotesStore.shouldPresent(defaults: defaults), "A marker without the build number is not this build")
        ReleaseNotesStore.markSeen(defaults: defaults)
        XCTAssertFalse(ReleaseNotesStore.shouldPresent(defaults: defaults))
        XCTAssertTrue(defaults.string(forKey: ReleaseNotesStore.seenVersionKey)?.contains(ReleaseNotesStore.build) == true)
    }
}
