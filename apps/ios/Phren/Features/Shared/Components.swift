import SwiftUI
import PhrenKit

extension Binding {
    /// Present while an optional value exists, then clear that value on
    /// dismissal. Setting true cannot invent the content of an alert/dialog.
    func isPresent<Wrapped>() -> Binding<Bool> where Value == Wrapped? {
        Binding<Bool>(
            get: { wrappedValue != nil },
            set: { if !$0 { wrappedValue = nil } }
        )
    }
}

extension View {
    /// A thumb drag dismisses the keyboard without consuming taps or horizontal
    /// text/toolbar gestures. Global coordinates stay stable as the keyboard moves.
    func dismissKeyboardOnDownwardDrag(_ dismiss: @escaping () -> Void) -> some View {
        // The icon row sits against the keyboard: recognize within its lower
        // half, before the finger crosses into the keyboard's separate window.
        simultaneousGesture(DragGesture(minimumDistance: 8, coordinateSpace: .global).onChanged { value in
            let drag = value.translation
            if drag.height > 12 && drag.height > abs(drag.width) * 1.3 { dismiss() }
        })
    }
}

/// "live · updated 3s ago" freshness indicator shown on every list screen —
/// the visible promise that what you see is what's on GitHub right now.
struct LiveStatusBar: View {
    @Environment(AppModel.self) private var model
    @State private var now = Date()

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(indicatorColor)
                .frame(width: 5, height: 5)
            Text(statusText)
                .font(.caption)
                .foregroundStyle(PhrenTheme.textMuted)
            Spacer()
            if model.syncStatus.pendingCount > 0 {
                Label("\(model.syncStatus.pendingCount)", systemImage: "arrow.up.circle")
                    .font(.caption)
                    .foregroundStyle(PhrenTheme.amber)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 8)
        .background(PhrenTheme.bg)
        .onReceive(ticker) { now = $0 }
    }

    private var indicatorColor: Color {
        if model.syncStatus.lastError != nil { return PhrenTheme.red }
        return model.syncStatus.isLive ? PhrenTheme.cyan : PhrenTheme.textDim
    }

    private var statusText: String {
        if let error = model.syncStatus.lastError {
            return "sync error — \(error)"
        }
        guard let last = model.syncStatus.lastSyncedAt else {
            return model.syncStatus.isLive ? "live · syncing…" : "not synced yet"
        }
        let seconds = max(0, Int(now.timeIntervalSince(last)))
        let ago = seconds < 60 ? "\(seconds)s ago" : "\(seconds / 60)m ago"
        return model.syncStatus.isLive ? "live · updated \(ago)" : "updated \(ago)"
    }
}

struct ActionErrorBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let error = model.lastActionError {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(error).font(.footnote)
                Spacer()
                Button {
                    model.lastActionError = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
            }
            .padding(10)
            .background(.red.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
        }
    }
}

struct FindingRow: View {
    let finding: Finding

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(displayText)
                .font(.callout)
            HStack(spacing: 6) {
                if let tag = finding.typeTag {
                    TagChip(text: tag, role: .type)
                }
                if finding.status != .active {
                    TagChip(text: finding.status.rawValue, role: .status)
                }
                if let scope = finding.scope {
                    TagChip(text: scope, role: .scope)
                }
                if let actor = finding.actor {
                    Text("@\(actor)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(finding.date)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    private var displayText: String {
        // Show the text without the leading [tag] — the chip carries it.
        guard let tag = finding.typeTag else { return finding.text }
        let prefix = "[\(tag)] "
        return finding.text.lowercased().hasPrefix(prefix.lowercased())
            ? String(finding.text.dropFirst(prefix.count))
            : finding.text
    }
}

struct TagChip: View {
    let text: String
    let color: Color

    init(text: String, color: Color) {
        self.text = text
        self.color = color
    }

    init(text: String, role: PhrenTheme.ChipRole) {
        self.init(text: text, color: PhrenTheme.chipColor(role))
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.10), in: Capsule())
            .foregroundStyle(color)
    }
}

/// Sheet for entering or editing a piece of text, with an optional finding
/// type picker (used for add finding, edit finding, promote note).
struct TextEntrySheet: View {
    let title: String
    let showsTypePicker: Bool
    let confirmLabel: String
    let onConfirm: (String, FindingType?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State var text: String
    @State var selectedType: FindingType?

    init(title: String, initialText: String = "", initialType: FindingType? = nil,
         showsTypePicker: Bool = false, confirmLabel: String = "Save",
         onConfirm: @escaping (String, FindingType?) async -> Void) {
        self.title = title
        self.showsTypePicker = showsTypePicker
        self.confirmLabel = confirmLabel
        self.onConfirm = onConfirm
        _text = State(initialValue: initialText)
        _selectedType = State(initialValue: initialType)
    }

    var body: some View {
        NavigationStack {
            PhrenForm {
                Section {
                    TextField("Text", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                }
                if showsTypePicker {
                    Picker("Type", selection: $selectedType) {
                        Text("none").tag(FindingType?.none)
                        ForEach(FindingType.allCases, id: \.self) { type in
                            Text(type.rawValue).tag(FindingType?.some(type))
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmLabel) {
                        let value = text
                        let type = selectedType
                        Task {
                            await onConfirm(value, type)
                        }
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
