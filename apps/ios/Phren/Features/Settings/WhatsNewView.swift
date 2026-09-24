import PhrenKit
import SwiftUI

/// The changelog, bundled from apps/ios/CHANGELOG.md: the running version's
/// section once after an update, or every release from Settings → About.
enum ReleaseNotesStore {
    static let seenVersionKey = "whatsNew.seenVersion.v1"
    /// Every TestFlight build ships under the same marketing version, so the
    /// build number is part of what counts as "seen"; otherwise the notes
    /// showed once per version and never again for the next twenty builds.
    static var seenStamp: String { "\(version) (\(build))" }
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?" }
    static let notes: ReleaseNotes = ReleaseNotes(markdown: Bundle.main.url(forResource: "CHANGELOG", withExtension: "md")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "")
    static var current: ReleaseNotes.Release? { notes.release(for: version) }

    /// Whether to put this version's notes up now. Under UI tests only the
    /// `--whats-new` flag does, so no other test meets the sheet.
    static func shouldPresent(defaults: UserDefaults = AppRuntime.defaults) -> Bool {
        if AppRuntime.isUITesting { return ProcessInfo.processInfo.arguments.contains("--whats-new") }
        guard let current, !current.isEmpty else { return false }
        return defaults.string(forKey: seenVersionKey) != seenStamp
    }
    static func markSeen(defaults: UserDefaults = AppRuntime.defaults) { defaults.set(seenStamp, forKey: seenVersionKey) }
}

struct WhatsNewSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let release = ReleaseNotesStore.current { ReleaseSection(release: release, showsVersion: false) }
                    else { Text("No notes for this version.").foregroundStyle(PhrenTheme.textMuted) }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
            .navigationTitle("What's new in \(ReleaseNotesStore.version)").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("whats-new-done") } }
            .phrenScreen()
        }
        .onDisappear { ReleaseNotesStore.markSeen() }
        .accessibilityIdentifier("whats-new")
    }
}

/// Every release, newest first — the same file, all of it.
struct ChangelogView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ForEach(ReleaseNotesStore.notes.releases) { release in ReleaseSection(release: release, showsVersion: true) }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20)
        }
        .navigationTitle("What's new").navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
    }
}

private struct ReleaseSection: View {
    let release: ReleaseNotes.Release
    let showsVersion: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showsVersion {
                Text(release.version).font(.title3.weight(.semibold))
                    .foregroundStyle(release.version == ReleaseNotesStore.version ? PhrenTheme.accent : PhrenTheme.text)
            }
            ForEach(release.notes, id: \.self) { Text($0).font(.subheadline).foregroundStyle(PhrenTheme.textSecondary) }
            ForEach(release.groups) { group in
                VStack(alignment: .leading, spacing: 8) {
                    if !group.title.isEmpty {
                        Text(group.title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted).tracking(0.6)
                    }
                    ForEach(group.items, id: \.self) { item in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Circle().fill(PhrenTheme.accent).frame(width: 5, height: 5).offset(y: -2)
                            Text((try? AttributedString(markdown: item)) ?? AttributedString(item)).font(.subheadline).foregroundStyle(PhrenTheme.text)
                        }
                    }
                }
            }
        }
    }
}
