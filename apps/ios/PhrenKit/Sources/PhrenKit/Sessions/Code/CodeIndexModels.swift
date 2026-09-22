import Foundation

/// Wire models for the `code` module's Hook routes.
///
/// They mirror the TypeScript shapes in `packages/cli/src/code/query.ts` and
/// `status.ts`: search hits, file outlines, a definition with its snippet,
/// references grouped by file, hot and cold usage, and the project status the
/// Code cell reads. The Hook is the only producer, so these decode the route
/// envelopes and validate their bounds; the views never see raw JSON.

public struct CodeSymbol: Decodable, Equatable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let kind: String
    public let file: String
    public let line: Int
    public let endLine: Int
    public let signature: String
    public let doc: String
    public let parent: String?
    public let exported: Bool
    public let uses: Int

    public init(id: Int, name: String, kind: String, file: String, line: Int, endLine: Int,
                signature: String, doc: String, parent: String?, exported: Bool, uses: Int) {
        self.id = id
        self.name = name
        self.kind = kind
        self.file = file
        self.line = line
        self.endLine = endLine
        self.signature = signature
        self.doc = doc
        self.parent = parent
        self.exported = exported
        self.uses = uses
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(Int.self, forKey: .id) ?? 0
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "unknown"
        file = try values.decodeIfPresent(String.self, forKey: .file) ?? ""
        line = try values.decodeIfPresent(Int.self, forKey: .line) ?? 0
        endLine = try values.decodeIfPresent(Int.self, forKey: .endLine) ?? 0
        signature = try values.decodeIfPresent(String.self, forKey: .signature) ?? ""
        doc = try values.decodeIfPresent(String.self, forKey: .doc) ?? ""
        parent = try values.decodeIfPresent(String.self, forKey: .parent)
        exported = try values.decodeIfPresent(Bool.self, forKey: .exported) ?? false
        uses = try values.decodeIfPresent(Int.self, forKey: .uses) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case id, name, kind, file, line, endLine, signature, doc, parent, exported, uses }

    /// A row's short location, `file:line`.
    public var location: String { "\(file):\(line)" }
    /// The file's base name, for a compact row.
    public var fileName: String { file.split(separator: "/").last.map(String.init) ?? file }
}

public struct CodeOutlineEntry: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let kind: String
    public let line: Int
    public let endLine: Int
    public let signature: String
    public let doc: String
    public let exported: Bool
    public let uses: Int
    public let children: [CodeOutlineEntry]

    public var id: String { "\(name)#\(line)" }

    public init(name: String, kind: String, line: Int, endLine: Int, signature: String, doc: String,
                exported: Bool, uses: Int, children: [CodeOutlineEntry]) {
        self.name = name
        self.kind = kind
        self.line = line
        self.endLine = endLine
        self.signature = signature
        self.doc = doc
        self.exported = exported
        self.uses = uses
        self.children = children
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "unknown"
        line = try values.decodeIfPresent(Int.self, forKey: .line) ?? 0
        endLine = try values.decodeIfPresent(Int.self, forKey: .endLine) ?? 0
        signature = try values.decodeIfPresent(String.self, forKey: .signature) ?? ""
        doc = try values.decodeIfPresent(String.self, forKey: .doc) ?? ""
        exported = try values.decodeIfPresent(Bool.self, forKey: .exported) ?? false
        uses = try values.decodeIfPresent(Int.self, forKey: .uses) ?? 0
        children = try values.decodeIfPresent([CodeOutlineEntry].self, forKey: .children) ?? []
    }

    private enum CodingKeys: String, CodingKey { case name, kind, line, endLine, signature, doc, exported, uses, children }
}

/// The last commit touching a symbol's file: a hash of the git author and a date,
/// never a name.
public struct CodeBlame: Decodable, Equatable, Sendable {
    public let authorHash: String
    public let at: String
    public init(authorHash: String, at: String) { self.authorHash = authorHash; self.at = at }
}

public struct CodeDefinition: Decodable, Equatable, Sendable {
    public let symbol: CodeSymbol
    public let candidates: Int
    public let snippet: String
    public let findings: [CodeFinding]
    public let blame: CodeBlame?

    public init(symbol: CodeSymbol, candidates: Int, snippet: String, blame: CodeBlame?, findings: [CodeFinding] = []) {
        self.symbol = symbol
        self.candidates = candidates
        self.snippet = snippet
        self.blame = blame
        self.findings = findings
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        symbol = try values.decode(CodeSymbol.self, forKey: .symbol)
        candidates = try values.decodeIfPresent(Int.self, forKey: .candidates) ?? 1
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        blame = try values.decodeIfPresent(CodeBlame.self, forKey: .blame)
        findings = try values.decodeIfPresent([CodeFinding].self, forKey: .findings) ?? []
    }

    private enum CodingKeys: String, CodingKey { case symbol, candidates, snippet, blame, findings }
}

public struct CodeReference: Decodable, Equatable, Sendable {
    public let line: Int
    public let kind: String
    public init(line: Int, kind: String) { self.line = line; self.kind = kind }
}

public struct CodeReferenceGroup: Decodable, Equatable, Sendable, Identifiable {
    public let file: String
    public let references: [CodeReference]
    public var id: String { file }
    public init(file: String, references: [CodeReference]) { self.file = file; self.references = references }
}

public struct CodeReferences: Decodable, Equatable, Sendable {
    public let symbol: CodeSymbol
    public let candidates: Int
    public let groups: [CodeReferenceGroup]
    public let total: Int

    public init(symbol: CodeSymbol, candidates: Int, groups: [CodeReferenceGroup], total: Int) {
        self.symbol = symbol
        self.candidates = candidates
        self.groups = groups
        self.total = total
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        symbol = try values.decode(CodeSymbol.self, forKey: .symbol)
        candidates = try values.decodeIfPresent(Int.self, forKey: .candidates) ?? 1
        groups = try values.decodeIfPresent([CodeReferenceGroup].self, forKey: .groups) ?? []
        total = try values.decodeIfPresent(Int.self, forKey: .total) ?? groups.reduce(0) { $0 + $1.references.count }
    }

    private enum CodingKeys: String, CodingKey { case symbol, candidates, groups, total }
}

public struct CodeUsageEntry: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let kind: String
    public let file: String
    public let line: Int
    public let exported: Bool
    public let uses: Int

    public var id: String { "\(file):\(line):\(name)" }

    public init(name: String, kind: String, file: String, line: Int, exported: Bool, uses: Int) {
        self.name = name
        self.kind = kind
        self.file = file
        self.line = line
        self.exported = exported
        self.uses = uses
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "unknown"
        file = try values.decodeIfPresent(String.self, forKey: .file) ?? ""
        line = try values.decodeIfPresent(Int.self, forKey: .line) ?? 0
        exported = try values.decodeIfPresent(Bool.self, forKey: .exported) ?? false
        uses = try values.decodeIfPresent(Int.self, forKey: .uses) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case name, kind, file, line, exported, uses }
}

public struct CodeUsage: Decodable, Equatable, Sendable {
    public let hot: [CodeUsageEntry]
    public let cold: [CodeUsageEntry]
    public init(hot: [CodeUsageEntry], cold: [CodeUsageEntry]) { self.hot = hot; self.cold = cold }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        hot = try values.decodeIfPresent([CodeUsageEntry].self, forKey: .hot) ?? []
        cold = try values.decodeIfPresent([CodeUsageEntry].self, forKey: .cold) ?? []
    }
    private enum CodingKeys: String, CodingKey { case hot, cold }
}

public struct CodeLanguageCount: Decodable, Equatable, Sendable {
    public let language: String
    public let files: Int
    public init(language: String, files: Int) { self.language = language; self.files = files }
}

public struct CodeKindCount: Decodable, Equatable, Sendable {
    public let kind: String
    public let symbols: Int
    public init(kind: String, symbols: Int) { self.kind = kind; self.symbols = symbols }
}

public struct CodeStatus: Decodable, Equatable, Sendable {
    public let project: String
    public let available: Bool
    public let files: Int
    public let symbols: Int
    public let references: Int
    public let lastIndexedAt: Double?
    public let languages: [CodeLanguageCount]
    public let kinds: [CodeKindCount]
    public let top: [CodeUsageEntry]

    public init(project: String, available: Bool, files: Int, symbols: Int, references: Int,
                lastIndexedAt: Double?, languages: [CodeLanguageCount], kinds: [CodeKindCount], top: [CodeUsageEntry]) {
        self.project = project
        self.available = available
        self.files = files
        self.symbols = symbols
        self.references = references
        self.lastIndexedAt = lastIndexedAt
        self.languages = languages
        self.kinds = kinds
        self.top = top
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        project = try values.decodeIfPresent(String.self, forKey: .project) ?? ""
        available = try values.decodeIfPresent(Bool.self, forKey: .available) ?? false
        files = try values.decodeIfPresent(Int.self, forKey: .files) ?? 0
        symbols = try values.decodeIfPresent(Int.self, forKey: .symbols) ?? 0
        references = try values.decodeIfPresent(Int.self, forKey: .references) ?? 0
        lastIndexedAt = try values.decodeIfPresent(Double.self, forKey: .lastIndexedAt)
        languages = try values.decodeIfPresent([CodeLanguageCount].self, forKey: .languages) ?? []
        kinds = try values.decodeIfPresent([CodeKindCount].self, forKey: .kinds) ?? []
        top = try values.decodeIfPresent([CodeUsageEntry].self, forKey: .top) ?? []
    }

    private enum CodingKeys: String, CodingKey { case project, available, files, symbols, references, lastIndexedAt, languages, kinds, top }

    public static func read(_ data: Data) throws -> CodeStatus {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The code index status is too large.") }
        let value: CodeStatus
        do { value = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw PhrenKitError.validation("The computer returned an unusable code index status. Refresh to try again.") }
        guard value.symbols >= 0, value.files >= 0, value.references >= 0,
              value.languages.count <= 200, value.kinds.count <= 200, value.top.count <= 100 else {
            throw PhrenKitError.validation("The code index status is invalid.")
        }
        return value
    }
}

// MARK: - Route envelopes

public struct CodeSearchResults: Decodable, Sendable {
    public let project: String
    public let query: String
    public let symbols: [CodeSymbol]
    public static func read(_ data: Data) throws -> [CodeSymbol] {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The symbol search result is too large.") }
        do { return try JSONDecoder().decode(Self.self, from: data).symbols }
        catch { throw PhrenKitError.validation("The computer returned an unusable symbol search. Refresh to try again.") }
    }
}

public struct CodeOutlineResults: Decodable, Sendable {
    public let project: String
    public let path: String
    public let entries: [CodeOutlineEntry]
    public static func read(_ data: Data) throws -> [CodeOutlineEntry] {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The outline is too large.") }
        do { return try JSONDecoder().decode(Self.self, from: data).entries }
        catch { throw PhrenKitError.validation("The computer returned an unusable outline. Refresh to try again.") }
    }
}

public struct CodeDefinitionResults: Decodable, Sendable {
    public let project: String
    public let definition: CodeDefinition
    public static func read(_ data: Data) throws -> CodeDefinition {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The definition is too large.") }
        do { return try JSONDecoder().decode(Self.self, from: data).definition }
        catch { throw PhrenKitError.validation("The computer returned an unusable definition. Refresh to try again.") }
    }
}

public struct CodeReferencesResults: Decodable, Sendable {
    public let project: String
    public let references: CodeReferences
    public static func read(_ data: Data) throws -> CodeReferences {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The reference list is too large.") }
        do { return try JSONDecoder().decode(Self.self, from: data).references }
        catch { throw PhrenKitError.validation("The computer returned an unusable reference list. Refresh to try again.") }
    }
}

public struct CodeUsageResults: Decodable, Sendable {
    public let project: String
    public let usage: CodeUsage
    public static func read(_ data: Data) throws -> CodeUsage {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The usage list is too large.") }
        do { return try JSONDecoder().decode(Self.self, from: data).usage }
        catch { throw PhrenKitError.validation("The computer returned an unusable usage list. Refresh to try again.") }
    }
}


public struct CodeOutlineSummary: Decodable, Equatable, Sendable, Identifiable {
    public struct Kind: Decodable, Equatable, Sendable {
        public let kind: String
        public let count: Int
    }
    public let path: String
    public let symbols: Int
    public let kinds: [Kind]
    public let symbol: String?
    public var id: String { path }
    public var label: String { (["\(symbols)"] + kinds.map(\.kind)).joined(separator: " · ") }
}
public struct CodeOutlineSummaryResults: Decodable, Sendable {
    public let entries: [CodeOutlineSummary]
    public static func read(_ data: Data) throws -> [CodeOutlineSummary] {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The outline summary is too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.entries.count <= 200, value.entries.allSatisfy({ $0.symbols >= 0 && $0.kinds.count <= 3 }) else {
            throw PhrenKitError.validation("The outline summary is invalid.")
        }
        return value.entries
    }
}
