import PhrenKit
import Foundation

/// A card's presentation parsed once per call/result pair, for the rows
/// that only have the messages in hand (a card inside an expanded read
/// run). Keyed by the render keys, so an appended result re-parses and an
/// unchanged pair never does — the parse walks up to half a megabyte of
/// JSON, which is not per-body work.
final class ToolCardCache<Value> {
    private final class Box: NSObject { let value: Value?; init(_ value: Value?) { self.value = value } }
    private let values: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 400; return cache
    }()
    func value(_ messages: [AgentChatMessage], make: (_ call: AgentChatMessage, _ result: AgentChatMessage?) -> Value?) -> Value? {
        guard let call = messages.first(where: { $0.role == .tool && !$0.isToolResult && !$0.isChange }) else { return nil }
        let result = messages.first(where: \.isToolResult)
        let key = "\(call.renderKey)|\(result?.renderKey ?? "")" as NSString
        if let cached = values.object(forKey: key) { return cached.value }
        let value = make(call, result)
        values.setObject(Box(value), forKey: key)
        return value
    }
}
