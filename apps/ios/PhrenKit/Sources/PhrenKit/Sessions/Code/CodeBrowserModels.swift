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
