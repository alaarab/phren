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
    var label = "Enabled"
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { isOn.toggle() }
        } label: {
            ZStack {
                Capsule().fill(isOn ? PhrenTheme.accentSolid : PhrenTheme.surfaceRaised)
                    .frame(width: 44, height: 26)
                Circle().fill(PhrenTheme.onAccent).frame(width: 22, height: 22)
                    .offset(x: isOn ? 9 : -9)
            }
            .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityLabel(label)
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
    var detail: AnyView? = nil
    var radius = PhrenTheme.Radius.questionOption
    var minimumHeight: CGFloat = 44
    /// A choice that is listed but not currently available, such as an offline computer.
    var muted = false
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// A passive trailing caption ("offline", "default") for the `trailing` slot.
    static func trailingCaption(_ text: String) -> some View {
        Text(text).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
    }

    var body: some View {
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
                VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                    let layout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                        : AnyLayout(HStackLayout(alignment: .top, spacing: 8))
                    layout {
                        VStack(alignment: .leading, spacing: PhrenTheme.Space.xs) {
                            Text(title).foregroundStyle(muted ? PhrenTheme.textMuted : PhrenTheme.text)
                            if let caption, !caption.isEmpty {
                                Text(caption).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if let trailing { trailing }
                    }
                    if let detail { detail }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .font(PhrenTypography.body)
            .padding(PhrenTheme.Space.medium)
            .frame(maxWidth: .infinity, minHeight: max(44, minimumHeight), alignment: .leading)
            .background(selected ? PhrenTheme.cyan.opacity(0.1) : PhrenTheme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
                .stroke(selected ? PhrenTheme.cyan.opacity(0.5) : .clear, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled || !isEnabled ? 0.45 : 1)
        .accessibilityAddTraits(selected ? .isSelected : [])
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
    var caption: String? = nil
    var role: Role = .normal
    var isEnabled = true
    var isSelected: Bool? = nil
    var dismisses = true
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

    private var rows: some View {
        VStack(spacing: 4) {
            ForEach(actions) { action in
                if let selected = action.isSelected {
                    PhrenOptionRow(title: action.title, caption: action.caption, selected: selected,
                                   disabled: !action.isEnabled, icon: action.icon, minimumHeight: 48) {
                        action.perform(dismiss: dismiss)
                    }
                    .phrenIdentifier("\(identifier):\(action.id)")
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
                    .resizable().scaledToFit().frame(width: 18, height: 18).frame(width: 22).opacity(action.icon == nil ? 0 : 1).accessibilityHidden(true)
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
        .phrenIdentifier("\(identifier):\(action.id)")
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
                    .phrenIdentifier("\(identifier):\(action.id)")
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
                                PhrenActionSheet(title: title, actions: actions, identifier: identifier, dismiss: dismiss)
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
                          identifier: String = "phren-action-sheet") -> some View {
        modifier(PhrenModal(isPresented: isPresented, title: title, actions: actions, identifier: identifier))
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
