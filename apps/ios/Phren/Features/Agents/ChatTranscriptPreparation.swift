import Foundation
import PhrenKit

/// Work tied to transcript changes, never to scrolling, connection ticks, or
/// progressive text reveal. The model runs this value transform off-main.
struct ChatTranscriptPreparation {
    private(set) var entries: [ChatTimelineEntry] = []
    private(set) var jobs: [ChatBackgroundJob] = []
    private(set) var currentToolName: String?
    private(set) var revision = 0
    private var keys: [Key] = []
    private var firstSeen: [String: Date] = [:]
    private var finishedSeen: [String: Date] = [:]
    private struct Key: Equatable {
        let content: String; let timestamp: Date?; let failed: Bool; let queued: Bool; let queueKey: String?
        let images: [Int]; let results: [AgentChatMessage.ImageRef]; let call: String?
    }

    mutating func update(_ messages: [AgentChatMessage], at now: Date = .now) {
        let incoming = messages.map { Key(content: $0.renderKey, timestamp: $0.timestamp, failed: $0.isToolError, queued: $0.isQueued, queueKey: $0.queueKey, images: $0.imageBlocks, results: $0.resultImages, call: $0.toolCallID) }
        guard incoming != keys else { return }
        let started = ChatPerformance.begin()
        defer { ChatPerformance.end("transcript preparation", started) }
        keys = incoming; revision += 1
        entries = ChatTimelineEntry.group(messages)
        for message in messages where message.role != .tool {
            let inline = !message.imageBlocks.isEmpty
            let text = ChatMessageDisplayCache.text(for: message, imagePaths: [], hasImages: false, inlineImages: inline)
            let preview = ToolOutputPreview(text, lines: 40, characters: 6_000)
            _ = ChatRichTextDocumentCache.value(preview.text, key: "\(message.renderKey)|\(inline)|[]|-1")
        }
        jobs = ChatBackgroundJobs.parse(messages, firstSeen: firstSeen, finishedSeen: finishedSeen,
                                        now: now, includeExpired: true)
        for job in jobs {
            firstSeen[job.id] = job.startedAt
            if let date = job.finishedAt { finishedSeen[job.id] = date }
        }
        let retained = Set(jobs.map(\.id))
        firstSeen = firstSeen.filter { retained.contains($0.key) }
        finishedSeen = finishedSeen.filter { retained.contains($0.key) }
        var completed: Set<String> = []
        currentToolName = nil
        for message in messages.reversed() where message.role == .tool {
            if message.isToolResult { if let id = message.toolCallID { completed.insert(id) } }
            else if !message.isChange, message.title != "Background notification",
                    message.toolCallID.map({ !completed.contains($0) }) ?? true {
                currentToolName = message.title; break
            }
        }
    }
}
