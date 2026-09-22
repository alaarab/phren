import SwiftUI

struct CustomThemeEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var theme: PhrenCustomTheme
    @State private var invalidColors: Set<ThemeColorField> = []
    @State private var paletteRevision = UUID()
    @State private var showingPresets = false
    @State private var presetSelection: PhrenAppearanceStyle = .charcoal

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
                        )) { valid in
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
    let validated: (Bool) -> Void
    @State private var hex: String

    init(field: ThemeColorField, value: Binding<UInt32>, validated: @escaping (Bool) -> Void) {
        self.field = field; self._value = value; self.validated = validated
        _hex = State(initialValue: String(format: "%06X", value.wrappedValue))
    }

    var body: some View {
        HStack(spacing: 12) {
            ColorPicker(field.rawValue, selection: Binding(get: { Color(hex: value) }, set: { color in
                var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else { return }
                func channel(_ component: CGFloat) -> UInt32 { UInt32((min(1, max(0, component)) * 255).rounded()) }
                value = (channel(r) << 16) | (channel(g) << 8) | channel(b)
                hex = String(format: "%06X", value); validated(true)
            }), supportsOpacity: false)
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
