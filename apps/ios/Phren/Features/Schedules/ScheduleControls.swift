import Foundation
import PhrenKit
import SwiftUI

struct PhrenTimeField: View {
    @Binding private var isValid: Bool
    @Binding private var hour: Int
    @Binding private var minute: Int
    @State private var hourText: String
    @State private var minuteText: String
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case hour, minute }

    init(hour: Binding<Int>, minute: Binding<Int>, isValid: Binding<Bool> = .constant(true)) {
        _isValid = isValid
        _hour = hour
        _minute = minute
        _hourText = State(initialValue: ScheduleFieldText.twoDigits(hour.wrappedValue))
        _minuteText = State(initialValue: ScheduleFieldText.twoDigits(minute.wrappedValue))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            HStack(spacing: PhrenTheme.Space.xs) {
                numberField("Hour", text: $hourText, field: .hour)
                Text(":")
                    .font(PhrenTypography.monoSubheadline)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityHidden(true)
                numberField("Minute", text: $minuteText, field: .minute)
            }
            .padding(.horizontal, PhrenTheme.Space.medium)
            .frame(minHeight: 44)
            .background(PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))

            if validationMessage != nil {
                validationError("Enter a valid time")
            }
        }
        .onChange(of: focusedField) { previous, current in
            if previous != nil, previous != current { commit() }
        }
        .onChange(of: hour) { _, value in
            if focusedField != .hour { hourText = ScheduleFieldText.twoDigits(value) }
        }
        .onChange(of: minute) { _, value in
            if focusedField != .minute { minuteText = ScheduleFieldText.twoDigits(value) }
        }
        .onChange(of: hourText + ":" + minuteText, initial: true) { _, _ in
            isValid = validationMessage == nil
            if isValid {
                hour = Int(hourText) ?? hour
                minute = Int(minuteText) ?? minute
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Time")
    }

    private func numberField(_ label: String, text: Binding<String>, field: Field) -> some View {
        TextField("00", text: text)
            .scheduleNumberField(label: label)
            .focused($focusedField, equals: field)
            .onChange(of: text.wrappedValue) { _, value in
                let filtered = ScheduleFieldText.digits(value, limit: 2)
                if filtered != value { text.wrappedValue = filtered }
            }
    }

    private var validationMessage: String? {
        guard let hour = Int(hourText), (0...23).contains(hour),
              let minute = Int(minuteText), (0...59).contains(minute) else { return "invalid" }
        return nil
    }

    private func commit() {
        let nextHour = min(23, max(0, Int(hourText) ?? hour))
        let nextMinute = min(59, max(0, Int(minuteText) ?? minute))
        hour = nextHour
        minute = nextMinute
        hourText = ScheduleFieldText.twoDigits(nextHour)
        minuteText = ScheduleFieldText.twoDigits(nextMinute)
    }

}

struct PhrenDurationField: View {
    @Binding private var isValid: Bool
    @Binding private var minutes: Int
    @State private var amountText: String
    @State private var unit: Unit
    @FocusState private var amountFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Unit: CaseIterable, Hashable {
        case minutes, hours, days

        var multiplier: Int {
            switch self {
            case .minutes: return 1
            case .hours: return 60
            case .days: return 1_440
            }
        }

        var label: String {
            switch self {
            case .minutes: return "min"
            case .hours: return "h"
            case .days: return "d"
            }
        }

        var accessibilityLabel: String {
            switch self {
            case .minutes: return "Minutes"
            case .hours: return "Hours"
            case .days: return "Days"
            }
        }
    }

    init(minutes: Binding<Int>, isValid: Binding<Bool> = .constant(true)) {
        _isValid = isValid
        _minutes = minutes
        let value = Self.parts(for: minutes.wrappedValue)
        _amountText = State(initialValue: String(value.amount))
        _unit = State(initialValue: value.unit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            HStack(spacing: PhrenTheme.Space.xs) {
                TextField("6", text: $amountText)
                    .font(PhrenTypography.monoSubheadline.monospacedDigit())
                    .foregroundStyle(PhrenTheme.text)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .textFieldStyle(.plain)
                    .frame(width: 54, height: 44)
                    .focused($amountFocused)
                    .accessibilityLabel("Interval amount")
                    .onChange(of: amountText) { _, value in
                        let filtered = String(value.filter(\.isNumber).prefix(8))
                        if filtered != value { amountText = filtered }
                    }

                HStack(spacing: PhrenTheme.Space.xs) {
                    ForEach(Unit.allCases, id: \.self) { candidate in
                        Button {
                            select(candidate)
                        } label: {
                            Text(candidate.label)
                                .font(PhrenTypography.caption.weight(.semibold))
                                .foregroundStyle(unit == candidate ? PhrenTheme.onAccent : PhrenTheme.textSecondary)
                                .frame(minWidth: 40, minHeight: 40)
                                .background(unit == candidate ? PhrenTheme.accentSolid : .clear, in: Capsule())
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .frame(minWidth: 44, minHeight: 44)
                        .buttonStyle(.plain)
                        .accessibilityLabel(candidate.accessibilityLabel)
                        .accessibilityAddTraits(unit == candidate ? .isSelected : [])
                    }
                }
            }
            .padding(.horizontal, PhrenTheme.Space.small)
            .frame(minHeight: 44)
            .background(PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: unit)

            if let validationMessage {
                validationError(validationMessage)
            }
        }
        .onChange(of: amountFocused) { wasFocused, isFocused in
            if wasFocused, !isFocused { commit() }
        }
        .onChange(of: minutes) { _, value in
            guard !amountFocused else { return }
            let parts = Self.parts(for: value)
            unit = parts.unit
            amountText = String(parts.amount)
        }
        .onChange(of: amountText + unit.label, initial: true) { _, _ in
            isValid = validationMessage == nil
            if isValid, let value = enteredMinutes { minutes = value }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Interval")
    }

    private var enteredMinutes: Int? {
        guard let amount = Int(amountText), amount > 0 else { return nil }
        let product = amount.multipliedReportingOverflow(by: unit.multiplier)
        return product.overflow ? nil : product.partialValue
    }

    private var validationMessage: String? {
        guard let enteredMinutes else { return "Enter a valid interval" }
        return enteredMinutes < 5 ? "Interval must be at least 5 minutes" : nil
    }

    private func select(_ nextUnit: Unit) {
        let amount = max(1, Int(amountText) ?? max(1, minutes / unit.multiplier))
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
            unit = nextUnit
            minutes = max(5, amount * nextUnit.multiplier)
            amountText = String(amount)
        }
    }

    private func commit() {
        let amount = max(1, Int(amountText) ?? max(1, minutes / unit.multiplier))
        let product = amount.multipliedReportingOverflow(by: unit.multiplier)
        minutes = product.overflow ? minutes : max(5, product.partialValue)
        amountText = String(max(1, minutes / unit.multiplier))
    }

    private static func parts(for minutes: Int) -> (amount: Int, unit: Unit) {
        let value = max(5, minutes)
        if value.isMultiple(of: 1_440) { return (value / 1_440, .days) }
        if value.isMultiple(of: 60) { return (value / 60, .hours) }
        return (value, .minutes)
    }
}

struct PhrenDateField: View {
    @Binding private var isValid: Bool
    @Binding private var date: Date
    @State private var dateText: String
    @State private var hourText: String
    @State private var minuteText: String
    @FocusState private var focusedField: Field?
    private var calendar: Calendar

    private enum Field: Hashable { case date, hour, minute }

    init(date: Binding<Date>, isValid: Binding<Bool> = .constant(true)) {
        _isValid = isValid
        _date = date
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = .current
        self.calendar = calendar
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date.wrappedValue)
        _dateText = State(initialValue: Self.dateString(components))
        _hourText = State(initialValue: ScheduleFieldText.twoDigits(components.hour ?? 0))
        _minuteText = State(initialValue: ScheduleFieldText.twoDigits(components.minute ?? 0))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
            HStack(spacing: PhrenTheme.Space.xs) {
                TextField("YYYY-MM-DD", text: $dateText)
                    .font(PhrenTypography.monoSubheadline.monospacedDigit())
                    .foregroundStyle(PhrenTheme.text)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .textFieldStyle(.plain)
                    .frame(minWidth: 112, minHeight: 44)
                    .focused($focusedField, equals: .date)
                    .accessibilityLabel("Date")
                    .onChange(of: dateText) { _, value in
                        let formatted = Self.editingDate(value)
                        if formatted != value { dateText = formatted }
                    }

                TextField("00", text: $hourText)
                    .scheduleNumberField(label: "Hour")
                    .focused($focusedField, equals: .hour)
                    .onChange(of: hourText) { _, value in
                        let filtered = ScheduleFieldText.digits(value, limit: 2)
                        if filtered != value { hourText = filtered }
                    }
                Text(":")
                    .font(PhrenTypography.monoSubheadline)
                    .foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityHidden(true)
                TextField("00", text: $minuteText)
                    .scheduleNumberField(label: "Minute")
                    .focused($focusedField, equals: .minute)
                    .onChange(of: minuteText) { _, value in
                        let filtered = ScheduleFieldText.digits(value, limit: 2)
                        if filtered != value { minuteText = filtered }
                    }
            }
            .padding(.horizontal, PhrenTheme.Space.small)
            .frame(minHeight: 44)
            .background(PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))

            if validationMessage != nil {
                validationError("Enter a valid date and time")
            }
        }
        .onChange(of: focusedField) { previous, current in
            if previous != nil, previous != current { commit() }
        }
        .onChange(of: date) { _, value in
            guard focusedField == nil else { return }
            synchronize(with: value)
        }
        .onChange(of: dateText + hourText + minuteText, initial: true) { _, _ in
            let parsed = resolvedDate(clamping: false)
            isValid = parsed != nil
            if let parsed { date = parsed }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Date and time")
    }

    private var validationMessage: String? {
        resolvedDate(clamping: false) == nil ? "invalid" : nil
    }

    private func commit() {
        guard let nextDate = resolvedDate(clamping: true) else {
            synchronize(with: date)
            return
        }
        date = nextDate
        synchronize(with: nextDate)
    }

    private func synchronize(with value: Date) {
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: value)
        dateText = Self.dateString(components)
        hourText = ScheduleFieldText.twoDigits(components.hour ?? 0)
        minuteText = ScheduleFieldText.twoDigits(components.minute ?? 0)
    }

    private func resolvedDate(clamping: Bool) -> Date? {
        let digits = dateText.filter(\.isNumber)
        guard digits.count == 8,
              var year = Int(digits.prefix(4)),
              var month = Int(digits.dropFirst(4).prefix(2)),
              var day = Int(digits.suffix(2)),
              var hour = Int(hourText), var minute = Int(minuteText) else { return nil }

        if clamping {
            year = min(9_999, max(1, year))
            month = min(12, max(1, month))
            hour = min(23, max(0, hour))
            minute = min(59, max(0, minute))
            var first = DateComponents()
            first.calendar = calendar
            first.timeZone = calendar.timeZone
            first.year = year
            first.month = month
            first.day = 1
            guard let firstDay = calendar.date(from: first),
                  let range = calendar.range(of: .day, in: .month, for: firstDay) else { return nil }
            day = min(range.count, max(1, day))
        } else if !(1...9_999).contains(year) || !(1...12).contains(month)
                    || !(0...23).contains(hour) || !(0...59).contains(minute) {
            return nil
        }

        var components = DateComponents()
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = 0
        guard let result = calendar.date(from: components) else { return nil }
        if !clamping {
            let check = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: result)
            guard check.year == year, check.month == month, check.day == day,
                  check.hour == hour, check.minute == minute else { return nil }
        }
        return result
    }

    private static func editingDate(_ value: String) -> String {
        let digits = String(value.filter(\.isNumber).prefix(8))
        var result = String(digits.prefix(4))
        if digits.count > 4 { result += "-" + String(digits.dropFirst(4).prefix(2)) }
        if digits.count > 6 { result += "-" + String(digits.dropFirst(6).prefix(2)) }
        return result
    }

    private static func dateString(_ components: DateComponents) -> String {
        String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

}

struct PhrenCodeField: View {
    @Binding var text: String
    let placeholder: String

    var body: some View {
        TextField(placeholder, text: $text, axis: .vertical)
            .font(PhrenTypography.monoSubheadline)
            .foregroundStyle(PhrenTheme.text)
            .textFieldStyle(.plain)
            .lineLimit(1...12)
            .padding(PhrenTheme.Space.large)
            .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
            .background(PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
            .accessibilityLabel(placeholder)
    }
}

struct PhrenDayChips: View {
    @Binding var days: Set<Schedule.Weekday>
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScheduleChipFlow(spacing: PhrenTheme.Space.small) {
            ForEach(Schedule.Weekday.allCases, id: \.self) { day in
                let selected = days.contains(day)
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                        if selected { days.remove(day) } else { days.insert(day) }
                    }
                } label: {
                    Text(ScheduleWords.shortDay(day))
                        .font(PhrenTypography.caption.weight(.semibold))
                        .foregroundStyle(selected ? PhrenTheme.onAccent : PhrenTheme.textSecondary)
                        .frame(minWidth: 40, minHeight: 40)
                        .background(selected ? PhrenTheme.accentSolid : PhrenTheme.surfaceRaised, in: Capsule())
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .frame(minWidth: 44, minHeight: 44)
                .buttonStyle(.plain)
                .accessibilityLabel(Self.accessibilityLabel(for: day))
                .accessibilityIdentifier("schedule-day:\(day.rawValue)")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
    }

    private static func accessibilityLabel(for day: Schedule.Weekday) -> String {
        switch day {
        case .mon: return "Monday"
        case .tue: return "Tuesday"
        case .wed: return "Wednesday"
        case .thu: return "Thursday"
        case .fri: return "Friday"
        case .sat: return "Saturday"
        case .sun: return "Sunday"
        }
    }


}

struct ScheduleChipFlow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maximumWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: maximumWidth.isFinite ? maximumWidth : nil, height: nil))
            if x > 0, x + size.width > maximumWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        let width = maximumWidth.isFinite ? maximumWidth : max(0, x - spacing)
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

private extension View {
    func scheduleNumberField(label: String) -> some View {
        font(PhrenTypography.monoSubheadline.monospacedDigit())
            .foregroundStyle(PhrenTheme.text)
            .keyboardType(.numberPad)
            .multilineTextAlignment(.center)
            .textFieldStyle(.plain)
            .frame(width: 44, height: 44)
            .accessibilityLabel(label)
    }
}

@ViewBuilder
private func validationError(_ message: String) -> some View {
    Text(message)
        .font(PhrenTypography.caption)
        .foregroundStyle(PhrenTheme.danger)
        .fixedSize(horizontal: false, vertical: true)
}

private enum ScheduleFieldText {
    static func twoDigits(_ value: Int) -> String { String(format: "%02d", value) }
    static func digits(_ value: String, limit: Int) -> String { String(value.filter(\.isNumber).prefix(limit)) }
}
