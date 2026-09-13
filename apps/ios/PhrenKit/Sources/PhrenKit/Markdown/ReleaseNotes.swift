import Foundation

/// The app's CHANGELOG.md, read for "What's new": one `## <version>` section
/// per release, `### New` / `### Improved` / `### Fixed` groups inside it,
/// one `- ` bullet per change (continuation lines indented). Anything that is
/// not a heading or a bullet — the preamble, "Earlier" prose — is kept as a
/// note on the section.
public struct ReleaseNotes: Equatable, Sendable {
    public struct Group: Equatable, Sendable, Identifiable {
        public let title: String
        public let items: [String]
        public var id: String { title }
    }
    public struct Release: Equatable, Sendable, Identifiable {
        public let version: String
        public let groups: [Group]
        public let notes: [String]
        public var id: String { version }
        public var isEmpty: Bool { groups.allSatisfy(\.items.isEmpty) && notes.isEmpty }
    }
    public let releases: [Release]

    public init(markdown: String) {
        var releases: [Release] = []
        var version: String?, groups: [Group] = [], title = "", items: [String] = [], notes: [String] = []
        func closeGroup() { if !items.isEmpty || !title.isEmpty { groups.append(Group(title: title, items: items)) }; items = []; title = "" }
        func closeRelease() { closeGroup(); if let version { releases.append(Release(version: version, groups: groups, notes: notes)) }; groups = []; notes = [] }
        for raw in markdown.prefix(262_144).components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if raw.hasPrefix("## ") {
                closeRelease(); version = String(raw.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if raw.hasPrefix("### ") {
                closeGroup(); title = String(raw.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("- ") {
                items.append(String(line.dropFirst(2)))
            } else if !line.isEmpty, version != nil, !raw.hasPrefix("#") {
                // A wrapped bullet continues the last item; anything else is a note.
                if raw.hasPrefix("  "), !items.isEmpty { items[items.count - 1] += " " + line }
                else if title.isEmpty { notes.append(line) }
            }
        }
        closeRelease()
        self.releases = releases
    }

    /// The section for one version — "0.0.6" matches "## 0.0.6" and
    /// "## 0.0.6 (build 61)" alike.
    public func release(for version: String) -> Release? {
        releases.first { $0.version == version || $0.version.hasPrefix(version + " ") }
    }
}
