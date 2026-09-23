import Foundation

public struct CodeTreeEntry: Decodable, Equatable, Sendable, Identifiable {
    public let path: String
    public let directory: Bool
    public let files: Int
    public let symbols: Int
    public let languages: [String]
    public var id: String { path }
    public var name: String { path.split(separator: "/").last.map(String.init) ?? path }

    public init(path: String, directory: Bool, files: Int, symbols: Int, languages: [String]) {
        self.path = path; self.directory = directory; self.files = files
        self.symbols = symbols; self.languages = languages
    }
}

public struct CodeTreeResults: Decodable, Sendable {
    public let entries: [CodeTreeEntry]
    public static func read(_ data: Data) throws -> [CodeTreeEntry] {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The indexed tree is too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.entries.allSatisfy({ !$0.path.isEmpty && $0.files >= 0 && $0.symbols >= 0 }) else {
            throw PhrenKitError.validation("The indexed tree is invalid.")
        }
        return value.entries
    }
}

public struct CodeUsagePage: Decodable, Equatable, Sendable {
    public let entries: [CodeSymbol]
    public let total: Int
    public let offset: Int
    public let limit: Int
    public let maxUses: Int
    public var hasPrevious: Bool { offset > 0 }
    public var hasNext: Bool { offset + entries.count < total }

    public init(entries: [CodeSymbol], total: Int, offset: Int, limit: Int, maxUses: Int) {
        self.entries = entries; self.total = total; self.offset = offset
        self.limit = limit; self.maxUses = maxUses
    }

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The usage page is too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.total >= 0, value.offset >= 0, (1...100).contains(value.limit),
              value.entries.count <= value.limit, value.entries.count <= value.total,
              value.maxUses >= 0, value.entries.allSatisfy({ $0.uses >= 0 && $0.uses <= value.maxUses }) else {
            throw PhrenKitError.validation("The usage page is invalid.")
        }
        return value
    }
}

public struct CodeRecentSymbol: Decodable, Equatable, Sendable, Identifiable {
    public let symbol: CodeSymbol
    public let indexedAt: Double
    public var id: Int { symbol.id }
    public init(symbol: CodeSymbol, indexedAt: Double) { self.symbol = symbol; self.indexedAt = indexedAt }
    public init(from decoder: Decoder) throws {
        symbol = try CodeSymbol(from: decoder)
        indexedAt = try decoder.container(keyedBy: CodingKeys.self).decode(Double.self, forKey: .indexedAt)
    }
    private enum CodingKeys: CodingKey { case indexedAt }
}

public struct CodeRecentResults: Decodable, Sendable {
    public let entries: [CodeRecentSymbol]
    public static func read(_ data: Data) throws -> [CodeRecentSymbol] {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The recent symbols are too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.entries.count <= 100, value.entries.allSatisfy({ $0.indexedAt >= 0 }) else {
            throw PhrenKitError.validation("The recent symbols are invalid.")
        }
        return value.entries
    }
}

extension CodeSymbol {
    public var qualifiedName: String { "\(file)::\(parent.map { $0 + "." } ?? "")\(name)" }
}

/// A resolved use in one file and the declaration it names, as a
/// file-qualified symbol query (`file::Container.name`).
public struct CodeFileReference: Decodable, Equatable, Sendable {
    public let line: Int
    public let kind: String
    public let name: String
    public let symbol: String
    public let file: String
    public let targetLine: Int
    public let targetKind: String

    public init(line: Int, kind: String, name: String, symbol: String, file: String, targetLine: Int, targetKind: String) {
        self.line = line; self.kind = kind; self.name = name; self.symbol = symbol
        self.file = file; self.targetLine = targetLine; self.targetKind = targetKind
    }
}

public struct CodeFileReferenceResults: Decodable, Sendable {
    public let references: [CodeFileReference]
    public static func read(_ data: Data) throws -> [CodeFileReference] {
        guard data.count <= 4_194_304 else { throw PhrenKitError.validation("The file's references are too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.references.count <= 5_000, value.references.allSatisfy({
            $0.line > 0 && $0.targetLine > 0 && !$0.name.isEmpty && !$0.file.isEmpty && $0.symbol.hasPrefix($0.file + "::")
        }) else { throw PhrenKitError.validation("The file's references are invalid.") }
        return value.references
    }
}

/// Which identifiers in a file the index can resolve, and to what: every
/// declaration in the file's outline and every resolved use, keyed by line.
public struct CodeFileSymbols: Equatable, Sendable {
    public struct Target: Equatable, Sendable {
        public let name: String
        /// File-qualified symbol query for the definition and dossier routes.
        public let symbol: String
        public let file: String
        public let line: Int
    }
    public private(set) var byLine: [Int: [Target]] = [:]
    public init() {}

    public init(path: String, outline: [CodeOutlineEntry], references: [CodeFileReference]) {
        func visit(_ entries: [CodeOutlineEntry], container: String?) {
            for entry in entries {
                let symbol = "\(path)::\(container.map { $0 + "." } ?? "")\(entry.name)"
                add(Target(name: entry.name, symbol: symbol, file: path, line: entry.line), at: entry.line)
                visit(entry.children, container: entry.name)
            }
        }
        visit(outline, container: nil)
        for reference in references {
            add(Target(name: reference.name, symbol: reference.symbol, file: reference.file, line: reference.targetLine), at: reference.line)
        }
    }

    private mutating func add(_ target: Target, at line: Int) {
        guard line > 0, !(byLine[line] ?? []).contains(where: { $0.name == target.name }) else { return }
        byLine[line, default: []].append(target)
    }

    public var isEmpty: Bool { byLine.isEmpty }

    /// Whole-word occurrences of the line's known names, as UTF-16 ranges,
    /// each with its target. A name inside a longer identifier is skipped.
    public func occurrences(in text: String, line: Int) -> [(range: NSRange, target: Target)] {
        guard let targets = byLine[line], !targets.isEmpty else { return [] }
        let source = text as NSString
        var found: [(range: NSRange, target: Target)] = []
        for target in targets {
            var search = NSRange(location: 0, length: source.length)
            while search.length > 0 {
                let range = source.range(of: target.name, options: .literal, range: search)
                guard range.location != NSNotFound else { break }
                if Self.boundary(source, before: range.location), Self.boundary(source, after: NSMaxRange(range)),
                   !found.contains(where: { NSIntersectionRange($0.range, range).length > 0 }) {
                    found.append((range, target))
                }
                let next = NSMaxRange(range)
                search = NSRange(location: next, length: source.length - next)
            }
        }
        return found.sorted { $0.range.location < $1.range.location }
    }

    private static func identifier(_ unit: unichar) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return true }
        return scalar == "_" || scalar == "$" || CharacterSet.alphanumerics.contains(scalar)
    }
    private static func boundary(_ source: NSString, before index: Int) -> Bool { index == 0 || !identifier(source.character(at: index - 1)) }
    private static func boundary(_ source: NSString, after index: Int) -> Bool { index >= source.length || !identifier(source.character(at: index)) }
}
