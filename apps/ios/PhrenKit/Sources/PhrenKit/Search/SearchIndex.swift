import Foundation

/// On-device full-text search over the parsed snapshot. A simple in-memory
/// inverted index: at phren's documented scale (docs/performance.md treats
/// <1K findings as "small") a full rebuild per sync is milliseconds.
/// Archived content is excluded, matching the CLI's FTS index behavior.
public struct SearchIndex: Sendable {
    public enum DocKind: String, CaseIterable, Sendable {
        case finding, note, task, summary, truth
    }

    public struct Result: Identifiable, Equatable, Sendable {
        public let id: String
        /// Store the item came from ("" in single-store contexts).
        public let store: String
        public let project: String
        public let kind: DocKind
        public let text: String
        public let date: String?
        /// Finding type tag (for the type filter), when applicable.
        public let typeTag: String?
        public let score: Double
    }

    private struct Doc {
        let id: String
        let store: String
        let project: String
        let kind: DocKind
        let text: String
        let date: String?
        let recencyDate: Date?
        let typeTag: String?
        let tokens: [String: Int]
    }

    private var docs: [Doc] = []

    public init() {}

    public init(snapshot: LocalStore.Snapshot) {
        self.init(snapshots: [(store: "", snapshot: snapshot)])
    }

    public init(snapshots: [(store: String, snapshot: LocalStore.Snapshot)]) {
        // Dates are immutable for this index. Parse them once with a shared
        // formatter; only their age changes between searches.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"

        func doc(id: String, store: String, project: String, kind: DocKind,
                 text: String, date: String?, typeTag: String?) -> Doc {
            let recencyDate = date.flatMap { $0.count == 10 ? formatter.date(from: $0) : nil }
            return Doc(id: id, store: store, project: project, kind: kind, text: text, date: date,
                       recencyDate: recencyDate, typeTag: typeTag, tokens: Self.tokenFrequencies(text))
        }

        var docs: [Doc] = []
        for (store, snapshot) in snapshots {
            for (project, findings) in snapshot.findings {
                for finding in findings where !finding.archived {
                    docs.append(doc(
                        id: "f:\(store):\(project):\(finding.stableId ?? finding.id)",
                        store: store, project: project, kind: .finding, text: finding.text,
                        date: finding.date, typeTag: finding.typeTag
                    ))
                }
            }
            for (project, notes) in snapshot.notes {
                for note in notes {
                    docs.append(doc(
                        id: "n:\(store):\(project):\(note.stableId)",
                        store: store, project: project, kind: .note, text: note.text,
                        date: note.date, typeTag: nil
                    ))
                }
            }
            for (project, taskDoc) in snapshot.tasks {
                for task in taskDoc.allItems {
                    docs.append(doc(
                        id: "t:\(store):\(project):\(task.stableId ?? task.id)",
                        store: store, project: project, kind: .task, text: task.line,
                        date: task.createdAt.map { String($0.prefix(10)) }, typeTag: nil
                    ))
                }
            }
            // Truths are the *most* live knowledge in a store — pinned,
            // always injected by the CLI, never decayed — so they belong in
            // the index for exactly the reason archived findings don't.
            for (project, truths) in snapshot.truths {
                for truth in truths {
                    docs.append(doc(
                        id: "p:\(store):\(project):\(truth.id)",
                        store: store, project: project, kind: .truth, text: truth.text,
                        date: truth.addedDate, typeTag: nil
                    ))
                }
            }
            for (project, summary) in snapshot.summaries {
                for (i, paragraph) in summary.components(separatedBy: "\n\n").enumerated() {
                    let trimmed = paragraph.jsTrimmed
                    guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
                    docs.append(doc(
                        id: "s:\(store):\(project):\(i)",
                        store: store, project: project, kind: .summary, text: trimmed,
                        date: nil, typeTag: nil
                    ))
                }
            }
        }
        self.docs = docs
    }

    static func tokenize(_ text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 2 }
    }

    private static func tokenFrequencies(_ text: String) -> [String: Int] {
        var frequencies: [String: Int] = [:]
        for token in tokenize(text) {
            frequencies[token, default: 0] += 1
        }
        return frequencies
    }

    /// Term-frequency scoring with prefix matching on the final query token
    /// (so search feels instant while typing) and a recency boost by date.
    public func search(_ query: String, store: String? = nil, project: String? = nil,
                       kind: DocKind? = nil, typeTag: String? = nil,
                       limit: Int = 50) -> [Result] {
        search(query, store: store, project: project, kind: kind, typeTag: typeTag, limit: limit, now: Date())
    }

    /// One timestamp scores every match consistently and lets tests advance
    /// time without rebuilding the index or depending on the wall clock.
    func search(_ query: String, store: String? = nil, project: String? = nil,
                kind: DocKind? = nil, typeTag: String? = nil,
                limit: Int = 50, now: Date) -> [Result] {
        let queryTokens = Self.tokenize(query)
        guard !queryTokens.isEmpty else { return [] }

        var results: [Result] = []
        for doc in docs {
            if let store, doc.store != store { continue }
            if let project, doc.project != project { continue }
            if let kind, doc.kind != kind { continue }
            if let typeTag, doc.typeTag != typeTag { continue }

            var score = 0.0
            var matchedAll = true
            for (i, token) in queryTokens.enumerated() {
                let isLast = i == queryTokens.count - 1
                if let tf = doc.tokens[token] {
                    score += Double(tf)
                } else if isLast, doc.tokens.keys.contains(where: { $0.hasPrefix(token) }) {
                    score += 0.5
                } else {
                    matchedAll = false
                    break
                }
            }
            guard matchedAll, score > 0 else { continue }

            // Recency boost: newer date headings rank higher.
            if let date = doc.recencyDate {
                score += Self.recencyBoost(date, now: now)
            }
            results.append(Result(
                id: doc.id, store: doc.store, project: doc.project, kind: doc.kind,
                text: doc.text, date: doc.date, typeTag: doc.typeTag, score: score
            ))
        }
        return results.sorted { $0.score > $1.score }.prefix(limit).map { $0 }
    }

    private static func recencyBoost(_ date: Date, now: Date) -> Double {
        let ageDays = max(0, now.timeIntervalSince(date) / 86_400)
        return max(0, 2.0 - ageDays / 90.0)
    }
}
