import Foundation

/// Phone-only visibility. The computer keeps its complete worker history.
public struct AgentWorkHistory: Codable, Sendable {
    public var dismissed: Set<String> = []
    public var firstSeen: [String: Date] = [:]
    public init() {}

    public mutating func observe(_ agents: [AgentChild], scope: String, now: Date) {
        for row in AgentChild.rows(agents, includeCompleted: true) where row.agent.displayState == .failed {
            let key = scope + "/" + row.agent.navigationID
            if firstSeen[key] == nil { firstSeen[key] = now }
        }
    }

    public func failureDate(_ agent: AgentChild, scope: String) -> Date? {
        agent.finishedDate ?? firstSeen[scope + "/" + agent.navigationID]
    }

    public func rows(_ agents: [AgentChild], scope: String, now: Date) -> [AgentChildTreeRow] {
        func collect(_ agents: [AgentChild], depth: Int) -> [AgentChildTreeRow] {
            agents.flatMap { agent in
                let failedRecently = agent.displayState == .failed
                    && !dismissed.contains(scope + "/" + agent.navigationID)
                    && failureDate(agent, scope: scope).map { now.timeIntervalSince($0) < 3_600 } == true
                let visible = agent.displayState == .running || failedRecently
                return (visible ? [AgentChildTreeRow(agent: agent, depth: agent.displayState == .running ? depth : 0)] : [])
                    + collect(agent.children, depth: agent.displayState == .running ? depth + 1 : depth)
            }
        }
        let rows = collect(agents, depth: 0)
        // Preserve each running branch's order; recent failures follow it.
        return rows.filter { $0.agent.displayState == .running }
            + rows.filter { $0.agent.displayState == .failed }.sorted {
                (failureDate($0.agent, scope: scope) ?? .distantPast) > (failureDate($1.agent, scope: scope) ?? .distantPast)
            }
    }

    public func age(_ agent: AgentChild, scope: String, now: Date) -> String? {
        guard let date = failureDate(agent, scope: scope) else { return nil }
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        return "\(minutes / 60)h ago"
    }
}
