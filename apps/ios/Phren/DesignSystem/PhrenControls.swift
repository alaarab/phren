import SwiftUI

extension View {
    func phrenIdentifier(_ identifier: String) -> some View {
        accessibilityIdentifier(identifier)
    }

    /// Names a container for UI tests without hiding its children's ids: an
    /// identifier on the container itself would replace theirs (a modal's
    /// scroller, a screen's rows), so it goes on a zero-size marker instead.
    func phrenContainerMarker(_ identifier: String, label: String, value: String? = nil) -> some View {
        overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement().accessibilityLabel(label)
                .accessibilityValue(value ?? "")
                .accessibilityIdentifier(identifier)
        }
    }
}

struct PhrenSwitch: View {
    @Binding var isOn: Bool
    var label: String
    private var rowContent: AnyView?
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(isOn: Binding<Bool>, label: String = "Enabled") {
        _isOn = isOn; self.label = label
    }

    init(_ title: String, isOn: Binding<Bool>) {
        _isOn = isOn; label = title; rowContent = AnyView(Text(title))
    }

    init(_ title: String, systemImage: String, isOn: Binding<Bool>) {
        _isOn = isOn; label = title
        rowContent = AnyView(Label(title, systemImage: systemImage))
    }

    init<Content: View>(isOn: Binding<Bool>, @ViewBuilder label: () -> Content) {
        _isOn = isOn; self.label = ""; rowContent = AnyView(label())
    }

    var body: some View {
        if rowContent == nil { switchButton.accessibilityLabel(label) }
        else { switchButton }
    }

    private var switchButton: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { isOn.toggle() }
        } label: {
            HStack(spacing: PhrenTheme.Space.medium) {
                if let rowContent {
                    rowContent.foregroundStyle(PhrenTheme.text)
                    Spacer(minLength: PhrenTheme.Space.small)
                }
                ZStack {
                    Capsule().fill(isOn ? PhrenTheme.accentSolid : PhrenTheme.surfaceRaised)
                        .frame(width: 44, height: 26)
                    Circle().fill(PhrenTheme.onAccent).frame(width: 22, height: 22)
                        .offset(x: isOn ? 9 : -9)
                }
                .frame(width: 44, height: 44).accessibilityHidden(true)
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityElement(children: .combine)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(.isToggle)
    }
}

struct PhrenOption<Value: Hashable>: Identifiable {
    let id: String
    let value: Value
    let title: String
    var caption: String? = nil
    var icon: String? = nil
    /// A custom leading view (a provider mark, a host color dot).
    var glyph: AnyView? = nil
    /// A passive trailing badge, such as the model catalogue's "default" chip.
    var trailing: AnyView? = nil
    /// A listed choice that is not currently available, such as an offline computer.
    var muted = false
    var accessibilityLabel: String? = nil
    var isEnabled = true
}

enum PhrenOptionSelection {
    static func single<Value: Hashable>(_ value: Value, in options: [PhrenOption<Value>], current: Value) -> Value {
        options.contains { $0.value == value && $0.isEnabled } ? value : current
    }

    static func multiple<Value: Hashable>(_ value: Value, in options: [PhrenOption<Value>], current: Set<Value>) -> Set<Value> {
        guard options.contains(where: { $0.value == value && $0.isEnabled }) else { return current }
        var result = current
        if !result.insert(value).inserted { result.remove(value) }
        return result
    }
}

struct PhrenOptionRow: View {
    enum Mark: Equatable { case radio, check }
    let title: String
    var caption: String? = nil
    var selected = false
    var mark: Mark = .radio
    var disabled = false
    var icon: String? = nil
    var glyph: AnyView? = nil
    var trailing: AnyView? = nil
    /// Content below the text, such as a code preview. It is drawn inside the
    /// row's background but outside its Button, so a scroller in it scrolls.
    var detail: AnyView? = nil
    var radius = PhrenTheme.Radius.questionOption
    var minimumHeight: CGFloat = 44
    /// A choice that is listed but not currently available, such as an offline computer.
    var muted = false
    /// A hairline around the unselected row, for rows drawn on a card.
    var outlined = false
    /// Supporting text color; chat questions use `textSecondary`.
    var captionColor: Color = PhrenTheme.textMuted
    /// Spoken value, for text the row's label cannot carry (a scrolled preview).
    var value: String? = nil
    /// The row Button's identifier. UI tests also get `<id>:row` and
    /// `<id>:title` frame markers so layout can be asserted.
    var identifier: String? = nil
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// A passive trailing caption ("offline", "default") for the `trailing` slot.
    static func trailingCaption(_ text: String) -> some View {
        Text(text).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
    }

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }
    private var fill: Color { selected ? PhrenTheme.cyan.opacity(0.1) : PhrenTheme.surfaceRaised }
    private var stroke: Color { selected ? PhrenTheme.cyan.opacity(0.5) : outlined ? PhrenTheme.borderStrong : .clear }
    private var markers: Bool { identifier != nil && AppRuntime.isUITesting }
    /// Where the text starts: padding, the mark, and a glyph when there is one.
    private var textInset: CGFloat { PhrenTheme.Space.medium + 32 + (glyph != nil || icon != nil ? 32 : 0) }

    var body: some View {
        Group {
            if let detail {
                VStack(alignment: .leading, spacing: 0) {
                    button(bottomPadding: PhrenTheme.Space.small, background: false)
                    detail
                        .padding(.leading, textInset)
                        .padding([.trailing, .bottom], PhrenTheme.Space.medium)
                }
                .fixedSize(horizontal: false, vertical: true)
                .background(fill, in: shape)
                .overlay(shape.stroke(stroke, lineWidth: 1))
            } else {
                button(bottomPadding: PhrenTheme.Space.medium, background: true)
            }
        }
        .disabled(disabled)
        .opacity(disabled || !isEnabled ? 0.45 : 1)
        // Behind the row, so the markers never cover the Button for hit tests.
        .backgroundPreferenceValue(PhrenOptionTitleBounds.self) { anchor in
            if markers, let identifier {
                GeometryReader { geometry in
                    ZStack(alignment: .topLeading) {
                        Color.clear.accessibilityElement().accessibilityIdentifier("\(identifier):row")
                        if let anchor {
                            let bounds = geometry[anchor]
                            Color.clear.frame(width: bounds.width, height: bounds.height)
                                .offset(x: bounds.minX, y: bounds.minY)
                                .accessibilityElement().accessibilityIdentifier("\(identifier):title")
                        }
                    }
                }
                .allowsHitTesting(false)
            }
        }
    }

    private func button(bottomPadding: CGFloat, background: Bool) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? (mark == .check ? "checkmark.square.fill" : "checkmark.circle.fill")
                      : (mark == .check ? "square" : "circle"))
                    .resizable().scaledToFit().frame(width: 18, height: 18)
                    .foregroundStyle(selected ? PhrenTheme.cyan : PhrenTheme.textDim)
                    .frame(width: 22).padding(.top, 1).accessibilityHidden(true)
                if let glyph {
                    glyph.frame(width: 22).accessibilityHidden(true)
                } else if let icon {
                    Image(systemName: icon).resizable().scaledToFit().frame(width: 18, height: 18).frame(width: 22)
                        .foregroundStyle(PhrenTheme.textSecondary).accessibilityHidden(true)
                }
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
                layout {
                    VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                        Text(title).foregroundStyle(muted ? PhrenTheme.textMuted : PhrenTheme.text)
                            .anchorPreference(key: PhrenOptionTitleBounds.self, value: .bounds) { $0 }
                        if let caption, !caption.isEmpty {
                            Text(caption).font(PhrenTypography.caption).foregroundStyle(captionColor)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let trailing { trailing }
                }
            }
            .font(PhrenTypography.body)
            .padding(.horizontal, PhrenTheme.Space.medium)
            .padding(.top, PhrenTheme.Space.medium)
            .padding(.bottom, bottomPadding)
            .frame(maxWidth: .infinity, minHeight: max(44, minimumHeight), alignment: .leading)
            // Never squeezed below its text: a compressed row drew its radio
            // and title above the background and its caption below it.
            .fixedSize(horizontal: false, vertical: true)
            .background(background ? fill : .clear, in: shape)
            .overlay(shape.stroke(background ? stroke : .clear, lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .modifier(PhrenOptionAccessibility(value: value, identifier: identifier))
    }
}

private struct PhrenOptionTitleBounds: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

private struct PhrenOptionAccessibility: ViewModifier {
    let value: String?
    let identifier: String?
    func body(content: Content) -> some View {
        switch (value, identifier) {
        case let (value?, identifier?): content.accessibilityValue(value).accessibilityIdentifier(identifier)
        case let (value?, nil): content.accessibilityValue(value)
        case let (nil, identifier?): content.accessibilityIdentifier(identifier)
        case (nil, nil): content
        }
    }
}

struct PhrenOptionGroup<Value: Hashable>: View {
    let options: [PhrenOption<Value>]
    @Binding var selection: Value
    let identifier: String

    var body: some View {
        VStack(spacing: PhrenTheme.Space.small) {
            ForEach(options) { option in
                PhrenOptionRow(title: option.title, caption: option.caption, selected: selection == option.value,
                               disabled: !option.isEnabled, icon: option.icon) {
                    selection = PhrenOptionSelection.single(option.value, in: options, current: selection)
                }
                .phrenIdentifier("\(identifier):\(option.id)")
            }
        }
        .accessibilityElement(children: .contain)
    }
}

struct PhrenMultiOptionGroup<Value: Hashable>: View {
    let options: [PhrenOption<Value>]
    @Binding var selection: Set<Value>
    let identifier: String

    var body: some View {
        VStack(spacing: PhrenTheme.Space.small) {
            ForEach(options) { option in
                PhrenOptionRow(title: option.title, caption: option.caption, selected: selection.contains(option.value),
                               mark: .check, disabled: !option.isEnabled, icon: option.icon) {
                    selection = PhrenOptionSelection.multiple(option.value, in: options, current: selection)
                }
                .phrenIdentifier("\(identifier):\(option.id)")
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// A drop-down filter: a 44-point pill that summarises the chosen values and
/// opens a PhrenDialog-styled card of check rows. The owner presents the card
/// at the screen root with `.phrenMultiSelectSheet`, the same contract as
/// `phrenActionSheet` and `phrenDialog`, so its scrim covers the screen.
/// An empty selection reads as the `allLabel`; `requiresSelection` keeps the
/// card from clearing its last member.
struct PhrenMultiSelect<Value: Hashable>: View {
    let options: [PhrenOption<Value>]
    @Binding var selection: Set<Value>
    /// The pill's label when nothing or everything is chosen.
    let allLabel: String
    let identifier: String
    @Binding var isPresented: Bool
    @Environment(\.isEnabled) private var isEnabled

    private var chosen: [PhrenOption<Value>] { options.filter { selection.contains($0.value) } }

    private var summary: String {
        if chosen.isEmpty || chosen.count == options.count { return allLabel }
        return chosen.map(\.title).joined(separator: ", ")
    }

    var body: some View {
        Button { isPresented = true } label: {
            HStack(spacing: PhrenTheme.Space.xs) {
                Text(summary).font(PhrenTypography.subheadline.weight(.medium))
                    .lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(PhrenTypography.icon(9, weight: .semibold)).accessibilityHidden(true)
            }
            .foregroundStyle(isEnabled ? PhrenTheme.text : PhrenTheme.textMuted)
            .padding(.horizontal, PhrenTheme.Space.medium)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(PhrenTheme.surfaceRaised, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityLabel(allLabel)
        .accessibilityValue(summary)
        .phrenIdentifier(identifier)
    }
}

/// Shared selection rules keep filtering independent of chips and bulk changes.
enum PhrenMultiSelection {
    static func filtered<Value>(_ options: [PhrenOption<Value>], query: String) -> [PhrenOption<Value>] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return options.filter { option in
            words.allSatisfy { (option.title + " " + (option.caption ?? "")).localizedStandardContains($0) }
        }
    }

    static func chosen<Value>(_ options: [PhrenOption<Value>], selection: Set<Value>) -> [PhrenOption<Value>] {
        options.filter { selection.contains($0.value) }
    }

    static func toggle<Value>(_ value: Value, options: [PhrenOption<Value>], selection: Set<Value>,
                              requiresSelection: Bool) -> Set<Value> {
        let next = PhrenOptionSelection.multiple(value, in: options, current: selection)
        return requiresSelection && chosen(options, selection: next).isEmpty ? selection : next
    }

    static func all<Value>(_ options: [PhrenOption<Value>], selection: Set<Value>) -> Set<Value> {
        selection.union(options.filter(\.isEnabled).map(\.value))
    }

    static func none<Value>(_ options: [PhrenOption<Value>], selection: Set<Value>,
                            requiresSelection: Bool) -> Set<Value> {
        let next = selection.subtracting(options.filter(\.isEnabled).map(\.value))
        return requiresSelection && chosen(options, selection: next).isEmpty ? selection : next
    }
}

/// Content-sized filter card. Search and selected chips stay above the list;
/// only overflowing options scroll. Existing row and dismissal IDs are stable.
struct PhrenMultiSelectSheet<Value: Hashable>: View {
    let title: String
    let options: [PhrenOption<Value>]
    @Binding var selection: Set<Value>
    let rowPrefix: String
    var requiresSelection = false
    var leading: AnyView? = nil
    let dismiss: () -> Void
    @State private var query = ""
    @AccessibilityFocusState private var titleFocused: Bool

    private var chosen: [PhrenOption<Value>] { PhrenMultiSelection.chosen(options, selection: selection) }
    private var matches: [PhrenOption<Value>] { PhrenMultiSelection.filtered(options, query: query) }
    private var all: Set<Value> { PhrenMultiSelection.all(options, selection: selection) }
    private var none: Set<Value> {
        PhrenMultiSelection.none(options, selection: selection, requiresSelection: requiresSelection)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.medium) {
            Text(title).font(PhrenTypography.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
            HStack(spacing: PhrenTheme.Space.xs) {
                if options.count > 8 {
                    PhrenSearchField(text: $query, identifier: "\(rowPrefix)-search")
                } else {
                    Spacer(minLength: 0)
                }
                bulkButton("All", id: "all", disabled: all == selection) { selection = all }
                bulkButton("None", id: "none", disabled: none == selection) { selection = none }
            }
            if !chosen.isEmpty { chips }
            ViewThatFits(in: .vertical) {
                rows.fixedSize(horizontal: false, vertical: true)
                ScrollView { rows }.scrollBounceBehavior(.basedOnSize)
                    .scrollDismissesKeyboard(.interactively)
                    .phrenContainerMarker("\(rowPrefix)-scroll", label: "Options")
            }
            Button(action: dismiss) {
                Text("Done (\(chosen.count))").font(PhrenTypography.body.weight(.medium))
                    .foregroundStyle(PhrenTheme.accent)
                    .padding(.horizontal, PhrenTheme.Space.medium)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(PhrenTheme.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).phrenIdentifier("\(rowPrefix)-done")
        }
        .padding(PhrenTheme.Space.large)
        .frame(maxWidth: 360)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .clipShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, dismiss)
        .phrenContainerMarker("\(rowPrefix)-sheet", label: title)
        .onAppear { titleFocused = true }
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: PhrenTheme.Space.small) {
                ForEach(chosen) { option in
                    Button { toggle(option) } label: {
                        HStack(spacing: 6) {
                            Text(option.title).font(PhrenTypography.caption.weight(.medium))
                            Image(systemName: "xmark").font(PhrenTypography.icon(10, weight: .semibold))
                                .accessibilityHidden(true)
                        }
                        .foregroundStyle(PhrenTheme.cyan).padding(.horizontal, 10).padding(.vertical, 6)
                        .background(PhrenTheme.cyan.opacity(0.1), in: Capsule())
                        .overlay(Capsule().strokeBorder(PhrenTheme.cyan.opacity(0.5), lineWidth: 1))
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!option.isEnabled || (requiresSelection && chosen.count == 1))
                    .opacity(option.isEnabled && !(requiresSelection && chosen.count == 1) ? 1 : 0.45)
                    .accessibilityLabel("Remove \(option.title)")
                    .phrenIdentifier("\(rowPrefix)-chip:\(option.id)")
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var rows: some View {
        VStack(spacing: PhrenTheme.Space.xs) {
            if let leading { leading }
            if matches.isEmpty {
                Text("No matches").font(PhrenTypography.subheadline).foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, minHeight: 40)
            }
            ForEach(matches) { option in
                let selected = selection.contains(option.value)
                Button { toggle(option) } label: {
                    HStack(spacing: PhrenTheme.Space.small) {
                        if let icon = option.icon {
                            Image(systemName: icon).font(PhrenTypography.icon(14))
                                .foregroundStyle(PhrenTheme.textMuted).frame(width: 16).accessibilityHidden(true)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.title).font(PhrenTypography.subheadline)
                            if let caption = option.caption {
                                Text(caption).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "checkmark").font(PhrenTypography.icon(12, weight: .semibold))
                            .foregroundStyle(PhrenTheme.cyan).opacity(selected ? 1 : 0).accessibilityHidden(true)
                    }
                    .foregroundStyle(PhrenTheme.text)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                    .background(selected ? PhrenTheme.cyan.opacity(0.1) : PhrenTheme.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                    .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption)
                        .strokeBorder(selected ? PhrenTheme.cyan.opacity(0.5) : .clear, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!option.isEnabled).opacity(option.isEnabled ? 1 : 0.45)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .phrenIdentifier("\(rowPrefix):\(option.id)")
            }
        }
    }

    private func bulkButton(_ title: String, id: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(PhrenTypography.caption.weight(.semibold))
                .foregroundStyle(PhrenTheme.accent).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.45 : 1)
        .phrenIdentifier("\(rowPrefix)-\(id)")
    }

    private func toggle(_ option: PhrenOption<Value>) {
        selection = PhrenMultiSelection.toggle(option.value, options: options, selection: selection,
                                               requiresSelection: requiresSelection)
    }
}

private struct PhrenMultiSelectModifier<Value: Hashable>: ViewModifier {
    @Binding var isPresented: Bool
    let title: String
    let options: [PhrenOption<Value>]
    @Binding var selection: Set<Value>
    let rowPrefix: String
    let requiresSelection: Bool
    let leading: AnyView?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(!isPresented).accessibilityHidden(isPresented)
            .overlay {
                if isPresented {
                    GeometryReader { geometry in
                        ZStack {
                            Color.black.opacity(0.5).ignoresSafeArea().contentShape(Rectangle())
                                .onTapGesture { isPresented = false }
                                .accessibilityHidden(true)
                            PhrenMultiSelectSheet(title: title, options: options, selection: $selection,
                                                  rowPrefix: rowPrefix, requiresSelection: requiresSelection,
                                                  leading: leading, dismiss: { isPresented = false })
                                .frame(maxWidth: 360, maxHeight: max(44, min(600, geometry.size.height * 0.85)))
                                .padding(PhrenTheme.Space.large)
                                .transition(.opacity)
                        }
                        .frame(width: geometry.size.width, height: geometry.size.height)
                    }
                    .zIndex(1)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isPresented)
    }
}

extension View {
    func phrenMultiSelectSheet<Value: Hashable>(isPresented: Binding<Bool>, title: String,
                                                options: [PhrenOption<Value>], selection: Binding<Set<Value>>,
                                                rowPrefix: String, requiresSelection: Bool = false,
                                                leading: AnyView? = nil) -> some View {
        modifier(PhrenMultiSelectModifier(isPresented: isPresented, title: title, options: options,
                                          selection: selection, rowPrefix: rowPrefix,
                                          requiresSelection: requiresSelection, leading: leading))
    }
}

/// The single-choice sibling of `PhrenMultiSelect`: the same 44-point pill
/// that summarises the chosen option and opens a PhrenDialog-styled card of
/// check rows. Tapping a row closes the card. The owner presents the card at
/// the screen root with `.phrenSingleSelectSheet`, the same contract as
/// `phrenMultiSelectSheet`, so its scrim covers the screen.
struct PhrenSingleSelect<Value: Hashable>: View {
    let options: [PhrenOption<Value>]
    @Binding var selection: Value
    /// Shown when the selection names no option (including the empty start).
    var placeholder: String
    let identifier: String
    @Binding var isPresented: Bool
    @Environment(\.isEnabled) private var isEnabled

    private var chosen: PhrenOption<Value>? { options.first { $0.value == selection } }
    private var summary: String { chosen?.title ?? placeholder }

    var body: some View {
        Button { isPresented = true } label: {
            HStack(spacing: PhrenTheme.Space.xs) {
                Text(summary).font(PhrenTypography.subheadline.weight(.medium))
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(chosen == nil ? PhrenTheme.textMuted : PhrenTheme.text)
                Image(systemName: "chevron.down")
                    .font(PhrenTypography.icon(9, weight: .semibold)).accessibilityHidden(true)
            }
            .foregroundStyle(isEnabled ? PhrenTheme.text : PhrenTheme.textMuted)
            .padding(.horizontal, PhrenTheme.Space.medium)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(PhrenTheme.surfaceRaised, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityLabel(placeholder)
        .accessibilityValue(summary)
        .phrenIdentifier(identifier)
    }
}

/// The card `PhrenSingleSelect` opens: one check `PhrenOptionRow` per option
/// and a Done row. A row choice commits and dismisses. While `loading` is
/// true the rows are replaced by one muted row. `message` carries a listed
/// but unavailable note (an offline computer); `footer` an owner control
/// below the options (the chat picker's custom id field). Rows identify as
/// `rowPrefix:option.id`; Done is `rowPrefix-done`; the loading row is
/// `loadingIdentifier` when one is given, else `rowPrefix-loading`.
struct PhrenSingleSelectSheet<Value: Hashable>: View {
    let title: String
    let options: [PhrenOption<Value>]
    @Binding var selection: Value
    let rowPrefix: String
    var loading = false
    var loadingLabel = "Loading…"
    var loadingIdentifier: String? = nil
    var message: String? = nil
    var footer: AnyView? = nil
    /// Runs after the selection is set, before the card dismisses.
    var onSelect: ((Value) -> Void)? = nil
    var dismissOnSelect = true
    let dismiss: () -> Void
    @AccessibilityFocusState private var titleFocused: Bool
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.medium) {
            Text(title).font(PhrenTypography.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
            // Footer and Close ride inside the scroll content: at the medium
            // detent, five rows plus Dynamic Type must never clip them away.
            ScrollView {
                VStack(spacing: PhrenTheme.Space.small) {
                    if loading {
                        PhrenOptionRow(title: loadingLabel, disabled: true, muted: true) {}
                            .phrenIdentifier(loadingIdentifier ?? "\(rowPrefix)-loading")
                    } else {
                        if let message {
                            PhrenOptionRow(title: message, disabled: true, muted: true) {}
                                .phrenIdentifier("\(rowPrefix)-message")
                        }
                        ForEach(options) { option in
                            // One choice: a radio mark, and the sheet closes on the tap.
                            PhrenOptionRow(title: option.title, caption: option.caption,
                                           selected: selection == option.value, mark: .radio,
                                           disabled: !option.isEnabled, icon: option.icon,
                                           glyph: option.glyph, trailing: option.trailing,
                                           muted: option.muted) {
                                select(option)
                            }
                            .phrenIdentifier("\(rowPrefix):\(option.id)")
                        }
                    }
                    if let footer { footer }
                    // A single choice needs no Done; the row itself closes the sheet.
                    // The button stays for cancelling with nothing chosen, labelled so.
                    Button(action: dismiss) {
                        Text(selection == nil ? "Cancel" : "Close").font(PhrenTypography.body.weight(.medium))
                            .foregroundStyle(PhrenTheme.accent)
                            .padding(.horizontal, PhrenTheme.Space.medium)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(PhrenTheme.surfaceRaised,
                                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).phrenIdentifier("\(rowPrefix)-done")
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            // A ScrollView takes every point offered: cap it at its rows so a
            // short list sizes the card instead of trailing empty space.
            .frame(maxHeight: contentHeight > 0 ? contentHeight : nil)
            .scrollBounceBehavior(.basedOnSize)
        }
        .padding(PhrenTheme.Space.large)
        .frame(maxWidth: 360)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .clipShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, dismiss)
        .phrenContainerMarker("\(rowPrefix)-sheet", label: title)
        .onAppear { titleFocused = true }
    }

    private func select(_ option: PhrenOption<Value>) {
        guard option.isEnabled else { return }
        selection = PhrenOptionSelection.single(option.value, in: options, current: selection)
        onSelect?(option.value)
        if dismissOnSelect { dismiss() }
    }
}

private struct PhrenSingleSelectModifier<Value: Hashable>: ViewModifier {
    @Binding var isPresented: Bool
    let title: String
    let options: [PhrenOption<Value>]
    @Binding var selection: Value
    let rowPrefix: String
    let loading: Bool
    let loadingLabel: String
    let message: String?
    let footer: AnyView?
    let onSelect: ((Value) -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(!isPresented).accessibilityHidden(isPresented)
            .overlay {
                if isPresented {
                    GeometryReader { geometry in
                        ZStack {
                            Color.black.opacity(0.5).ignoresSafeArea().contentShape(Rectangle())
                                .onTapGesture { isPresented = false }
                                .accessibilityHidden(true)
                            PhrenSingleSelectSheet(title: title, options: options, selection: $selection,
                                                   rowPrefix: rowPrefix, loading: loading,
                                                   loadingLabel: loadingLabel, message: message,
                                                   footer: footer, onSelect: onSelect,
                                                   dismiss: { isPresented = false })
                                .frame(maxWidth: 360, maxHeight: max(44, geometry.size.height - 32))
                                .padding(PhrenTheme.Space.large)
                                .transition(.opacity)
                        }
                        .frame(width: geometry.size.width, height: geometry.size.height)
                    }
                    .zIndex(1)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isPresented)
    }
}

extension View {
    func phrenSingleSelectSheet<Value: Hashable>(isPresented: Binding<Bool>, title: String,
                                                 options: [PhrenOption<Value>], selection: Binding<Value>,
                                                 rowPrefix: String, loading: Bool = false,
                                                 loadingLabel: String = "Loading…", message: String? = nil,
                                                 footer: AnyView? = nil,
                                                 onSelect: ((Value) -> Void)? = nil) -> some View {
        modifier(PhrenSingleSelectModifier(isPresented: isPresented, title: title, options: options,
                                           selection: selection, rowPrefix: rowPrefix, loading: loading,
                                           loadingLabel: loadingLabel, message: message, footer: footer,
                                           onSelect: onSelect))
    }
}

/// A color swatch opens the shared color editor at the owning screen root.
struct PhrenColorButton: View {
    let title: String
    let color: Color
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: PhrenTheme.Space.small) {
                Circle().fill(color).frame(width: 28, height: 28)
                    .overlay(Circle().strokeBorder(PhrenTheme.border, lineWidth: 1))
                    .accessibilityHidden(true)
                Text(title).font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
            }
            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).phrenIdentifier(identifier)
    }
}

private struct PhrenColorChannels: View {
    @Binding var selection: Color
    let identifier: String

    private var channels: [Int] {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(selection).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [red, green, blue].map { Int((min(1, max(0, $0)) * 255).rounded()) }
    }

    private func channel(_ index: Int) -> Binding<Int> {
        Binding(get: { channels[index] }, set: { value in
            var next = channels
            next[index] = min(255, max(0, value))
            selection = Color(.sRGB, red: Double(next[0]) / 255,
                              green: Double(next[1]) / 255, blue: Double(next[2]) / 255, opacity: 1)
        })
    }

    var body: some View {
        VStack(spacing: PhrenTheme.Space.medium) {
            RoundedRectangle(cornerRadius: PhrenTheme.Radius.small).fill(selection)
                .frame(height: 44).accessibilityHidden(true)
            PhrenStepperField(title: "Red", value: channel(0), range: 0...255, identifier: "\(identifier):red")
            PhrenStepperField(title: "Green", value: channel(1), range: 0...255, identifier: "\(identifier):green")
            PhrenStepperField(title: "Blue", value: channel(2), range: 0...255, identifier: "\(identifier):blue")
        }
    }
}

extension View {
    /// RGB edits apply immediately, like the adjacent hex field. Every opaque
    /// color remains available without presenting system color controls.
    func phrenColorSheet(isPresented: Binding<Bool>, title: String, selection: Binding<Color>,
                         identifier: String) -> some View {
        phrenSingleSelectSheet(isPresented: isPresented, title: title,
                                options: [PhrenOption<Color>](), selection: selection, rowPrefix: identifier,
                                footer: AnyView(PhrenColorChannels(selection: selection, identifier: identifier)))
    }
}

struct PhrenTextSegment<Value: Hashable>: View {
    let items: [PhrenOption<Value>]
    @Binding var selection: Value
    let identifier: String
    /// Inside a field that already draws its own surface (the duration unit), the pills sit bare.
    var bare = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) { pills }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) { pills }.fixedSize(horizontal: true, vertical: true)
                    VStack(alignment: .leading, spacing: 4) { pills }
                }
            }
        }
        .padding(bare ? 0 : 2)
        .background(bare ? .clear : PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .accessibilityElement(children: .contain)
    }

    private var pills: some View {
        ForEach(items) { item in
            let selected = item.value == selection
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    selection = PhrenOptionSelection.single(item.value, in: items, current: selection)
                }
            } label: {
                HStack(spacing: 6) {
                    if let icon = item.icon { Image(systemName: icon).accessibilityHidden(true) }
                    Text(item.title).fixedSize(horizontal: false, vertical: true)
                }
                .font(PhrenTypography.subheadline.weight(.medium))
                .foregroundStyle(selected ? PhrenTheme.accent : PhrenTheme.textMuted)
                .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, PhrenTheme.Space.xs)
                .frame(minWidth: 44, minHeight: 44)
                .background(selected ? PhrenTheme.accent.opacity(0.16) : .clear, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain).disabled(!item.isEnabled)
            .opacity(isEnabled && item.isEnabled ? 1 : 0.45)
            .accessibilityLabel(item.accessibilityLabel ?? item.title)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .phrenIdentifier("\(identifier):\(item.id)")
        }
    }
}

struct PhrenIconButton: View {
    let icon: String
    let label: String
    var destructive = false
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: icon).resizable().scaledToFit().frame(width: 18, height: 18)
                .foregroundStyle(destructive ? PhrenTheme.danger : PhrenTheme.accent)
                .frame(width: 32, height: 32)
                .background(PhrenTheme.surfaceRaised, in: Circle())
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).opacity(isEnabled ? 1 : 0.45)
        .accessibilityLabel(label)
    }
}

struct PhrenControlAction: Identifiable {
    enum Role: Equatable { case normal, destructive, cancel }
    let id: String
    let title: String
    var icon: String? = nil
    var iconColor: Color? = nil
    var caption: String? = nil
    var role: Role = .normal
    var isEnabled = true
    var isSelected: Bool? = nil
    var dismisses = true
    /// Preserve a pre-existing control identifier when migrating a native action.
    var accessibilityIdentifier: String? = nil
    let handler: () -> Void

    // Dismiss before callbacks so an action can present the next surface.
    func perform(dismiss: () -> Void) {
        guard isEnabled else { return }
        if dismisses { dismiss() }
        handler()
    }
}

struct PhrenActionSheet: View {
    typealias Action = PhrenControlAction
    let title: String
    let actions: [Action]
    let identifier: String
    let dismiss: () -> Void
    var searchPlaceholder: String? = nil
    @State private var query = ""
    @State private var drag: CGFloat = 0
    @AccessibilityFocusState private var titleFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                Capsule().fill(PhrenTheme.textDim).frame(width: 32, height: 4).padding(.top, 8)
                    .accessibilityHidden(true)
                HStack(spacing: 8) {
                    Text(title).font(PhrenTypography.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
                    Spacer(minLength: 0)
                    PhrenIconButton(icon: "xmark", label: "Close \(title)", action: dismiss)
                        .phrenIdentifier("\(identifier):close")
                }
                .padding(.leading, 16).padding(.trailing, 6).frame(minHeight: 48)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 8)
                .onChanged { if !reduceMotion { drag = max(0, $0.translation.height) } }
                .onEnded { value in
                    if value.translation.height > 80 || value.predictedEndTranslation.height > 160 { dismiss() }
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { drag = 0 }
                })
            if let searchPlaceholder {
                PhrenSearchField(text: $query, placeholder: searchPlaceholder, identifier: "\(identifier):search")
                    .padding(.horizontal, 8).padding(.bottom, 8)
            }
            ViewThatFits(in: .vertical) {
                rows.fixedSize(horizontal: false, vertical: true)
                ScrollView { rows }.scrollBounceBehavior(.basedOnSize).phrenIdentifier("\(identifier):scroll")
            }
        }
        .foregroundStyle(PhrenTheme.text)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .clipShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .offset(y: drag)
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, dismiss)
        .phrenContainerMarker(identifier, label: title)
        .onAppear { titleFocused = true }
    }

    private var filteredActions: [Action] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return actions.filter { action in
            words.allSatisfy { (action.title + " " + (action.caption ?? "")).localizedStandardContains($0) }
        }
    }

    private var rows: some View {
        VStack(spacing: 4) {
            if filteredActions.isEmpty {
                Text("No matches").font(PhrenTypography.subheadline).foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, minHeight: 48)
            }
            ForEach(filteredActions) { action in
                if let selected = action.isSelected {
                    PhrenOptionRow(title: action.title, caption: action.caption, selected: selected,
                                   disabled: !action.isEnabled, icon: action.icon, minimumHeight: 48) {
                        action.perform(dismiss: dismiss)
                    }
                    .phrenIdentifier(action.accessibilityIdentifier ?? "\(identifier):\(action.id)")
                } else {
                    actionRow(action)
                }
            }
        }
        .padding(.horizontal, 8).padding(.bottom, 8)
    }

    private func actionRow(_ action: Action) -> some View {
        Button { action.perform(dismiss: dismiss) } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: action.icon ?? "circle")
                    .resizable().scaledToFit()
                    .foregroundStyle(action.iconColor ?? (action.role == .destructive ? PhrenTheme.danger : PhrenTheme.text))
                    .frame(width: 18, height: 18).frame(width: 22)
                    .opacity(action.icon == nil ? 0 : 1).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(action.title)
                    if let caption = action.caption {
                        Text(caption).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(PhrenTypography.body)
            .foregroundStyle(action.role == .destructive ? PhrenTheme.danger : PhrenTheme.text)
            .padding(.horizontal, 12).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!action.isEnabled).opacity(action.isEnabled ? 1 : 0.45)
        .phrenIdentifier(action.accessibilityIdentifier ?? "\(identifier):\(action.id)")
    }
}

struct PhrenDialog: View {
    typealias Action = PhrenControlAction
    let title: String
    let message: String
    let actions: [Action]
    let identifier: String
    let dismiss: () -> Void
    @AccessibilityFocusState private var titleFocused: Bool

    init(title: String, message: String, actions: [Action], identifier: String, dismiss: @escaping () -> Void) {
        precondition((1...3).contains(actions.count), "A dialog needs one to three actions")
        self.title = title
        self.message = message
        self.actions = actions
        self.identifier = identifier
        self.dismiss = dismiss
    }

    var body: some View {
        ViewThatFits(in: .vertical) {
            contents.fixedSize(horizontal: false, vertical: true)
            ScrollView { contents }.scrollBounceBehavior(.basedOnSize).phrenIdentifier("\(identifier):scroll")
        }
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .clipShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.large))
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, dismiss)
        .phrenContainerMarker(identifier, label: title)
        .onAppear { titleFocused = true }
    }

    private var contents: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(PhrenTypography.subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
            Text(message).font(PhrenTypography.body).foregroundStyle(PhrenTheme.textSecondary)
            VStack(spacing: 8) {
                ForEach(actions) { action in
                    Button { action.perform(dismiss: dismiss) } label: {
                        Text(action.title).font(PhrenTypography.body.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                            .foregroundStyle(action.role == .destructive ? PhrenTheme.danger : PhrenTheme.accent)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(PhrenTheme.surfaceRaised,
                                        in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!action.isEnabled).opacity(action.isEnabled ? 1 : 0.45)
                    .phrenIdentifier(action.accessibilityIdentifier ?? "\(identifier):\(action.id)")
                }
            }
        }
        .foregroundStyle(PhrenTheme.text).fixedSize(horizontal: false, vertical: true).padding(16)
    }
}

private struct PhrenModal: ViewModifier {
    @Binding var isPresented: Bool
    let title: String
    var message: String? = nil
    let actions: [PhrenControlAction]
    let identifier: String
    var searchPlaceholder: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(!isPresented).accessibilityHidden(isPresented)
            .overlay {
                if isPresented {
                    GeometryReader { geometry in
                        ZStack(alignment: message == nil ? .bottom : .center) {
                            Color.black.opacity(0.5).ignoresSafeArea().contentShape(Rectangle())
                                .onTapGesture { if message == nil { dismiss() } }
                                .accessibilityHidden(true)
                            if let message {
                                PhrenDialog(title: title, message: message, actions: actions,
                                            identifier: identifier, dismiss: dismiss)
                                    .frame(maxWidth: 360, maxHeight: max(44, geometry.size.height - 32))
                                    .padding(16)
                                    .transition(.opacity)
                            } else {
                                PhrenActionSheet(title: title, actions: actions, identifier: identifier, dismiss: dismiss,
                                                 searchPlaceholder: searchPlaceholder)
                                    .frame(maxWidth: 560, maxHeight: geometry.size.height * 0.85)
                                    .padding(8)
                                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                            }
                        }
                        .frame(width: geometry.size.width, height: geometry.size.height)
                    }
                    .zIndex(1)
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: isPresented)
    }

    private func dismiss() { isPresented = false }
}

extension View {
    func phrenActionSheet(isPresented: Binding<Bool>, title: String, actions: [PhrenActionSheet.Action],
                          identifier: String = "phren-action-sheet", searchPlaceholder: String? = nil) -> some View {
        modifier(PhrenModal(isPresented: isPresented, title: title, actions: actions, identifier: identifier,
                            searchPlaceholder: searchPlaceholder))
    }

    func phrenDialog(isPresented: Binding<Bool>, title: String, message: String, actions: [PhrenDialog.Action],
                     identifier: String = "phren-dialog") -> some View {
        modifier(PhrenModal(isPresented: isPresented, title: title, message: message, actions: actions, identifier: identifier))
    }
}

struct PhrenStepperField: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var step = 1
    let identifier: String
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private func next(increasing: Bool) -> Int {
        let amount = max(1, step)
        let result = increasing ? value.addingReportingOverflow(amount) : value.subtractingReportingOverflow(amount)
        if result.overflow { return increasing ? range.upperBound : range.lowerBound }
        return min(range.upperBound, max(range.lowerBound, result.partialValue))
    }

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Text(title).font(PhrenTypography.body).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                PhrenIconButton(icon: "minus", label: "Decrease \(title)") { value = next(increasing: false) }
                    .disabled(value <= range.lowerBound).phrenIdentifier("\(identifier):minus")
                Text("\(value)").font(PhrenTypography.monoSubheadline).monospacedDigit()
                    .fixedSize().frame(minWidth: 44, minHeight: 44).phrenIdentifier("\(identifier):value")
                PhrenIconButton(icon: "plus", label: "Increase \(title)") { value = next(increasing: true) }
                    .disabled(value >= range.upperBound).phrenIdentifier("\(identifier):plus")
            }
        }
        .foregroundStyle(PhrenTheme.text).opacity(isEnabled ? 1 : 0.45)
        .accessibilityElement(children: .contain).accessibilityLabel(title).accessibilityValue("\(value)")
        .accessibilityAdjustableAction { direction in
            guard isEnabled else { return }
            switch direction {
            case .increment: value = next(increasing: true)
            case .decrement: value = next(increasing: false)
            @unknown default: break
            }
        }
        .phrenIdentifier(identifier)
    }
}

struct PhrenScreen<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            // Editors keep focused fields alive when a group leaves the viewport.
            VStack(alignment: .leading, spacing: PhrenTheme.Space.section) { content }
                .padding(PhrenTheme.Space.large).frame(maxWidth: .infinity, alignment: .leading)
        }
        .phrenScreen()
    }
}

struct PhrenGroup<Content: View>: View {
    let caption: String
    var identifier: String? = nil
    @ViewBuilder var content: Content

    init(_ caption: String, identifier: String? = nil, @ViewBuilder content: () -> Content) {
        self.caption = caption
        self.identifier = identifier
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            Text(caption).plainListSectionLabel().accessibilityAddTraits(.isHeader)
                .phrenIdentifier(identifier ?? "phren-group:\(caption)")
            content
        }
    }
}

struct PhrenRow<Trailing: View>: View {
    let icon: String
    let title: String
    var chevron = true
    @ViewBuilder var trailing: Trailing
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).resizable().scaledToFit().frame(width: 18, height: 18)
                .frame(width: 22).foregroundStyle(PhrenTheme.textSecondary).accessibilityHidden(true)
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(spacing: 8))
            layout {
                Text(title).frame(maxWidth: .infinity, alignment: .leading)
                trailing.font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
            }
            .fixedSize(horizontal: false, vertical: true)
            if chevron {
                Image(systemName: "chevron.right").font(PhrenTypography.caption)
                    .foregroundStyle(PhrenTheme.textDim).accessibilityHidden(true)
            }
        }
        .font(PhrenTypography.body).foregroundStyle(PhrenTheme.text)
        .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 44)
        .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
        .contentShape(Rectangle()).opacity(isEnabled ? 1 : 0.45)
    }
}

extension PhrenRow where Trailing == EmptyView {
    init(icon: String, title: String, chevron: Bool = true) {
        self.init(icon: icon, title: title, chevron: chevron, trailing: { EmptyView() })
    }
}

/// One-line search input: magnifier, the field, a clear button once there is
/// text. The field carries `identifier` itself (a text field has no children
/// to hide) and the clear button `identifier:clear`.
struct PhrenSearchField: View {
    @Binding var text: String
    var placeholder = "Search"
    let identifier: String
    /// The owner's focus, when it needs to dismiss the keyboard itself.
    var focus: FocusState<Bool>.Binding? = nil
    var onSubmit: () -> Void = {}
    @FocusState private var ownFocus: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Image(systemName: "magnifyingglass").font(PhrenTypography.icon(15, weight: .semibold))
                .foregroundStyle(PhrenTheme.textMuted).accessibilityHidden(true)
            field
                .font(PhrenTypography.body).foregroundStyle(PhrenTheme.text).tint(PhrenTheme.cyan)
                .keyboardType(.webSearch).submitLabel(.search)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .onSubmit(onSubmit)
                .frame(maxWidth: .infinity, minHeight: 44)
                .phrenIdentifier(identifier)
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(PhrenTypography.icon(16))
                        .foregroundStyle(PhrenTheme.textMuted)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("Clear search")
                .phrenIdentifier("\(identifier):clear")
            }
        }
        .padding(.leading, PhrenTheme.Space.medium)
        .padding(.trailing, text.isEmpty ? PhrenTheme.Space.medium : 0)
        .frame(minHeight: 44)
        .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption, style: .continuous))
        .opacity(isEnabled ? 1 : 0.45)
    }

    @ViewBuilder private var field: some View {
        if let focus {
            TextField(placeholder, text: $text).focused(focus)
        } else {
            TextField(placeholder, text: $text).focused($ownFocus)
        }
    }
}

/// Single-select chips in one horizontal row that scrolls, the selected chip
/// scrolled into view; at accessibility sizes (or `wraps`) they wrap instead.
/// A chip is 32 points tall inside a 44-point target.
struct PhrenChipRow<Value: Hashable>: View {
    let items: [PhrenOption<Value>]
    @Binding var selection: Value
    let identifier: String
    /// The selected chip's colour; accent unless the caller says otherwise.
    var tint: (Value) -> Color = { _ in PhrenTheme.accent }
    /// Unselected chips on a `surface` panel need the raised fill to show.
    var raised = false
    var wraps = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize || wraps {
            PhrenFlowLayout(spacing: PhrenTheme.Space.small) { chips }
                .accessibilityElement(children: .contain)
        } else {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: PhrenTheme.Space.small) { chips }
                }
                .onAppear { reveal(proxy, animated: false) }
                .onChange(of: selection) { _, _ in reveal(proxy, animated: true) }
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func reveal(_ proxy: ScrollViewProxy, animated: Bool) {
        guard let item = items.first(where: { $0.value == selection }) else { return }
        withAnimation(animated && !reduceMotion ? .easeInOut(duration: 0.18) : nil) { proxy.scrollTo(item.id) }
    }

    private var chips: some View {
        ForEach(items) { item in
            let selected = item.value == selection
            let color = tint(item.value)
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    selection = PhrenOptionSelection.single(item.value, in: items, current: selection)
                }
            } label: {
                HStack(spacing: PhrenTheme.Space.xs) {
                    if let icon = item.icon {
                        Image(systemName: icon).font(PhrenTypography.icon(11, weight: .semibold)).accessibilityHidden(true)
                    }
                    Text(item.title).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(PhrenTypography.subheadline.weight(.medium))
                .foregroundStyle(selected ? color : PhrenTheme.textSecondary)
                .padding(.horizontal, PhrenTheme.Space.medium)
                .frame(minHeight: 32)
                .background(selected ? color.opacity(0.16) : (raised ? PhrenTheme.surfaceRaised : PhrenTheme.surface), in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!item.isEnabled)
            .opacity(isEnabled && item.isEnabled ? 1 : 0.45)
            .accessibilityLabel(item.accessibilityLabel ?? item.title)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .phrenIdentifier("\(identifier):\(item.id)")
        }
    }
}

/// A single choice drawn as a slider with one detent per option: a thin
/// track with the filled part up to the thumb, a tick under each option and
/// its title beneath, the chosen title in body weight above the thumb. Drag
/// or tap snaps to the nearest detent with a selection tick. This is the
/// control for a setting someone tunes (sensitivity, proactivity), where the
/// whole range should be visible at once rather than behind a drop-down.
struct PhrenStepSlider<Value: Hashable>: View {
    let options: [PhrenOption<Value>]
    @Binding var selection: Value
    let identifier: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @State private var dragIndex: Int? = nil

    private var selectedIndex: Int { options.firstIndex { $0.value == selection } ?? 0 }
    private var shownIndex: Int { dragIndex ?? selectedIndex }
    private var steps: Int { max(options.count - 1, 1) }
    private static var trackHeight: CGFloat { 28 }

    /// Detent for a horizontal position along a track of `width`.
    static func detent(at x: CGFloat, width: CGFloat, count: Int) -> Int {
        guard count > 1, width > 0 else { return 0 }
        let fraction = min(max(x / width, 0), 1)
        return Int((fraction * CGFloat(count - 1)).rounded())
    }

    /// First word when the labels would crowd the track.
    static func shortTitle(_ title: String, crowded: Bool) -> String {
        guard crowded, let first = title.split(separator: " ").first else { return title }
        return String(first)
    }

    private func choose(_ index: Int) {
        guard options.indices.contains(index), options[index].value != selection else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { selection = options[index].value }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            GeometryReader { geometry in
                let width = geometry.size.width
                let x = width * CGFloat(shownIndex) / CGFloat(steps)
                let mid = Self.trackHeight / 2
                ZStack(alignment: .leading) {
                    Capsule().fill(PhrenTheme.surfaceRaised).frame(height: 3)
                    Capsule().fill(PhrenTheme.accent).frame(width: max(x, 3), height: 3)
                    ForEach(options.indices, id: \.self) { index in
                        Circle()
                            .fill(index <= shownIndex ? PhrenTheme.accent : PhrenTheme.textDim)
                            .frame(width: 5, height: 5)
                            .position(x: width * CGFloat(index) / CGFloat(steps), y: mid)
                    }
                    Circle()
                        .fill(PhrenTheme.accent)
                        .overlay(Circle().strokeBorder(PhrenTheme.bg, lineWidth: 2))
                        .frame(width: dragIndex == nil ? 18 : 22, height: dragIndex == nil ? 18 : 22)
                        .position(x: x, y: mid)
                }
                .contentShape(Rectangle())
                // A tap lands on the nearest detent. A press then a drag slides
                // the thumb; a plain drag stays with the list, so the screen
                // keeps scrolling when a swipe starts on a slider.
                .onTapGesture(coordinateSpace: .local) { location in
                    guard isEnabled else { return }
                    choose(Self.detent(at: location.x, width: width, count: options.count))
                }
                .gesture(
                    LongPressGesture(minimumDuration: 0.12)
                        .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .local))
                        .onChanged { value in
                            guard isEnabled, case .second(true, let drag?) = value else { return }
                            let next = Self.detent(at: drag.location.x, width: width, count: options.count)
                            if next != dragIndex {
                                if dragIndex != nil { UISelectionFeedbackGenerator().selectionChanged() }
                                dragIndex = next
                            }
                        }
                        .onEnded { value in
                            defer { dragIndex = nil }
                            guard isEnabled, case .second(true, let drag?) = value else { return }
                            choose(Self.detent(at: drag.location.x, width: width, count: options.count))
                        }
                )
            }
            .frame(height: Self.trackHeight)
            // Each title sits under its own dot; the end titles hug the edges
            // so nothing clips, the rest centre on the dot.
            GeometryReader { geometry in
                let width = geometry.size.width
                ForEach(options.indices, id: \.self) { index in
                    let x = width * CGFloat(index) / CGFloat(steps)
                    let edge: CGFloat = 96
                    Text(Self.shortTitle(options[index].title, crowded: options.count > 4))
                        .font(PhrenTypography.caption2)
                        .foregroundStyle(index == shownIndex ? PhrenTheme.text : PhrenTheme.textMuted)
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .frame(width: index == 0 || index == options.count - 1 ? edge : max(width / CGFloat(steps) - 4, 40),
                               alignment: index == 0 ? .leading : index == options.count - 1 ? .trailing : .center)
                        .position(x: index == 0 ? edge / 2 : index == options.count - 1 ? width - edge / 2 : x, y: 7)
                }
            }
            .frame(height: 14)
            .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(options.indices.contains(selectedIndex) ? options[selectedIndex].title : "")
        .accessibilityAdjustableAction { direction in
            let next = selectedIndex + (direction == .increment ? 1 : -1)
            guard options.indices.contains(next) else { return }
            selection = options[next].value
        }
        .accessibilityIdentifier(identifier)
    }
}

/// Leading-aligned rows of whatever fits; the layout behind wrapping chips.
struct PhrenFlowLayout: Layout {
    var spacing: CGFloat = PhrenTheme.Space.small

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(width: bounds.width, subviews: subviews).frames
        for (index, frame) in frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                                  proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let proposal = ProposedViewSize(width: width.isFinite ? width : nil, height: nil)
            let size = subview.sizeThatFits(proposal)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            widest = max(widest, x - spacing)
        }
        return (CGSize(width: width.isFinite ? width : widest, height: y + rowHeight), frames)
    }
}


/// A Phren disclosure keeps its label a full tap target and its content inline.
struct PhrenDisclosure<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
            Button { expanded.toggle() } label: {
                HStack {
                    Text(title)
                    Spacer(minLength: PhrenTheme.Space.small)
                    Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded { content() }
        }
    }
}
