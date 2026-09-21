import Foundation
import PhrenKit

enum ToolPresentationCache {
    final class Box: NSObject { let value: ToolPresentation; init(_ value: ToolPresentation) { self.value = value } }
    static let values: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 500; cache.totalCostLimit = 24 * 1_024 * 1_024; return cache
    }()
    static func value(_ message: AgentChatMessage) -> ToolPresentation {
        let key = message.renderKey as NSString
        if let cached = values.object(forKey: key) {
            ChatRenderCacheMetrics.record("tool", hit: true)
            return cached.value
        }
        ChatRenderCacheMetrics.record("tool", hit: false)
        let started = CFAbsoluteTimeGetCurrent()
        let value = ToolPresentation(title: message.title ?? "Tool", text: message.text)
        values.setObject(Box(value), forKey: key, cost: message.textByteCount * 2)
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] parsed tool \(message.id): \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
        }
        #endif
        return value
    }
}

enum DiffDocumentCache {
    final class Box: NSObject { let value: DiffDocument; init(_ value: DiffDocument) { self.value = value } }
    private static let values: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 250; cache.totalCostLimit = 32 * 1_024 * 1_024; return cache
    }()
    static func value(for patch: String, key suppliedKey: String? = nil) -> DiffDocument {
        let key = (suppliedKey ?? "\(patch.utf8.count)|\(patch.hashValue)") as NSString
        if let cached = values.object(forKey: key) {
            ChatRenderCacheMetrics.record("diff", hit: true)
            return cached.value
        }
        ChatRenderCacheMetrics.record("diff", hit: false)
        let started = CFAbsoluteTimeGetCurrent()
        let document = DiffDocument(patch: patch)
        values.setObject(Box(document), forKey: key, cost: patch.utf8.count * 4)
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] parsed diff \(patch.utf8.count) bytes: \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
        }
        #endif
        return document
    }
}

enum DiffDocumentSummaryCache {
    final class Box: NSObject { let value: DiffDocumentSummary; init(_ value: DiffDocumentSummary) { self.value = value } }
    private static let values: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 500; cache.totalCostLimit = 8 * 1_024 * 1_024; return cache
    }()
    static func value(for patch: String, key suppliedKey: String? = nil) -> DiffDocumentSummary {
        let key = (suppliedKey ?? "\(patch.utf8.count)|\(patch.hashValue)") as NSString
        if let cached = values.object(forKey: key) { return cached.value }
        let summary = DiffDocumentSummary(patch: patch)
        values.setObject(Box(summary), forKey: key, cost: patch.utf8.count)
        return summary
    }
}

enum ChatMessageDisplayCache {
    static let values: NSCache<NSString, NSString> = {
        let cache = NSCache<NSString, NSString>(); cache.countLimit = 1_000; cache.totalCostLimit = 16 * 1_024 * 1_024; return cache
    }()
    private static let imageMarker = try! NSRegularExpression(pattern: #"\[Image #\d+\]|\[Image attachment\]"#)

    static func text(for message: AgentChatMessage, imagePaths: [String], hasImages: Bool, inlineImages: Bool) -> String {
        let paths = imagePaths.sorted()
        let key = "\(message.renderKey)|\(inlineImages)|\(hasImages)|\(paths.joined(separator: "|"))" as NSString
        if let cached = values.object(forKey: key) {
            ChatRenderCacheMetrics.record("message", hit: true)
            return cached as String
        }
        ChatRenderCacheMetrics.record("message", hit: false)
        let started = CFAbsoluteTimeGetCurrent()
        var text = message.text
        let marker = "Attached files on this computer:"
        if let section = text.range(of: marker, options: .backwards),
           section.lowerBound == text.startIndex || text[text.index(before: section.lowerBound)].isNewline {
            let listed = text[section.upperBound...].components(separatedBy: "\n").filter { !$0.isEmpty }
            let previewPaths = Set(paths)
            if inlineImages || (hasImages && listed.allSatisfy({ previewPaths.contains($0) })) {
                text = String(text[..<section.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if inlineImages || hasImages {
            text = imageMarker.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        values.setObject(text as NSString, forKey: key, cost: text.utf8.count)
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] prepared message \(message.id): \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
        }
        #endif
        return text
    }
}
