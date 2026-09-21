#if DEBUG
import PhrenKit
import SwiftUI

struct PhrenControlsFixture: View {
    private static let pages = ["switches", "options", "segments", "fields", "navigation", "presentations"]
    @State private var page: Int
    @State private var enabled = true
    @State private var choice = "list"
    @State private var choices: Set<String> = ["list"]
    @State private var number = 2
    @State private var hour = 7
    @State private var minute = 30
    @State private var minutes = 360
    @State private var date = Date(timeIntervalSince1970: 1_790_006_400)
    @State private var code = "Review open work.\nSummarize the next steps."
    @State private var search = ""
    @State private var scope = "all"
    @State private var days: Set<Schedule.Weekday> = [.mon, .wed, .fri]
    @State private var sheet: Bool
    @State private var dialog: Bool
    @State private var multiSelect = false
    @State private var result = "No action"
    private let longPresentation: Bool

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        func argument(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        _page = State(initialValue: Self.pages.firstIndex(of: argument("--controls-page") ?? "switches") ?? 0)
        let presentation = argument("--controls-presentation") ?? ""
        _sheet = State(initialValue: presentation == "sheet" || presentation == "long-sheet")
        _dialog = State(initialValue: presentation == "dialog" || presentation == "long-dialog")
        longPresentation = presentation.hasPrefix("long-")
    }

    private var chipOptions: [PhrenOption<String>] {
        [.init(id: "all", value: "all", title: "All")] + ["phren", "ledger", "hub", "atlas", "mina", "orders-service", "web"].map {
            PhrenOption(id: $0, value: $0, title: $0)
        }
    }

    private var options: [PhrenOption<String>] {
        [
            .init(id: "list", value: "list", title: "List", caption: "Read files one at a time", icon: "list.bullet"),
            .init(id: "diff", value: "diff", title: "Diff", caption: "See everything that changed", icon: "rectangle.split.2x1"),
            .init(id: "unavailable", value: "unavailable", title: "Unavailable", caption: "Connect Desk to continue", isEnabled: false),
        ]
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                PhrenIconButton(icon: "chevron.left", label: "Previous controls") { page -= 1 }
                    .disabled(page == 0).phrenIdentifier("controls-previous")
                Text("Control kit · \(Self.pages[page])")
                    .font(PhrenTypography.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity)
                PhrenIconButton(icon: "chevron.right", label: "Next controls") { page += 1 }
                    .disabled(page == Self.pages.count - 1).phrenIdentifier("controls-next")
            }
            .padding(.horizontal, 8)
            PhrenScreen {
                pageContent
                Text("End of \(Self.pages[page])").font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .phrenIdentifier("controls-end")
            }
            .id(page).phrenIdentifier("controls-scroll")
        }
        .foregroundStyle(PhrenTheme.text).background(PhrenTheme.bg)
        .phrenContainerMarker("controls-fixture", label: "Control kit")
        .phrenActionSheet(isPresented: $sheet, title: "Session actions", actions: sheetActions, identifier: "controls-sheet")
        .phrenDialog(isPresented: $dialog, title: "Delete schedule?",
                     message: longPresentation ? String(repeating: "This removes the scheduled prompt from the store. ", count: 20)
                        : "This removes the scheduled prompt from the store.",
                     actions: dialogActions, identifier: "controls-dialog")
        .phrenMultiSelectSheet(isPresented: $multiSelect, title: "Options", options: options,
                               selection: $choices, rowPrefix: "controls-multiselect")
    }

    @ViewBuilder private var pageContent: some View {
        switch Self.pages[page] {
        case "switches": switches
        case "options": optionRows
        case "segments": segments
        case "fields": fields
        case "navigation": navigation
        default: presentations
        }
    }

    private var switches: some View {
        PhrenGroup("Switches", identifier: "controls-group:switches") {
            PhrenRow(icon: "clock", title: "Interactive", chevron: false) {
                PhrenSwitch(isOn: $enabled, label: "Interactive switch").phrenIdentifier("controls-switch:live")
            }
            switchRow("On", id: "on", on: true, disabled: false)
            switchRow("Off", id: "off", on: false, disabled: false)
            switchRow("Disabled on", id: "disabled-on", on: true, disabled: true)
            switchRow("Disabled off", id: "disabled-off", on: false, disabled: true)
        }
    }

    private func switchRow(_ label: String, id: String, on: Bool, disabled: Bool) -> some View {
        PhrenRow(icon: "power", title: label, chevron: false) {
            PhrenSwitch(isOn: .constant(on), label: label).disabled(disabled)
                .phrenIdentifier("controls-switch:\(id)")
        }
    }

    private var optionRows: some View {
        Group {
            PhrenGroup("Single choice", identifier: "controls-group:single") {
                PhrenOptionGroup(options: options, selection: $choice, identifier: "controls-single")
                PhrenOptionRow(title: "Disabled selected", selected: true, disabled: true) {}
                    .phrenIdentifier("controls-radio:disabled-selected")
            }
            PhrenGroup("Multiple choices", identifier: "controls-group:multi") {
                PhrenMultiOptionGroup(options: options, selection: $choices, identifier: "controls-multi")
                PhrenOptionRow(title: "Disabled selected", selected: true, mark: .check, disabled: true) {}
                    .phrenIdentifier("controls-check:disabled-selected")
            }
            PhrenGroup("Drop-down", identifier: "controls-group:multiselect") {
                PhrenMultiSelect(options: options, selection: $choices, allLabel: "All options",
                                 identifier: "controls-multiselect", isPresented: $multiSelect)
                PhrenMultiSelect(options: options, selection: .constant(["list"]), allLabel: "All options",
                                 identifier: "controls-multiselect-disabled", isPresented: .constant(false))
                    .disabled(true)
            }
            PhrenGroup("Glyph and detail", identifier: "controls-group:glyph") {
                PhrenOptionRow(title: "A long option name that wraps without losing the provider or caption",
                               caption: "A longer explanation stays readable at the largest accessibility size.",
                               glyph: AnyView(AgentProviderGlyph(source: "codex", size: 18)),
                               trailing: AnyView(PhrenChip(text: "default"))) {}
                    .phrenIdentifier("controls-option:glyph")
                ChatQuestionOptionRow(label: "Preview", detail: "The chat adapter keeps its preview", preview: "pnpm build", selected: true) {}
                    .phrenIdentifier("controls-option:preview")
            }
        }
    }

    private var segments: some View {
        Group {
            PhrenGroup("Text segments", identifier: "controls-group:segments") {
                PhrenTextSegment(items: options, selection: $choice, identifier: "controls-segment")
                PhrenTextSegment(items: options, selection: .constant("diff"), identifier: "controls-segment-disabled")
                    .disabled(true)
                PhrenTextSegment(items: [.init(id: "long", value: "long", title: "A segment with a long translated title"),
                                         .init(id: "short", value: "short", title: "Short")],
                                 selection: .constant("long"), identifier: "controls-segment-long")
            }
            PhrenGroup("Icon segments and chips", identifier: "controls-group:icons") {
                PhrenIconSegment(items: [.init(value: "list", icon: "list.bullet", label: "List"),
                                         .init(value: "diff", icon: "rectangle.split.2x1", label: "Diff")], selection: $choice)
                    .phrenIdentifier("controls-icon-segment")
                PhrenDayChips(days: $days).phrenIdentifier("controls-days")
            }
            PhrenGroup("Chip rows", identifier: "controls-group:chips") {
                PhrenChipRow(items: chipOptions, selection: $scope, identifier: "controls-chips",
                             tint: { $0 == "all" ? PhrenTheme.accent : PhrenTheme.sessionProject })
                PhrenChipRow(items: options, selection: .constant("diff"), identifier: "controls-chips-disabled").disabled(true)
                PhrenChipRow(items: chipOptions, selection: .constant("ledger"), identifier: "controls-chips-wrapped", wraps: true)
                    .padding(PhrenTheme.Space.small).background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium))
            }
        }
    }

    private var fields: some View {
        Group {
            PhrenGroup("Numbers", identifier: "controls-group:numbers") {
                PhrenStepperField(title: "Connections", value: $number, range: 0...4, identifier: "controls-stepper")
                PhrenStepperField(title: "Minimum", value: .constant(0), range: 0...4, identifier: "controls-stepper-min")
                PhrenStepperField(title: "Maximum", value: .constant(4), range: 0...4, identifier: "controls-stepper-max")
                PhrenStepperField(title: "Disabled", value: .constant(2), range: 0...4, identifier: "controls-stepper-disabled").disabled(true)
            }
            PhrenGroup("Search", identifier: "controls-group:search") {
                PhrenSearchField(text: $search, placeholder: "Search memory", identifier: "controls-search")
                PhrenSearchField(text: .constant("offline cache"), placeholder: "Search memory", identifier: "controls-search-filled")
                PhrenSearchField(text: .constant(""), placeholder: "Search memory", identifier: "controls-search-disabled").disabled(true)
            }
            PhrenGroup("Time and text", identifier: "controls-group:fields") {
                PhrenTimeField(hour: $hour, minute: $minute).phrenIdentifier("controls-time")
                PhrenDurationField(minutes: $minutes).phrenIdentifier("controls-duration")
                PhrenDateField(date: $date).phrenIdentifier("controls-date")
                PhrenCodeField(text: $code, placeholder: "Prompt").phrenIdentifier("controls-code")
                PhrenTimeField(hour: .constant(7), minute: .constant(30)).disabled(true)
                    .phrenIdentifier("controls-time-disabled")
                PhrenDurationField(minutes: .constant(360)).disabled(true).phrenIdentifier("controls-duration-disabled")
                PhrenDateField(date: .constant(date)).disabled(true).phrenIdentifier("controls-date-disabled")
                PhrenCodeField(text: .constant("Unavailable prompt"), placeholder: "Prompt").disabled(true)
                    .phrenIdentifier("controls-code-disabled")
            }
        }
    }

    private var navigation: some View {
        Group {
            PhrenGroup("Navigation rows", identifier: "controls-group:rows") {
                Button { result = "Opened schedules" } label: {
                    PhrenRow(icon: "clock", title: "Schedules") { Text("2 · 07:30") }
                }.buttonStyle(.plain).phrenIdentifier("controls-row:normal")
                Button {} label: { PhrenRow(icon: "folder", title: "Unavailable project") }
                    .buttonStyle(.plain).disabled(true).phrenIdentifier("controls-row:disabled")
                PhrenRow(icon: "desktopcomputer", title: "A computer with a long display name", chevron: false) {
                    Text("Last connected yesterday")
                }.phrenIdentifier("controls-row:metadata")
            }
            PhrenGroup("Icon actions", identifier: "controls-group:buttons") {
                HStack {
                    PhrenIconButton(icon: "ellipsis", label: "Actions") { sheet = true }.phrenIdentifier("controls-icon:normal")
                    PhrenIconButton(icon: "trash", label: "Delete", destructive: true) { dialog = true }.phrenIdentifier("controls-icon:destructive")
                    PhrenIconButton(icon: "ellipsis", label: "Unavailable") {}.disabled(true).phrenIdentifier("controls-icon:disabled")
                    PhrenIconButton(icon: "trash", label: "Unavailable delete", destructive: true) {}.disabled(true)
                        .phrenIdentifier("controls-icon:disabled-destructive")
                }
            }
            PhrenGroup("Card list", identifier: "controls-group:cards") {
                LazyVStack(spacing: 6) {
                    Text("Sessions").plainListSectionLabel()
                    Text("Desk · Review open work").font(PhrenTypography.body)
                        .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).sessionCard()
                }
            }
        }
    }

    private var presentations: some View {
        PhrenGroup("Presentations", identifier: "controls-group:presentations") {
            Button { sheet = true } label: { PhrenRow(icon: "ellipsis", title: "Open action sheet") }
                .buttonStyle(.plain).phrenIdentifier("controls-open-sheet")
            Button { dialog = true } label: { PhrenRow(icon: "trash", title: "Open dialog") }
                .buttonStyle(.plain).phrenIdentifier("controls-open-dialog")
            Text(result).font(PhrenTypography.caption).phrenIdentifier("controls-result")
        }
    }

    private var sheetActions: [PhrenControlAction] {
        let actions: [PhrenControlAction] = [
            .init(id: "open", title: "Open session", icon: "bubble.left", caption: "Continue on Desk") { result = "Opened session" },
            .init(id: "selected", title: "List", icon: "list.bullet", isSelected: choice == "list", dismisses: false) { choice = "list" },
            .init(id: "choice", title: "Diff", icon: "rectangle.split.2x1", isSelected: choice == "diff", dismisses: false) { choice = "diff" },
            .init(id: "disabled", title: "Offline", icon: "desktopcomputer", isEnabled: false) { result = "Unexpected action" },
            .init(id: "disabled-selected", title: "Disabled selected", isEnabled: false, isSelected: true) {},
            .init(id: "disabled-delete", title: "Delete unavailable", icon: "trash", role: .destructive, isEnabled: false) {},
            .init(id: "delete", title: "Delete schedule", icon: "trash", role: .destructive) { dialog = true },
        ]
        return actions + (longPresentation ? (0..<20).map { index in
            PhrenControlAction(id: "extra-\(index)", title: "Additional action \(index)", caption: "A wrapping caption for a long action sheet") {}
        } : [])
    }

    private var dialogActions: [PhrenControlAction] {
        [
            .init(id: "delete", title: "Delete", role: .destructive) { result = "Deleted" },
            .init(id: "unavailable", title: "Unavailable", isEnabled: false) {},
            .init(id: "keep", title: "Keep", role: .cancel) { result = "Kept" },
        ]
    }
}
#endif
