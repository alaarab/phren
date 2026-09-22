import SwiftUI

struct AppearanceSettingsView: View {
    @State private var appearance = PhrenAppearance.shared
    @State private var editingTheme: PhrenCustomTheme?
    @State private var actionTheme: PhrenCustomTheme?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let issue = appearance.storageIssue {
                    Text(issue).font(.footnote).foregroundStyle(PhrenTheme.warning)
                }
                Text("Make it yours.")
                    .font(.title2.weight(.semibold)).foregroundStyle(PhrenTheme.text)
                Button {
                    editingTheme = .init(name: "\(appearance.name) custom", palette: appearance.palette)
                } label: {
                    Label("Create custom theme", systemImage: "slider.horizontal.3")
                        .font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14).phrenCard()
                }.buttonStyle(.plain).accessibilityIdentifier("theme-create")
                if !appearance.customThemes.isEmpty {
                    Text("YOUR THEMES").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    ForEach(appearance.customThemes) { theme in
                        VStack(alignment: .trailing, spacing: 4) {
                            themeChoice(id: theme.id, name: theme.name, detail: "Custom palette", palette: theme.palette)
                                .simultaneousGesture(LongPressGesture(minimumDuration: 0.8).onEnded { _ in actionTheme = theme })
                            HStack(spacing: 4) {
                                Button("Edit", systemImage: "pencil") { editingTheme = theme }
                                    .font(.caption).frame(minHeight: 36).accessibilityIdentifier("theme-edit-\(theme.id)")
                                PhrenIconButton(icon: "ellipsis", label: "Theme actions") { actionTheme = theme }
                                    .phrenIdentifier("theme-actions-\(theme.id)")
                            }
                        }
                    }
                    Text("PRESETS").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                }
                ForEach(PhrenAppearanceStyle.allCases) { style in
                    themeChoice(id: style.id, name: style.name, detail: style.detail, palette: style.palette)
                }
            }.padding(18)
        }
        .background(PhrenTheme.bg)
        .navigationTitle("Theme").navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editingTheme) { theme in
            NavigationStack { CustomThemeEditor(theme: theme) }
        }
        .phrenActionSheet(isPresented: $actionTheme.isPresent(), title: "Theme actions",
                          actions: themeActions, identifier: "theme-actions-sheet")
    }

    private var themeActions: [PhrenControlAction] {
        guard let theme = actionTheme else { return [] }
        return [
            PhrenControlAction(id: "duplicate", title: "Duplicate", icon: "plus.square.on.square") {
                editingTheme = .init(name: "\(theme.name) copy", palette: theme.palette)
            },
            PhrenControlAction(id: "delete", title: "Delete theme", role: .destructive) {
                appearance.remove(theme)
            },
        ]
    }

    private func themeChoice(id: String, name: String, detail: String, palette: PhrenPalette) -> some View {
        Button { appearance.selectedID = id } label: {
            ThemePreview(name: name, detail: detail, palette: palette, selected: appearance.selectedID == id)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name + ". " + detail)
        .accessibilityValue(appearance.selectedID == id ? "Selected" : "Not selected")
        .accessibilityAddTraits(appearance.selectedID == id ? .isSelected : [])
        .accessibilityIdentifier("theme-\(id)")
    }
}

struct ThemePreview: View {
    let name: String
    let detail: String
    let palette: PhrenPalette
    var selected = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).font(.headline)
                    Text(detail).font(.caption).foregroundStyle(Color(hex: palette.muted))
                }
                Spacer(minLength: 4)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22)).foregroundStyle(Color(hex: selected ? palette.action : palette.dim))
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("A little memory. A clearer thought.")
                    .font(.system(.subheadline, design: .monospaced))
                HStack(spacing: 6) {
                    Image(systemName: "terminal")
                    Text("Shell").fontWeight(.semibold)
                    Text("git status").foregroundStyle(Color(hex: palette.muted))
                    Spacer()
                    Image(systemName: "chevron.down")
                }.font(.system(.caption2, design: .monospaced)).padding(8)
                    .background(Color(hex: palette.toolPanel ?? palette.chatPanel), in: Capsule())
                Text("View changes").font(.caption).foregroundStyle(Color(hex: palette.link ?? palette.action))
                HStack {
                    Text("Message your agent…").font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Color(hex: palette.muted))
                    Spacer()
                    Image(systemName: "arrow.up").font(.caption.weight(.semibold))
                        .foregroundStyle(Color(hex: palette.chatPanel))
                        .frame(width: 26, height: 26).background(Color(hex: palette.action), in: Circle())
                }.padding(10).background(Color(hex: palette.chatPanel), in: RoundedRectangle(cornerRadius: 14))
            }.accessibilityHidden(true)
        }
        .padding(16)
        .foregroundStyle(Color(hex: palette.text))
        .background(Color(hex: palette.background), in: RoundedRectangle(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(Color(hex: selected ? palette.action : palette.muted).opacity(selected ? 0.65 : 0.22), lineWidth: selected ? 1.5 : 0.5)
        }
    }
}
