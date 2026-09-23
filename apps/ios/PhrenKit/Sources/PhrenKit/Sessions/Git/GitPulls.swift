import Foundation

/// `/v1/git/pulls` on the computer: the GitHub CLI's open pull requests for
/// the pane's repository, normalized to flat fields. `available` is false when
/// `gh` is missing or not signed in, which is a state rather than an error.
/// `current` is the checked-out branch's own pull request in any state, with
/// its checks rolled up, for the session card.
public struct GitPulls: Decodable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case open, merged, closed, unknown

        /// GitHub spells its states in caps and can grow new ones; an
        /// unrecognized value reads as `unknown` instead of failing the list.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = State(rawValue: raw.lowercased()) ?? .unknown
        }
    }

    /// The branch's checks as one word: any failure fails, anything
    /// unfinished is pending.
    public enum Checks: String, Codable, Sendable {
        case passing, failing, pending
    }

    public struct Pull: Decodable, Equatable, Sendable, Identifiable {
        public let number: Int
        public let title: String
        public let head: String
        public let base: String
        public let author: String
        public let url: String
        public let draft: Bool
        public let state: State
        /// GitHub's `updatedAt`, an ISO 8601 string.
        public let updated: String
        public var id: Int { number }
        public var updatedDate: Date? { ISO8601Dates.parse(updated) }
    }

    /// The current branch's pull request. Codable so the session card's cache
    /// can keep it across launches.
    public struct Current: Codable, Equatable, Sendable {
        public let number: Int
        public let title: String
        public let url: String
        public let head: String
        public let base: String
        public let draft: Bool
        public let state: State
        public let checks: Checks?

        public init(number: Int, title: String, url: String, head: String, base: String, draft: Bool, state: State, checks: Checks?) {
            self.number = number; self.title = title; self.url = url; self.head = head; self.base = base
            self.draft = draft; self.state = state; self.checks = checks
        }

        private enum CodingKeys: String, CodingKey { case number, title, url, head, base, draft, state, checks }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            number = try values.decode(Int.self, forKey: .number)
            title = try values.decodeIfPresent(String.self, forKey: .title) ?? ""
            url = try values.decodeIfPresent(String.self, forKey: .url) ?? ""
            head = try values.decodeIfPresent(String.self, forKey: .head) ?? ""
            base = try values.decodeIfPresent(String.self, forKey: .base) ?? ""
            draft = try values.decodeIfPresent(Bool.self, forKey: .draft) ?? false
            state = try values.decodeIfPresent(State.self, forKey: .state) ?? .unknown
            // A rollup word this build does not know reads as no checks.
            checks = (try? values.decodeIfPresent(String.self, forKey: .checks)).flatMap { Checks(rawValue: $0) }
        }

        /// The one word the card shows: draft wins over open.
        public var stateLabel: String {
            if draft && state == .open { return "draft" }
            return state == .unknown ? "unknown" : state.rawValue
        }
    }

    public let available: Bool
    public let pulls: [Pull]
    /// The checked-out branch, or nil when HEAD is detached (or an older Hook).
    public let branch: String?
    public let current: Current?

    public init(available: Bool, pulls: [Pull], branch: String? = nil, current: Current? = nil) {
        self.available = available; self.pulls = pulls; self.branch = branch; self.current = current
    }

    private enum CodingKeys: String, CodingKey { case available, pulls, branch, current }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        available = try values.decode(Bool.self, forKey: .available)
        pulls = try values.decode([Pull].self, forKey: .pulls)
        branch = try values.decodeIfPresent(String.self, forKey: .branch)
        current = try values.decodeIfPresent(Current.self, forKey: .current)
    }

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The pull request list is too large.") }
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard result.pulls.count <= 200 else {
            throw PhrenKitError.validation("The pull request list is invalid.")
        }
        return result
    }
}

/// What `/v1/git/commit`, `/v1/git/push` and `/v1/git/pr` answer. `ok` false
/// is a normal answer: Git or gh refused, and `output` is what it printed,
/// verbatim, or `reason` says gh is `missing` or needs `auth`.
public struct GitPublishResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let output: String?
    public let reason: String?
    public let message: String?
    /// A commit's hash, short hash and subject.
    public let sha: String?
    public let short: String?
    public let subject: String?
    public let branch: String?
    /// A push's `remote/branch`, and whether this push set it.
    public let upstream: String?
    public let setUpstream: Bool?
    /// A pull request's address; `existing` when the branch already had one.
    public let url: String?
    public let existing: Bool?

    public init(ok: Bool, output: String? = nil, reason: String? = nil, message: String? = nil, sha: String? = nil,
                short: String? = nil, subject: String? = nil, branch: String? = nil, upstream: String? = nil,
                setUpstream: Bool? = nil, url: String? = nil, existing: Bool? = nil) {
        self.ok = ok; self.output = output; self.reason = reason; self.message = message; self.sha = sha
        self.short = short; self.subject = subject; self.branch = branch; self.upstream = upstream
        self.setUpstream = setUpstream; self.url = url; self.existing = existing
    }

    /// A pull request address the phone will open: https only.
    public var pullURL: URL? {
        guard let url, let value = URL(string: url), value.scheme == "https", value.host != nil else { return nil }
        return value
    }

    /// What to tell the person when `ok` is false: gh's reason, else the
    /// output exactly as printed.
    public var failureText: String {
        let parts = [message, output].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.isEmpty ? "The computer did not say why." : parts.joined(separator: "\n\n")
    }

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 262_144 else { throw PhrenKitError.validation("The computer's answer is too large.") }
        do { return try JSONDecoder().decode(Self.self, from: data) }
        catch { throw PhrenKitError.validation("The computer returned an unusable answer. Refresh to see what happened.") }
    }
}
