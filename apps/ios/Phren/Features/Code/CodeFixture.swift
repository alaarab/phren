#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

/// A small fixed code index for UI tests, so the Code screen can be exercised
/// without a Hook. A dozen symbols across three files, chosen to cover a class
/// with a method, a type, a struct and plain functions.
@MainActor
enum CodeFixture {
    static var enabled: Bool { AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--code-fixture") }

    static let symbols: [CodeSymbol] = [
        CodeSymbol(id: 1, name: "add", kind: "function", file: "typescript/app.ts", line: 1, endLine: 3,
                   signature: "export function add(a: number, b: number): number", doc: "Add two numbers.", parent: nil, exported: true, uses: 6),
        CodeSymbol(id: 2, name: "Point", kind: "class", file: "typescript/app.ts", line: 5, endLine: 14,
                   signature: "export class Point", doc: "A point in two dimensions.", parent: nil, exported: true, uses: 4),
        CodeSymbol(id: 3, name: "length", kind: "method", file: "typescript/app.ts", line: 8, endLine: 10,
                   signature: "length(): number", doc: "Distance from the origin.", parent: "Point", exported: false, uses: 3),
        CodeSymbol(id: 4, name: "Coordinate", kind: "interface", file: "typescript/app.ts", line: 16, endLine: 19,
                   signature: "interface Coordinate", doc: "A pair of numbers.", parent: nil, exported: true, uses: 2),
        CodeSymbol(id: 5, name: "Axis", kind: "type", file: "typescript/app.ts", line: 21, endLine: 21,
                   signature: "type Axis = \"x\" | \"y\"", doc: "", parent: nil, exported: true, uses: 1),
        CodeSymbol(id: 6, name: "greet", kind: "function", file: "typescript/util.ts", line: 1, endLine: 4,
                   signature: "export function greet(name: string): string", doc: "Say hello.", parent: nil, exported: true, uses: 5),
        CodeSymbol(id: 7, name: "formatName", kind: "function", file: "typescript/util.ts", line: 6, endLine: 9,
                   signature: "export function formatName(first: string, last: string): string", doc: "", parent: nil, exported: true, uses: 2),
        CodeSymbol(id: 8, name: "helper", kind: "function", file: "typescript/util.ts", line: 11, endLine: 12,
                   signature: "function helper(): void", doc: "Local helper.", parent: nil, exported: false, uses: 1),
        CodeSymbol(id: 9, name: "Service", kind: "class", file: "swift/Service.swift", line: 1, endLine: 10,
                   signature: "final class Service", doc: "Runs work.", parent: nil, exported: true, uses: 3),
        CodeSymbol(id: 10, name: "run", kind: "method", file: "swift/Service.swift", line: 3, endLine: 6,
                   signature: "func run() async throws", doc: "", parent: "Service", exported: false, uses: 2),
        CodeSymbol(id: 11, name: "Request", kind: "struct", file: "swift/Service.swift", line: 12, endLine: 15,
                   signature: "struct Request", doc: "One request.", parent: nil, exported: true, uses: 2),
        CodeSymbol(id: 12, name: "parse", kind: "function", file: "swift/Service.swift", line: 17, endLine: 19,
                   signature: "func parse(_ data: Data) -> Request?", doc: "", parent: nil, exported: true, uses: 1),
    ]

    static var status: CodeStatus {
        CodeStatus(project: "demo", available: true, files: 3, symbols: symbols.count, references: 14,
                   lastIndexedAt: Date.now.timeIntervalSince1970 * 1000,
                   languages: [CodeLanguageCount(language: "typescript", files: 2), CodeLanguageCount(language: "swift", files: 1)],
                   kinds: [CodeKindCount(kind: "function", symbols: 5), CodeKindCount(kind: "class", symbols: 2),
                           CodeKindCount(kind: "method", symbols: 2), CodeKindCount(kind: "interface", symbols: 1),
                           CodeKindCount(kind: "type", symbols: 1), CodeKindCount(kind: "struct", symbols: 1)],
                   top: hot)
    }

    static var hot: [CodeUsageEntry] {
        symbols.sorted { $0.uses > $1.uses }.prefix(5).map(entry)
    }

    static var cold: [CodeUsageEntry] {
        symbols.sorted { $0.uses < $1.uses }.prefix(5).map(entry)
    }

    static var usage: CodeUsage { CodeUsage(hot: hot, cold: cold) }

    static func search(_ query: String) -> [CodeSymbol] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        return symbols
            .filter { $0.name.lowercased().contains(needle) || $0.signature.lowercased().contains(needle) || $0.doc.lowercased().contains(needle) }
            .sorted { lhs, rhs in
                let lhsExact = lhs.name.lowercased() == needle, rhsExact = rhs.name.lowercased() == needle
                if lhsExact != rhsExact { return lhsExact }
                let lhsPrefix = lhs.name.lowercased().hasPrefix(needle), rhsPrefix = rhs.name.lowercased().hasPrefix(needle)
                if lhsPrefix != rhsPrefix { return lhsPrefix }
                return lhs.uses > rhs.uses
            }
    }

    static func tree(_ directory: String) -> [CodeTreeEntry] {
        let prefix = directory.isEmpty ? "" : directory + "/"
        let files = Set(symbols.map(\.file)).filter { $0.hasPrefix(prefix) }
        let paths = Set(files.map { prefix + $0.dropFirst(prefix.count).split(separator: "/").first.map(String.init)! })
        return paths.sorted().map { path in
            let members = files.filter { $0 == path || $0.hasPrefix(path + "/") }
            return CodeTreeEntry(path: path, directory: !files.contains(path), files: members.count,
                                 symbols: symbols.filter { members.contains($0.file) }.count,
                                 languages: Array(Set(members.map { $0.hasSuffix(".swift") ? "swift" : "typescript" })).sorted())
        }
    }

    static func outline(_ file: String) -> [CodeOutlineEntry] {
        func entry(_ symbol: CodeSymbol) -> CodeOutlineEntry {
            CodeOutlineEntry(name: symbol.name, kind: symbol.kind, line: symbol.line, endLine: symbol.endLine,
                             signature: symbol.signature, doc: symbol.doc, exported: symbol.exported, uses: symbol.uses,
                             children: symbols.filter { $0.file == file && $0.parent == symbol.name }.map(entry))
        }
        return symbols.filter { $0.file == file && $0.parent == nil }.map(entry)
    }

    static func page(kind: String, file: String, directory: String, offset: Int, end: Bool) -> CodeUsagePage {
        let rows = symbols.filter {
            (kind.isEmpty || $0.kind == kind || (kind == "types" && ["class", "struct", "enum", "interface", "type"].contains($0.kind))) &&
            (file.isEmpty || $0.file == file) && (directory.isEmpty || $0.file.hasPrefix(directory + "/"))
        }.sorted { $0.uses == $1.uses ? $0.name < $1.name : $0.uses > $1.uses }
        // Deliberately small to exercise crossing page boundaries in UI tests.
        let limit = 5
        let start = end ? max(0, rows.count - limit) : min(offset, rows.count)
        return CodeUsagePage(entries: Array(rows.dropFirst(start).prefix(limit)), total: rows.count, offset: start, limit: limit, maxUses: rows.first?.uses ?? 0)
    }

    static func definition(_ name: String) -> CodeDefinition? {
        guard let symbol = symbol(named: name) else { return nil }
        return CodeDefinition(symbol: symbol, candidates: 1, snippet: snippet(symbol), blame: CodeBlame(authorHash: String(repeating: "a", count: 64), at: "2026-09-20T18:30:00Z"))
    }

    static func references(_ name: String) -> CodeReferences? {
        guard let symbol = symbol(named: name) else { return nil }
        let groups = [
            CodeReferenceGroup(file: symbol.file, references: [CodeReference(line: max(1, symbol.line + 4), kind: "call")]),
            CodeReferenceGroup(file: "typescript/util.ts", references: [CodeReference(line: 3, kind: "call"), CodeReference(line: 12, kind: "call")]),
        ]
        return CodeReferences(symbol: symbol, candidates: 1, groups: groups, total: groups.reduce(0) { $0 + $1.references.count })
    }

    private static func symbol(named name: String) -> CodeSymbol? {
        let needle = name.components(separatedBy: "::").last!.lowercased()
        return symbols.first { $0.name.lowercased() == needle }
            ?? symbols.first { $0.name.lowercased() == needle.components(separatedBy: ".").last }
    }

    private static func entry(_ symbol: CodeSymbol) -> CodeUsageEntry {
        CodeUsageEntry(name: symbol.name, kind: symbol.kind, file: symbol.file, line: symbol.line, exported: symbol.exported, uses: symbol.uses)
    }

    private static func snippet(_ symbol: CodeSymbol) -> String {
        switch symbol.name {
        case "add": return "export function add(a: number, b: number): number {\n  return a + b;\n}"
        case "Point": return "export class Point {\n  constructor(public x: number, public y: number) {}\n\n  length(): number {\n    return Math.hypot(this.x, this.y);\n  }\n}"
        case "greet": return "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}"
        case "Service": return "final class Service {\n  func run() async throws {\n    try await work()\n  }\n}"
        default: return symbol.signature
        }
    }
}
#endif
