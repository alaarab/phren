import Foundation
import PhrenKit

/// One execution recorded by Phren Hook in the computer-local run log.
public struct ScheduleRun: Decodable, Equatable, Identifiable, Sendable {
    public enum Status: String, Decodable, Equatable, Sendable {
        case launched, running, blocked, finished, failed, skipped
    }

    public struct Launch: Decodable, Equatable, Sendable {
        public enum Mode: String, Decodable, Equatable, Sendable { case herdr, headless }

        public let mode: Mode
        public let workspaceID: String?
        public let tabID: String?
        public let paneID: String?
        public let sessionID: String?
        public let jobDir: String?
        public let server: String?

        public init(mode: Mode, workspaceID: String? = nil, tabID: String? = nil,
                    paneID: String? = nil, sessionID: String? = nil, jobDir: String? = nil, server: String? = nil) {
            self.mode = mode
            self.workspaceID = workspaceID
            self.tabID = tabID
            self.paneID = paneID
            self.sessionID = sessionID
            self.jobDir = jobDir
            self.server = server
        }

        private enum CodingKeys: String, CodingKey {
            case mode, jobDir, server
            case workspaceID = "workspaceId"
            case tabID = "tabId"
            case paneID = "paneId"
            case sessionID = "sessionId"
        }
    }

    public let id: String
    public let scheduleID: String
    public let project: String
    public let startedAt: Date
    public let finishedAt: Date?
    public let status: Status
    public let reason: String?
    public let blockedStartupPrompt: String?
    public let notified: Bool?
    public let notifyReason: String?
    public let launch: Launch

    public init(id: String, scheduleID: String, project: String, startedAt: Date,
                finishedAt: Date? = nil, status: Status, reason: String? = nil,
                blockedStartupPrompt: String? = nil,
                notified: Bool? = nil, notifyReason: String? = nil, launch: Launch) {
        self.id = id
        self.scheduleID = scheduleID
        self.project = project
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.status = status
        self.reason = reason
        self.blockedStartupPrompt = blockedStartupPrompt
        self.notified = notified
        self.notifyReason = notifyReason
        self.launch = launch
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        scheduleID = try values.decode(String.self, forKey: .scheduleID)
        project = try values.decode(String.self, forKey: .project)
        startedAt = try scheduleTimestamp(values.decode(String.self, forKey: .startedAt))
        finishedAt = try values.decodeIfPresent(String.self, forKey: .finishedAt).map(scheduleTimestamp)
        status = try values.decode(Status.self, forKey: .status)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        blockedStartupPrompt = try values.decodeIfPresent(String.self, forKey: .blockedStartupPrompt)
        notified = try values.decodeIfPresent(Bool.self, forKey: .notified)
        notifyReason = try values.decodeIfPresent(String.self, forKey: .notifyReason)
        launch = try values.decode(Launch.self, forKey: .launch)
    }

    private enum CodingKeys: String, CodingKey {
        case id, project, startedAt, finishedAt, status, reason, blockedStartupPrompt, notified, notifyReason, launch
        case scheduleID = "scheduleId"
    }
}

/// A stored schedule plus the selected computer's computed and local state.
public struct ScheduleStatus: Decodable, Equatable, Identifiable, Sendable {
    public let schedule: Schedule
    public let project: String
    public let nextRun: Date?
    public let lastRun: ScheduleRun?
    public let running: Bool

    public var id: String { schedule.id }
    public var name: String { schedule.name }
    public var enabled: Bool { schedule.enabled }
    public var computer: String { schedule.computer }
    public var harness: Schedule.Harness { schedule.harness }
    public var model: String? { schedule.model }
    public var every: Schedule.Every { schedule.every }
    public var prompt: String { schedule.prompt }
    public var createdAt: Date { schedule.createdAt }
    public var updatedAt: Date { schedule.updatedAt }

    public init(schedule: Schedule, project: String, nextRun: Date?,
                lastRun: ScheduleRun?, running: Bool) {
        self.schedule = schedule
        self.project = project
        self.nextRun = nextRun
        self.lastRun = lastRun
        self.running = running
    }

    private enum CodingKeys: String, CodingKey { case project, nextRun, lastRun, running }

    public init(from decoder: Decoder) throws {
        schedule = try Schedule(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        project = try values.decode(String.self, forKey: .project)
        nextRun = try values.decodeIfPresent(String.self, forKey: .nextRun).map(scheduleTimestamp)
        // /v1/schedules omits history identity fields from lastRun.
        if let last = try values.decodeIfPresent(LastRun.self, forKey: .lastRun) {
            lastRun = ScheduleRun(id: last.id ?? "latest-\(schedule.id)", scheduleID: schedule.id,
                project: project, startedAt: try scheduleTimestamp(last.startedAt),
                finishedAt: try last.finishedAt.map(scheduleTimestamp), status: last.status,
                reason: last.reason, blockedStartupPrompt: last.blockedStartupPrompt,
                notified: last.notified, notifyReason: last.notifyReason,
                launch: last.launch)
        } else { lastRun = nil }
        running = try values.decode(Bool.self, forKey: .running)
    }

    private struct LastRun: Decodable {
        let id: String?
        let startedAt: String
        let finishedAt: String?
        let status: ScheduleRun.Status
        let reason: String?
        let blockedStartupPrompt: String?
        let notified: Bool?
        let notifyReason: String?
        let launch: ScheduleRun.Launch
    }
}

public struct ScheduleSnapshot: Decodable, Sendable {
    public let computer: String
    public let timeZone: String?
    public let schedules: [ScheduleStatus]

    public init(computer: String, timeZone: String?, schedules: [ScheduleStatus]) {
        self.computer = computer; self.timeZone = timeZone; self.schedules = schedules
    }
}

extension PhrenConnection {
    public static func schedules(host: LiveHost, privateKey: Data) async throws -> [ScheduleStatus] {
        try await scheduleSnapshot(host: host, privateKey: privateKey).schedules
    }

    public static func scheduleSnapshot(host: LiveHost, privateKey: Data) async throws -> ScheduleSnapshot {
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey),
                                       request: schedulesRequest())
        return try JSONDecoder().decode(ScheduleSnapshot.self, from: data)
    }

    public static func runSchedule(host: LiveHost, privateKey: Data,
                                   project: String, id: String) async throws -> ScheduleRun {
        struct Response: Decodable { let ok: Bool; let run: ScheduleRun }
        let request = try runScheduleRequest(project: project, id: id)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.ok else { throw PhrenKitError.validation("The computer did not confirm the scheduled run.") }
        return response.run
    }

    public static func scheduleHistory(host: LiveHost, privateKey: Data,
                                       project: String? = nil, id: String? = nil,
                                       limit: Int = 50) async throws -> [ScheduleRun] {
        struct Response: Decodable { let runs: [ScheduleRun] }
        let request = try scheduleHistoryRequest(project: project, id: id, limit: limit)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try JSONDecoder().decode(Response.self, from: data).runs
    }

    static func schedulesRequest() -> GatewayRequest {
        GatewayRequest(path: "/v1/schedules", body: Data("{}".utf8))
    }

    static func runScheduleRequest(project: String, id: String) throws -> GatewayRequest {
        try validateSchedule(project: project, id: id)
        let body = try JSONSerialization.data(withJSONObject: ["project": project, "id": id], options: [.sortedKeys])
        return GatewayRequest(path: "/v1/schedules/run", body: body)
    }

    static func scheduleHistoryRequest(project: String?, id: String?, limit: Int) throws -> GatewayRequest {
        var body: [String: Any] = ["limit": min(500, max(1, limit))]
        if let project {
            try validateScheduleProject(project)
            body["project"] = project
        }
        if let id {
            try validateScheduleID(id)
            body["id"] = id
        }
        return GatewayRequest(path: "/v1/schedules/history",
                              body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
    }

    private static func validateSchedule(project: String, id: String) throws {
        try validateScheduleProject(project)
        try validateScheduleID(id)
    }

    private static func validateScheduleProject(_ project: String) throws {
        guard project.range(of: #"^[a-z0-9][a-z0-9-]{0,99}$"#, options: .regularExpression) != nil else {
            throw PhrenKitError.validation("Invalid project name.")
        }
    }

    private static func validateScheduleID(_ id: String) throws {
        guard id.range(of: #"^[0-9a-f]{8}$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            throw PhrenKitError.validation("Invalid schedule id.")
        }
    }
}

private func scheduleTimestamp(_ value: String) throws -> Date {
    guard let date = ISO8601Dates.parse(value) else {
        throw PhrenKitError.validation("Invalid schedule timestamp.")
    }
    return date
}
