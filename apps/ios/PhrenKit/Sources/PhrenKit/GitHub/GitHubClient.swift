import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Minimal GitHub REST v3 client covering exactly what the app needs:
/// user/repos discovery, ref + tree + blob reads, and per-file contents
/// PUT/DELETE writes with sha optimistic concurrency.
///
/// Kept deliberately narrow so a future switch to the Git Data API
/// (batched multi-file commits) stays local to this type.
public actor GitHubClient {
    /// Trailing slash matters: relative paths resolve against it directly,
    /// avoiding `//`-doubling from appendingPathComponent normalization.
    public static let apiBase = URL(string: "https://api.github.com/")!

    private let session: URLSession
    private var token: String?
    /// ETag cache for cheap ref polling: conditional requests answered 304
    /// don't count against the REST rate limit.
    private var etags: [String: String] = [:]

    public init(session: URLSession = .shared, token: String? = nil) {
        self.session = session
        self.token = token
    }

    public func setToken(_ token: String?) {
        self.token = token
        etags.removeAll()
    }

    // MARK: - Request plumbing

    private func request(_ path: String, method: String = "GET",
                         accept: String = "application/vnd.github+json",
                         etagKey: String? = nil,
                         body: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        guard let token else { throw GitHubError.notAuthenticated }
        // Not appendingPathComponent — several paths carry query strings
        // ("?recursive=1"), which it would percent-encode.
        guard let url = URL(string: path, relativeTo: Self.apiBase)?.absoluteURL,
              GitHubRedirectPolicy.allows(url) else {
            throw GitHubError.invalidResponse
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        if let etagKey, let etag = etags[etagKey] {
            req.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: req, delegate: GitHubRedirectPolicy.shared)
        guard let http = response as? HTTPURLResponse else { throw GitHubError.invalidResponse }

        if http.statusCode == 403 || http.statusCode == 429,
           let throttled = Self.rateLimitError(http, data: data) {
            throw throttled
        }
        if let etagKey, let etag = http.value(forHTTPHeaderField: "Etag") {
            etags[etagKey] = etag
        }
        return (data, http)
    }

    /// GitHub throttles in three shapes, and only one of them zeroes the
    /// remaining counter:
    ///
    /// - primary limit: 403/429 with `x-ratelimit-remaining: 0`
    /// - secondary ("abuse") limit: 403/429 with a **non-zero** remaining, a
    ///   `retry-after` header and a "secondary rate limit" message
    /// - 429 without either header
    ///
    /// `x-ratelimit-reset` rides *every* response, so it is read for timing
    /// but never used as the signal — treating its presence as throttling
    /// would relabel every permissions 403 as a rate limit.
    static func rateLimitError(_ http: HTTPURLResponse, data: Data) -> GitHubError? {
        let reset = http.value(forHTTPHeaderField: "x-ratelimit-reset")
            .flatMap(TimeInterval.init)
            .map { Date(timeIntervalSince1970: $0) }
        let retryAfter = http.value(forHTTPHeaderField: "retry-after").flatMap(TimeInterval.init)

        if http.value(forHTTPHeaderField: "x-ratelimit-remaining") == "0" {
            return .rateLimited(resetAt: reset, retryAfter: retryAfter)
        }
        if let retryAfter {
            // The reset header describes the hourly window, not this backoff.
            return .rateLimited(resetAt: Date().addingTimeInterval(retryAfter), retryAfter: retryAfter)
        }
        let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["message"] as? String
        let lowered = (message ?? "").lowercased()
        if lowered.contains("secondary rate limit") || lowered.contains("abuse detection") {
            return .rateLimited(resetAt: reset, retryAfter: nil)
        }
        if http.statusCode == 429 {
            return .rateLimited(resetAt: reset, retryAfter: nil)
        }
        return nil
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let (data, http) = try await request(path)
        try Self.ensureOK(http, data: data, path: path)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Dynamic values are path data, never URL syntax. In particular, Git
    /// permits `#` and `%` in branch names; resolving those raw reads another
    /// ref while contents writes still use the original branch from JSON.
    private static func encodePath(_ value: String, nested: Bool = false) throws -> String {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard (nested || parts.count == 1),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              !value.contains("\\"), value.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw GitHubError.invalidResponse
        }
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return try parts.map { part in
            guard let encoded = String(part).addingPercentEncoding(withAllowedCharacters: unreserved) else {
                throw GitHubError.invalidResponse
            }
            return encoded
        }.joined(separator: "/")
    }

    private static func repoPath(owner: String, repo: String) throws -> String {
        try "repos/\(encodePath(owner))/\(encodePath(repo))"
    }

    /// `method`/`path` are carried into the error so `errorDescription` can
    /// explain a 403/404 as the token-scope problem it usually is.
    static func ensureOK(_ http: HTTPURLResponse, data: Data,
                         method: String = "GET", path: String? = nil) throws {
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw GitHubError.http(status: http.statusCode, message: message ?? "request failed",
                                   method: method, path: path)
        }
    }

    // MARK: - Identity + repos

    public func currentUser() async throws -> GitHubUser {
        try await get("user", as: GitHubUser.self)
    }

    /// Most recently pushed repos visible to the token (owner + collaborator + org).
    public func listRepos(page: Int = 1, perPage: Int = 100) async throws -> [GitHubRepo] {
        try await get("user/repos?sort=pushed&per_page=\(perPage)&page=\(page)&affiliation=owner,collaborator,organization_member",
                      as: [GitHubRepo].self)
    }

    /// Every page of `listRepos`, stopping at the first short page or the cap.
    /// Accounts with hundreds of repos kept their store off the picker when
    /// only page 1 was fetched; the cap bounds the worst case at
    /// `maxPages × perPage` repos and as many requests.
    public func listAllRepos(maxPages: Int = 5, perPage: Int = 100) async throws -> [GitHubRepo] {
        var all: [GitHubRepo] = []
        var seen = Set<Int>()
        for page in 1...max(1, maxPages) {
            let batch = try await listRepos(page: page, perPage: perPage)
            for repo in batch where seen.insert(repo.id).inserted {
                all.append(repo)
            }
            if batch.count < perPage { break }
        }
        return all
    }

    public func repo(owner: String, name: String) async throws -> GitHubRepo {
        try await get(Self.repoPath(owner: owner, repo: name), as: GitHubRepo.self)
    }

    /// What a store probe learned. `noAccess` exists because GitHub answers
    /// 404 both for "no such file" and for "repository your token may not
    /// read" — collapsing them into a plain `false` is what made a token-scope
    /// mistake look like "this repo isn't a phren store".
    public enum StoreProbe: Equatable, Sendable {
        case isStore
        case notStore
        /// The token can't read the repository (404/403 on the repo itself).
        case noAccess
        /// Network failure, throttling, or anything else worth retrying.
        case error(String)
    }

    /// Probes for `phren.root.yaml` at the repo root — the marker of a phren
    /// store (packages/cli/src/phren-paths.ts ROOT_MANIFEST_FILENAME).
    ///
    /// A 404 on the contents path is ambiguous, so it is resolved with one
    /// follow-up request for the repository itself. Pass `disambiguate404:
    /// false` for repos already known to be visible (anything `listRepos`
    /// returned) to keep the probe at one request each.
    public func probeStore(owner: String, name: String,
                           disambiguate404: Bool = true) async -> StoreProbe {
        do {
            let (_, http) = try await request(Self.repoPath(owner: owner, repo: name) + "/contents/phren.root.yaml")
            switch http.statusCode {
            case 200..<300:
                return .isStore
            case 401, 403:
                return .noAccess
            case 404:
                guard disambiguate404 else { return .notStore }
                return await repoIsReadable(owner: owner, name: name) ? .notStore : .noAccess
            default:
                return .error(GitHubError.http(status: http.statusCode, message: "request failed",
                                               method: "GET",
                                               path: "repos/\(owner)/\(name)/contents/phren.root.yaml")
                    .localizedDescription)
            }
        } catch {
            return .error(error.localizedDescription)
        }
    }

    /// Probe for a repo the caller already listed — visible by construction,
    /// so a 404 means "no manifest" and costs no extra request.
    public func probeStore(_ repo: GitHubRepo) async -> StoreProbe {
        await probeStore(owner: repo.owner.login, name: repo.name, disambiguate404: false)
    }

    private func repoIsReadable(owner: String, name: String) async -> Bool {
        guard let (_, http) = try? await request(Self.repoPath(owner: owner, repo: name)) else { return false }
        return (200..<300).contains(http.statusCode)
    }

    /// True when the repo contains `phren.root.yaml` at its root. Retained for
    /// call sites that only need a yes/no; `probeStore` distinguishes "not a
    /// store" from "token can't see it".
    public func isPhrenStore(owner: String, name: String) async -> Bool {
        await probeStore(owner: owner, name: name, disambiguate404: false) == .isStore
    }

    // MARK: - Git data reads

    /// Head commit SHA for a branch. Returns nil when the cached ETag still
    /// matches (HTTP 304) — nothing changed, and the poll was free.
    public func headSha(owner: String, repo: String, branch: String) async throws -> String? {
        let key = "ref:\(owner)/\(repo)/\(branch)"
        let path = try Self.repoPath(owner: owner, repo: repo) + "/git/ref/heads/" + Self.encodePath(branch, nested: true)
        let (data, http) = try await request(path, etagKey: key)
        if http.statusCode == 304 { return nil }
        try Self.ensureOK(http, data: data, path: path)
        return try JSONDecoder().decode(GitRef.self, from: data).object.sha
    }

    public func tree(owner: String, repo: String, sha: String) async throws -> GitTree {
        let path = try Self.repoPath(owner: owner, repo: repo) + "/git/trees/" + Self.encodePath(sha) + "?recursive=1"
        let tree = try await get(path, as: GitTree.self)
        guard !tree.truncated else { throw GitHubError.treeTruncated }
        return tree
    }

    public func blob(owner: String, repo: String, sha: String) async throws -> Data {
        let path = try Self.repoPath(owner: owner, repo: repo) + "/git/blobs/" + Self.encodePath(sha)
        let blob = try await get(path, as: GitBlob.self)
        guard let data = blob.decoded else { throw GitHubError.invalidResponse }
        return data
    }

    // MARK: - Contents writes

    /// One commit per call, mirroring the granularity of phren's own hook
    /// commits — the sync engine coalesces a batch of ops into one call per
    /// file. `sha` is the cached blob SHA; nil creates a new file.
    public func putFile(owner: String, repo: String, path: String, branch: String,
                        content: Data, message: String, sha: String?) async throws -> ContentsPutResponse {
        var payload: [String: Any] = [
            "message": message,
            "content": content.base64EncodedString(),
            "branch": branch,
        ]
        if let sha { payload["sha"] = sha }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let endpoint = try Self.repoPath(owner: owner, repo: repo) + "/contents/" + Self.encodePath(path, nested: true)
        let (data, http) = try await request(endpoint, method: "PUT", body: body)
        if http.statusCode == 409 || http.statusCode == 422 {
            throw GitHubError.shaConflict(path: path)
        }
        try Self.ensureOK(http, data: data, method: "PUT", path: endpoint)
        return try JSONDecoder().decode(ContentsPutResponse.self, from: data)
    }

    public func deleteFile(owner: String, repo: String, path: String, branch: String,
                           message: String, sha: String) async throws {
        let payload: [String: Any] = ["message": message, "sha": sha, "branch": branch]
        let body = try JSONSerialization.data(withJSONObject: payload)
        let endpoint = try Self.repoPath(owner: owner, repo: repo) + "/contents/" + Self.encodePath(path, nested: true)
        let (data, http) = try await request(endpoint, method: "DELETE", body: body)
        if http.statusCode == 409 || http.statusCode == 422 {
            throw GitHubError.shaConflict(path: path)
        }
        try Self.ensureOK(http, data: data, method: "DELETE", path: endpoint)
    }
}
