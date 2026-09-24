import Foundation

public struct CodeFinding: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let stableId: String?
    public let text: String
    public let symbol: String
}
public struct CodeNoteRequest: Encodable, Sendable {
    public struct Target: Encodable, Sendable {
        public let session: String?
        public let harness: String?
        public init(session: String) { self.session = session; harness = nil }
        public init(harness: String) { self.harness = harness; session = nil }
    }
    public let store: String?
    public let project: String
    public let symbol: String
    public let file: String
    public let line: Int
    public let text: String
    public let target: Target?
    public init(project: String, symbol: String, file: String, line: Int, text: String, target: Target? = nil, store: String? = nil) {
        self.store = store
        self.project = project; self.symbol = symbol; self.file = file
        self.line = line; self.text = text; self.target = target
    }
}
public struct CodeNoteResult: Decodable, Sendable {
    public struct Delivery: Decodable, Sendable {
        public let ok: Bool?
        public let delivered: Bool?
        public let state: String?
        public let message: String?
        public let error: String?
        public var confirmed: Bool { delivered == true || state == "accepted" || (ok == true && delivered != false) }
    }
    public let ok: Bool
    public let saved: Bool
    public let findings: [CodeFinding]
    public let delivery: Delivery?
}
