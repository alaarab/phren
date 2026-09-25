import XCTest
@testable import Phren

final class ControlsKitTests: XCTestCase {
    private let options: [PhrenOption<String?>] = [
        .init(id: "inherit", value: nil, title: "Inherit global"),
        .init(id: "low", value: "low", title: "Low"),
        .init(id: "high", value: "high", title: "High"),
        .init(id: "disabled", value: "disabled", title: "Unavailable", isEnabled: false),
    ]

    func testSingleChoiceSupportsInheritanceAndDoesNotToggleOff() {
        let selected = PhrenOptionSelection.single("high", in: options, current: nil)
        XCTAssertEqual(selected, "high")
        XCTAssertEqual(PhrenOptionSelection.single("high", in: options, current: selected), "high")
        XCTAssertNil(PhrenOptionSelection.single(nil, in: options, current: selected))
    }

    func testUnavailableOrRemovedOptionsPreserveCurrentSelection() {
        for value in ["disabled", "removed"] {
            XCTAssertEqual(PhrenOptionSelection.single(value, in: options, current: "low"), "low")
            XCTAssertEqual(PhrenOptionSelection.multiple(value, in: options, current: ["low"]), ["low"])
        }
        // A stale value can be displayed until the user chooses a supported replacement.
        XCTAssertEqual(PhrenOptionSelection.single("low", in: options, current: "removed"), "low")
    }

    func testMultipleChoiceTogglesOnlyTheRequestedMember() {
        let initial: Set<String?> = ["low", "disabled"]
        let added = PhrenOptionSelection.multiple("high", in: options, current: initial)
        XCTAssertEqual(added, ["low", "high", "disabled"])
        let removed = PhrenOptionSelection.multiple("low", in: options, current: added)
        XCTAssertEqual(removed, ["high", "disabled"])
        XCTAssertEqual(PhrenOptionSelection.multiple("disabled", in: options, current: removed), removed)
        XCTAssertEqual(PhrenOptionSelection.multiple("high", in: options, current: ["high"]), [])
    }

    func testActionDismissesBeforeInvokingTheHandler() {
        var events: [String] = []
        let action = PhrenActionSheet.Action(id: "open", title: "Open") { events.append("handler") }
        action.perform { events.append("dismiss") }
        XCTAssertEqual(events, ["dismiss", "handler"])
    }

    func testDisabledActionCannotDismissOrRunAndChoiceCanStayOpen() {
        var calls = 0
        var dismissals = 0
        let disabled = PhrenActionSheet.Action(id: "disabled", title: "Offline", isEnabled: false) { calls += 1 }
        disabled.perform { dismissals += 1 }
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(dismissals, 0)

        let choice = PhrenActionSheet.Action(id: "selected", title: "List", isSelected: true, dismisses: false) { calls += 1 }
        choice.perform { dismissals += 1 }
        XCTAssertEqual(choice.isSelected, true)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(dismissals, 0)
    }
}
