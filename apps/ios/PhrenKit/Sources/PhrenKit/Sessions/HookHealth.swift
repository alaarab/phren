import Foundation

/// One computer's health as Phren Hook reports it at `GET /v1/health/details`:
/// tool versions, store sync, the last scheduled run, its peers (with whether
/// each lists this computer back), approval push and the last canary run.
public struct HookHealth: Decodable, Equatable, Sendable {
    public struct Computer: Decodable, Equatable, Sendable {
        public let name: String
        public let id: String?
    }

    public struct ToolVersion: Decodable, Equatable, Sendable, Identifiable {
        public let tool: String
        /// `ok`, `missing` (not installed) or `error`.
        public let status: String
        public let version: String?
        public let detail: String?
        public var id: String { tool }

        public var title: String {
            switch tool {
            case "hook": "Phren Hook"
            case "herdr": "Herdr"
            case "claude": "Claude Code"
            case "codex": "Codex"
            case "copilot": "Copilot"
            case "opencode": "OpenCode"
            default: tool
            }
        }

        public var summary: String {
            switch status {
            case "ok": version ?? "installed"
            case "missing": tool == "hook" ? "Not running" : "Not installed"
            default: detail ?? "Unknown"
            }
        }
    }

    public struct StoreSync: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let role: String
        public let available: Bool
        public let branch: String?
        public let upstream: String?
        public let ahead: Int?
        public let behind: Int?
        public let lastPushStatus: String?
        public let lastPushAt: String?
        public let lastSuccessfulPushAt: String?
        public let consecutiveFailures: Int?
        public let error: String?
        public let degraded: Bool
        public var id: String { name }

        /// "main · 2 ahead, 0 behind", or why there are no counts.
        public var position: String {
            let branch = branch ?? "no branch"
            guard let ahead, let behind else { return upstream == nil ? "\(branch) · no upstream" : branch }
            return "\(branch) · \(ahead) ahead, \(behind) behind"
        }
    }

    public struct ScheduledRun: Decodable, Equatable, Sendable {
        public let name: String?
        public let project: String
        public let status: String
        public let reason: String?
        public let startedAt: String
        public let finishedAt: String?
    }

    public struct Schedules: Decodable, Equatable, Sendable {
        /// Nil when the answer came from outside a running Hook.
        public let running: Bool?
        public let lastTickAt: String?
        public let lastRun: ScheduledRun?
    }

    public struct Peer: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let reachable: Bool
        public let ms: Int
        public let error: String?
        public let version: String?
        /// Whether the peer's own hooks.yaml lists this computer; nil when its Hook is too old to say.
        public let listsBack: Bool?
        public var id: String { name }
        /// Reachable from here, but it cannot reach back: a one-way link.
        public var oneWay: Bool { reachable && listsBack == false }
    }

    public struct Peers: Decodable, Equatable, Sendable {
        public let configured: Bool
        public let error: String?
        public let computers: [Peer]
    }

    public struct Push: Decodable, Equatable, Sendable {
        public let configured: Bool
        public let devices: Int?
    }

    public struct CanaryStep: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        /// `ok`, `failed` or `skipped`.
        public let status: String
        public let durationMs: Int
        public let reason: String?
        public let detail: String?
        public var id: String { name }
    }

    public struct Canary: Decodable, Equatable, Sendable {
        public let trigger: String
        public let startedAt: String
        public let finishedAt: String
        public let durationMs: Int
        public let ok: Bool
        public let steps: [CanaryStep]
    }

    public let computer: Computer
    public let checkedAt: String
    public let versions: [ToolVersion]
    public let stores: [StoreSync]
    public let schedules: Schedules
    public let peers: Peers
    public let push: Push
    public let canary: Canary?

    public var oneWayPeers: [Peer] { peers.computers.filter(\.oneWay) }
    public var failingStores: [StoreSync] { stores.filter { $0.error != nil } }

    /// Anything a person should look at: a sync error, an unreachable or
    /// one-way peer, a failed scheduled run or a failed canary.
    public var needsAttention: Bool {
        !failingStores.isEmpty || peers.error != nil || peers.computers.contains { !$0.reachable || $0.oneWay }
            || schedules.lastRun?.status == "failed" || canary?.ok == false
    }

    public static func decode(_ data: Data) throws -> HookHealth {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The health response is too large.") }
        return try JSONDecoder().decode(HookHealth.self, from: data)
    }
}
