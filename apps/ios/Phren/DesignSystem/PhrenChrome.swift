import PhrenKit
import SwiftUI

/// The app's own dense chrome. Screens compose these in a `PhrenScrollScreen`
/// instead of grouped `List` chrome: uppercase section labels with counts,
/// icon-only segmented controls, metadata chips and rows, typed file icons,
/// and a timeline rail.

struct PhrenSectionHeader: View {
    let title: String
    var count: Int? = nil
    var trailing: String? = nil

    var body: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Text(title)
                .font(.caption.weight(.semibold)).textCase(.uppercase).tracking(0.6)
                .foregroundStyle(PhrenTheme.textMuted)
            if let count { PhrenCountBadge(count: count) }
            Spacer(minLength: 0)
            if let trailing {
                Text(trailing).font(.caption2).foregroundStyle(PhrenTheme.textDim)
            }
        }
        .padding(.top, PhrenTheme.Space.small)
    }
}

struct PhrenCountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(PhrenTheme.textSecondary)
            .padding(.horizontal, 7).padding(.vertical, 1)
            .background(PhrenTheme.surfaceRaised, in: Capsule())
    }
}

struct PhrenIconSegment<Value: Hashable>: View {
    struct Item: Identifiable {
        let value: Value
        let icon: String
        let label: String
        var id: Value { value }
    }

    let items: [Item]
    @Binding var selection: Value
    var tint: Color = PhrenTheme.accent
    var identifier: ((Value) -> String)? = nil

    var body: some View {
        HStack(spacing: 4) {
            ForEach(items) { item in
                let selected = item.value == selection
                Button { selection = item.value } label: {
                    Image(systemName: item.icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(selected ? tint : PhrenTheme.textMuted)
                        .frame(minWidth: 44, maxWidth: .infinity, minHeight: 44)
                        .background(selected ? tint.opacity(0.16) : .clear, in: Capsule())
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.label)
                .accessibilityIdentifier(identifier?(item.value) ?? item.label)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(PhrenTheme.surface, in: Capsule())
    }
}

struct PhrenChip: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let text: String
    var icon: String? = nil
    var role: PhrenTheme.ChipRole = .type
    var monospaced = false

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .semibold)) }
            Text(text)
        }
        .font(monospaced ? PhrenTypography.monoCaption2.weight(.medium) : PhrenTypography.caption2.weight(.medium))
        .foregroundStyle(PhrenTheme.chipColor(role))
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(PhrenTheme.chipColor(role).opacity(0.14), in: Capsule())
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        .fixedSize(horizontal: false, vertical: true)
    }
}

// PhrenSwitch lives in PhrenControls.swift.

struct PhrenStatLabel: View {
    var added: Int? = nil
    var removed: Int? = nil
    var text: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let text { Text(text).foregroundStyle(PhrenTheme.textMuted) }
            if let added, added > 0 { Text("+\(added)").foregroundStyle(PhrenTheme.success) }
            if let removed, removed > 0 { Text("-\(removed)").foregroundStyle(PhrenTheme.danger) }
        }
        .font(.system(.caption, design: .monospaced).weight(.medium))
    }
}

struct PhrenMetadataHeader<Chips: View, Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var chips: () -> Chips
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: PhrenTheme.Space.small) {
                Text(title).font(.title3.weight(.semibold)).foregroundStyle(PhrenTheme.text).lineLimit(2)
                Spacer(minLength: 0)
                trailing()
            }
            if let subtitle {
                Text(subtitle).font(.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
            }
            chips()
        }
    }
}

extension PhrenMetadataHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, @ViewBuilder chips: @escaping () -> Chips) {
        self.init(title: title, subtitle: subtitle, chips: chips) { EmptyView() }
    }
}

extension PhrenMetadataHeader where Chips == EmptyView, Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle, chips: { EmptyView() }, trailing: { EmptyView() })
    }
}

struct PhrenIconRow<Trailing: View>: View {
    let icon: String
    var iconColor: Color = PhrenTheme.textSecondary
    let title: String
    var subtitle: String? = nil
    var mono = false
    var selected = false
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: PhrenTheme.Space.small) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(iconColor)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(mono ? .system(.subheadline, design: .monospaced).weight(.medium) : .subheadline.weight(.medium))
                    .foregroundStyle(PhrenTheme.text).lineLimit(1).truncationMode(.middle)
                if let subtitle {
                    Text(subtitle).font(.caption2).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.horizontal, PhrenTheme.Space.medium).padding(.vertical, 9)
        .background(selected ? PhrenTheme.accent.opacity(0.16) : PhrenTheme.surface,
                    in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
        .contentShape(Rectangle())
    }
}

extension PhrenIconRow where Trailing == EmptyView {
    init(icon: String, iconColor: Color = PhrenTheme.textSecondary, title: String, subtitle: String? = nil, mono: Bool = false, selected: Bool = false) {
        self.init(icon: icon, iconColor: iconColor, title: title, subtitle: subtitle, mono: mono, selected: selected) { EmptyView() }
    }
}

enum PhrenFileType {
    static func info(for path: String) -> (icon: String, color: Color) {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "md", "markdown": return ("doc.richtext", PhrenTheme.cyan)
        case "swift": return ("swift", Color(hex: 0xF05138))
        case "json": return ("curlybraces", Color(hex: 0xE0BC7F))
        case "yaml", "yml": return ("list.bullet.indent", PhrenTheme.lavender)
        case "toml", "ini", "cfg", "conf": return ("gearshape", PhrenTheme.textMuted)
        case "sh", "bash", "zsh", "fish": return ("terminal", PhrenTheme.success)
        case "ts", "tsx", "js", "jsx", "mjs", "cjs": return ("chevron.left.forwardslash.chevron.right", Color(hex: 0xE0BC7F))
        case "py": return ("chevron.left.forwardslash.chevron.right", Color(hex: 0x5A9FD4))
        case "rs": return ("gearshape.2", Color(hex: 0xE0A07F))
        case "go": return ("chevron.left.forwardslash.chevron.right", Color(hex: 0x6FD6E0))
        case "rb": return ("diamond", Color(hex: 0xE07070))
        case "html", "htm", "css", "scss": return ("chevron.left.forwardslash.chevron.right", Color(hex: 0xE08A5A))
        case "sql": return ("cylinder", PhrenTheme.lavender)
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg": return ("photo", Color(hex: 0xE08AB0))
        default: return ("doc", PhrenTheme.textMuted)
        }
    }
}

struct PhrenFileTypeIcon: View {
    let path: String
    var folder = false
    var size: CGFloat = 15

    var body: some View {
        let info = folder ? ("folder.fill", PhrenTheme.lavender) : PhrenFileType.info(for: path)
        Image(systemName: info.0)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(info.1)
            .frame(width: 22)
            .accessibilityHidden(true)
    }
}

struct PhrenTimelineRail: View {
    var color: Color = PhrenTheme.accent
    var top = true
    var bottom = true

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(top ? color.opacity(0.5) : .clear).frame(width: 1.5).frame(maxHeight: .infinity)
            Circle().fill(color).frame(width: 8, height: 8)
            Rectangle().fill(bottom ? color.opacity(0.5) : .clear).frame(width: 1.5).frame(maxHeight: .infinity)
        }
        .frame(width: 12)
        .accessibilityHidden(true)
    }
}

struct PhrenRail: View {
    var color: Color
    var body: some View {
        Capsule().fill(color).frame(width: 3)
    }
}

struct PhrenScrollScreen<Content: View>: View {
    var spacing: CGFloat = PhrenTheme.Space.small
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: spacing) {
                content
            }
            .padding(.horizontal, PhrenTheme.Space.large)
            .padding(.vertical, PhrenTheme.Space.medium)
        }
        .phrenScreen()
    }
}

struct PhrenSheetHeader: View {
    let title: String
    var trailingTitle = "Done"
    var canSave = true
    var identifierPrefix: String? = nil
    let cancel: () -> Void
    let save: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 0) {
            if dynamicTypeSize.isAccessibilitySize { titleText.padding(.top, PhrenTheme.Space.small) }
            ZStack {
                if !dynamicTypeSize.isAccessibilitySize { titleText }
                actions
            }
        }
        .padding(.horizontal, PhrenTheme.Space.large)
        .frame(minHeight: 56)
    }

    private var titleText: some View {
        Text(title)
            .font(PhrenTypography.subheadline.weight(.semibold))
            .foregroundStyle(PhrenTheme.text)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var actions: some View {
            HStack {
                Button(action: cancel) {
                    Text("Cancel").frame(minWidth: 44, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                    .accessibilityIdentifier(identifierPrefix.map { "\($0)-cancel" } ?? "sheet-cancel")
                Spacer()
                Button(action: save) {
                    Text(trailingTitle)
                        .foregroundStyle(canSave ? PhrenTheme.accentSolid : PhrenTheme.textDim)
                        .frame(minWidth: 44, minHeight: 44, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                    .disabled(!canSave)
                    .accessibilityIdentifier(identifierPrefix.map { "\($0)-save" } ?? "sheet-done")
            }
            .font(PhrenTypography.body)
            .foregroundStyle(PhrenTheme.accentSolid)
    }
}
