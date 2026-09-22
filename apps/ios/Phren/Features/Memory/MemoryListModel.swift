import Foundation
import Observation
import PhrenKit

/// List mode's derived presentation: the filtered rows, their project groups
/// and the counts line, recomputed only when one of the inputs changes so the
/// view body never filters or groups while drawing (scrolling stayed smooth
/// only as long as every row draw was cheap).
@Observable @MainActor
final class MemoryListModel {
    private(set) var rows: [MemoryItem] = []
    private(set) var groups: [(project: String, rows: [MemoryItem])] = []
    private(set) var counts = MemoryCounts()
    /// The project filter is not exactly one project: the list groups by
    /// project and each row carries its project chip.
    private(set) var grouped = false
    /// The project scope before the kinds filter, for the empty-state line.
    private(set) var scopeIsEmpty = true

    private var contents: [MemoryItem] = []
    private var kinds: Set<MemoryKind> = []
    private var projects: Set<String> = []
    private var query = ""
    private var searchResults: [MemoryItem] = []

    /// The project scope: an empty filter keeps everything, a chosen set keeps
    /// those projects, and topic rows stay in view whatever the filter.
    static func scoped(_ contents: [MemoryItem], projects: Set<String>) -> [MemoryItem] {
        guard !projects.isEmpty else { return contents }
        return contents.filter { $0.kind == .topic || projects.contains($0.project) }
    }

    func update(contents: [MemoryItem], kinds: Set<MemoryKind>, projects: Set<String>,
                query: String, searchResults: [MemoryItem]) {
        guard contents != self.contents || kinds != self.kinds || projects != self.projects
                || query != self.query || searchResults != self.searchResults else { return }
        self.contents = contents
        self.kinds = kinds
        self.projects = projects
        self.query = query
        self.searchResults = searchResults
        let scoped = Self.scoped(contents, projects: projects)
        scopeIsEmpty = scoped.isEmpty
        rows = query.isEmpty ? MemoryBrowsing.filter(scoped, kinds: kinds) : searchResults
        grouped = projects.count != 1
        groups = grouped ? MemoryBrowsing.grouped(rows) : []
        counts = MemoryBrowsing.counts(rows)
    }
}
