import SwiftUI

struct CustomThemeEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var theme: PhrenCustomTheme
    @State private var invalidColors: Set<ThemeColorField> = []
    @State private var paletteRevision = UUID()
    @State private var showingPresets = false
    @State private var presetSelection: PhrenAppearanceStyle = .charcoal
    @State private var editingColor: ThemeColorField?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ThemePreview(name: theme.name.isEmpty ? "Your theme" : theme.name,
                             detail: "Live preview", palette: theme.palette)
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Theme name", text: $theme.name).font(.headline)
                        .accessibilityIdentifier("theme-name")
                    Button { showingPresets = true } label: {
                        Label("Start from a preset", systemImage: "square.on.square").font(.subheadline)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("theme-preset")
                }.padding(16).phrenCard()
                VStack(spacing: 0) {
                    ForEach(ThemeColorField.allCases) { field in
                        ThemeColorRow(field: field, value: Binding(
                            get: { field.value(in: theme.palette) },
                            set: { field.apply($0, to: &theme.palette) }
                        ), editColor: { editingColor = field }) { valid in
                            if valid { invalidColors.remove(field) } else { invalidColors.insert(field) }
                        }
                        if field != ThemeColorField.allCases.last { Divider().overlay(PhrenTheme.border) }
                    }
                }.id(paletteRevision).phrenCard()
                Text("Choose a swatch or enter a hex color. Save applies your theme throughout Phren.")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
            }.padding(16)
        }
        .background(PhrenTheme.bg).scrollDismissesKeyboard(.interactively)
        .navigationTitle("Custom theme").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    theme.name = String(theme.name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
                    PhrenAppearance.shared.save(theme); dismiss()
                }.disabled(theme.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !invalidColors.isEmpty)
                    .accessibilityIdentifier("theme-save")
            }
        }
        .phrenSingleSelectSheet(isPresented: $showingPresets, title: "Start from a preset",
                                options: presetOptions, selection: $presetSelection,
                                rowPrefix: "theme-preset", onSelect: applyPreset)
        .phrenColorSheet(isPresented: Binding(get: { editingColor != nil }, set: { if !$0 { editingColor = nil } }),
                         title: editingColor?.rawValue ?? "Color", selection: selectedColor,
                         identifier: "theme-color-editor")
    }

    private var selectedColor: Binding<Color> {
        Binding(get: { Color(hex: editingColor?.value(in: theme.palette) ?? 0) }, set: { color in
            guard let field = editingColor else { return }
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return }
            func channel(_ component: CGFloat) -> UInt32 { UInt32((min(1, max(0, component)) * 255).rounded()) }
            field.apply((channel(red) << 16) | (channel(green) << 8) | channel(blue), to: &theme.palette)
            invalidColors.remove(field)
        })
    }

    private var presetOptions: [PhrenOption<PhrenAppearanceStyle>] {
        PhrenAppearanceStyle.allCases.map { PhrenOption(id: $0.id, value: $0, title: $0.name) }
    }

    private func applyPreset(_ preset: PhrenAppearanceStyle) {
        theme.palette = preset.palette
        invalidColors.removeAll()
        paletteRevision = UUID()
    }
}

private struct ThemeColorRow: View {
    let field: ThemeColorField
    @Binding var value: UInt32
    let editColor: () -> Void
    let validated: (Bool) -> Void
    @State private var hex: String

    init(field: ThemeColorField, value: Binding<UInt32>, editColor: @escaping () -> Void, validated: @escaping (Bool) -> Void) {
        self.field = field; self._value = value; self.editColor = editColor; self.validated = validated
        _hex = State(initialValue: String(format: "%06X", value.wrappedValue))
    }

    var body: some View {
        HStack(spacing: 12) {
            PhrenColorButton(title: field.rawValue, color: Color(hex: value),
                             identifier: "theme-color-swatch-\(field.id)", action: editColor)
            Spacer(minLength: PhrenTheme.Space.small)
            HStack(spacing: 1) {
                Text("#").foregroundStyle(PhrenTheme.textDim)
                TextField("RRGGBB", text: $hex)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .frame(width: 72).accessibilityLabel("\(field.rawValue) hex")
                    .accessibilityIdentifier("theme-color-\(field.id)")
            }.font(.system(.caption, design: .monospaced))
        }.padding(14)
        .onChange(of: hex) { _, raw in
            let digits = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
            let parsed = digits.count == 6 ? UInt32(digits, radix: 16) : nil
            validated(parsed != nil)
            if let parsed { value = parsed }
        }
        .onChange(of: value) { _, color in hex = String(format: "%06X", color); validated(true) }
    }
}

enum ThemeColorField: String, CaseIterable, Identifiable {
    case background = "Background", text = "Text", panels = "Panels", accent = "Accent", links = "Links"
    case sessionProject = "Session project", sessionTitle = "Session title", sessionMeta = "Session metadata"
    case stateWorking = "Working state", stateWaiting = "Waiting state", stateDone = "Done state"
    case phrenCardSurface = "Phren card surface", phrenCardBorder = "Phren card border", phrenCardAccent = "Phren card accent"
    case chatInlineCode = "Inline code"
    var id: String { rawValue.lowercased() }
    func value(in p: PhrenPalette) -> UInt32 {
        switch self {
        case .background: return p.background
        case .text: return p.text
        case .panels: return p.chatPanel
        case .accent: return p.action
        case .links: return p.link ?? p.action
        case .sessionProject: return p.sessionProject ?? p.link ?? p.action
        case .sessionTitle: return p.sessionTitle ?? p.secondary
        case .sessionMeta: return p.sessionMeta ?? p.muted
        case .stateWorking: return p.stateWorking ?? p.action
        case .stateWaiting: return p.stateWaiting ?? 0xE0BC7F
        case .stateDone: return p.stateDone ?? 0x8AC8AC
        case .phrenCardSurface: return p.resolvedPhrenCardSurface
        case .phrenCardBorder: return p.resolvedPhrenCardBorder
        case .phrenCardAccent: return p.resolvedPhrenCardAccent
        case .chatInlineCode: return p.chatInlineCode ?? p.link ?? p.action
        }
    }
    func apply(_ color: UInt32, to p: inout PhrenPalette) {
        switch self {
        case .background:
            p.background = color; p.chatCanvas = color; p.sunken = Self.mix(color, 0, 0.2)
            p.surface = Self.mix(color, 0xFFFFFF, 0.05); p.raised = Self.mix(color, 0xFFFFFF, 0.14)
        case .text:
            p.text = color; p.navigation = color
            p.secondary = Self.mix(color, p.background, 0.1)
            p.muted = Self.mix(color, p.background, 0.32); p.dim = Self.mix(color, p.background, 0.38)
        case .panels: p.chatPanel = color; p.toolPanel = color
        case .accent:
            p.action = color; p.accent = color
            p.hover = Self.mix(color, 0xFFFFFF, 0.25); p.solid = Self.mix(color, 0, 0.4)
        case .links: p.link = color
        case .sessionProject: p.sessionProject = color
        case .sessionTitle: p.sessionTitle = color
        case .sessionMeta: p.sessionMeta = color
        case .stateWorking: p.stateWorking = color
        case .stateWaiting: p.stateWaiting = color
        case .stateDone: p.stateDone = color
        case .phrenCardSurface: p.phrenCardSurface = color
        case .phrenCardBorder: p.phrenCardBorder = color
        case .phrenCardAccent: p.phrenCardAccent = color
        case .chatInlineCode: p.chatInlineCode = color
        }
    }
    private static func mix(_ a: UInt32, _ b: UInt32, _ fraction: Double) -> UInt32 {
        [16, 8, 0].reduce(UInt32(0)) { result, shift in
            let channel = Double((a >> shift) & 255) * (1 - fraction) + Double((b >> shift) & 255) * fraction
            return result | (UInt32(channel.rounded()) << shift)
        }
    }
}
