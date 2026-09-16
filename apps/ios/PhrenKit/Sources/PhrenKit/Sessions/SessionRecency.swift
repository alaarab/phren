import Foundation

public enum SessionRecency {
    public static func ordered(_ sessions: [LiveAgentSession]) -> [LiveAgentSession] {
        sessions.sorted { lhs, rhs in
            let left = lhs.tab.lastChangedAt ?? .distantPast, right = rhs.tab.lastChangedAt ?? .distantPast
            if left != right { return left > right }
            if lhs.host.id == rhs.host.id, lhs.tab.changedSeq != rhs.tab.changedSeq {
                return (lhs.tab.changedSeq ?? Int.min) > (rhs.tab.changedSeq ?? Int.min)
            }
            return (lhs.host.name, lhs.host.id.uuidString, lhs.workspaceID, lhs.tab.id)
                < (rhs.host.name, rhs.host.id.uuidString, rhs.workspaceID, rhs.tab.id)
        }
    }
}
