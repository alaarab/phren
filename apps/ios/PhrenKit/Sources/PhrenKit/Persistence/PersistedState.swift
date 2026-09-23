import Foundation

// MARK: - The compatibility contract

/// A `Codable` value this app writes to the device and must still be able to
/// read after the user updates the app from the App Store.
///
/// # Why this protocol exists
///
/// A phone that has been offline holds the *only* copy of everything the user
/// wrote since the last push. `pending-ops.json` is unsynced user data, not a
/// cache. Before this file existed, a decode failure there returned an empty
/// queue, and every unpushed note, task, finding and approval vanished with no
/// error and no trace (project finding fid:cd892565). On TestFlight and the App
/// Store users upgrade across arbitrary version gaps, so a schema break is a
/// matter of when, not if.
///
/// # Rules for changing a conforming type
///
/// 1. **Additive only, at the current version.** A new field must be `Optional`
///    or decoded with `decodeIfPresent` and a default. Never rename a key,
///    never change a field's type, and never make an existing optional field
///    required — a build shipping that change cannot read what the previous
///    build wrote.
/// 2. **Enum cases are the usual trap.** Adding a case to a `Codable` enum
///    (`PendingOp` above all) means files written by the *new* build are
///    unreadable to *older* builds. That is a schema break in the downgrade
///    direction: bump ``currentSchemaVersion`` so an older build quarantines
///    the file instead of misreading it.
/// 3. **Bump ``currentSchemaVersion`` only for a genuine break**, and land a
///    migration that reads the old shape in the same change. A version bump on
///    its own is not a migration — it only converts "silently lost" into
///    "set aside", which is better but still a loss.
/// 4. **A file with no `schemaVersion` key is version 1.** That is what every
///    build shipped before this contract wrote, and it must keep decoding
///    forever. Conformers decode the key with `decodeIfPresent ?? 1`.
/// 5. **Every change gets a hand-written legacy-JSON test.** See
///    `PersistedStateTests`; the fixtures there are literal JSON strings
///    precisely so they cannot drift with the types they pin.
///
/// Anything that cannot be read is *quarantined*, never dropped — see
/// ``PersistedState``.
public protocol VersionedDocument: Codable {
    /// Bump ONLY when a build can no longer read what another build wrote.
    /// See the rules above.
    static var currentSchemaVersion: Int { get }

    /// The version this instance was loaded from, and the version it will be
    /// written as. Conformers store it and encode it.
    var schemaVersion: Int { get }
}

public extension VersionedDocument {
    /// The version assumed for a document written before `schemaVersion`
    /// existed. Absence of the key *is* version 1 — see rule 4.
    static var initialSchemaVersion: Int { 1 }
}

// MARK: - Issues

/// Something went wrong with on-device persistence that the user is entitled
/// to hear about, because it touched data only their phone had.
///
/// Deliberately not an `Error`: nothing here is thrown. These are recorded,
/// carried up to `AppModel`, and shown — an unreadable queue must not fail the
/// launch, and must not pass unmentioned either.
public struct StorageIssue: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// The bytes didn't decode: corrupt file, or a schema this build
        /// doesn't understand.
        case unreadable
        /// The document announced a `schemaVersion` newer than this build
        /// knows. A downgrade, or a beta build's data on a release build.
        case futureSchema
        /// The document couldn't be written back to the device.
        case unwritable
    }

    public let id: UUID
    public let kind: Kind
    /// What the document holds, in the user's words, plural — "unsynced
    /// changes", "recent captures". Interpolated into ``userMessage``.
    public let document: String
    /// Where the data was. Never shown to the user, but it is what makes a
    /// support conversation (or a future migration) possible.
    public let location: String
    /// Where it was moved to, or nil when even that failed.
    public let quarantineLocation: String?
    /// The version read off the document, when it had one.
    public let foundSchemaVersion: Int?
    public let expectedSchemaVersion: Int
    /// The underlying decode/write error, for logs — not for the user.
    public let detail: String?
    public let at: Date

    public init(
        id: UUID = UUID(),
        kind: Kind,
        document: String,
        location: String,
        quarantineLocation: String?,
        foundSchemaVersion: Int?,
        expectedSchemaVersion: Int,
        detail: String?,
        at: Date = Date()
    ) {
        self.id = id
        self.kind = kind
        self.document = document
        self.location = location
        self.quarantineLocation = quarantineLocation
        self.foundSchemaVersion = foundSchemaVersion
        self.expectedSchemaVersion = expectedSchemaVersion
        self.detail = detail
        self.at = at
    }

    /// Honest, specific, and not alarming: it says what happened, that the
    /// data still exists, and (for a downgrade) what would bring it back.
    public var userMessage: String {
        switch kind {
        case .unreadable:
            guard quarantineLocation != nil else {
                return "Some \(document) couldn't be read after the update, and Phren couldn't set them aside."
            }
            return "Some \(document) couldn't be read after the update and were set aside — they're saved in the app's data folder."
        case .futureSchema:
            guard quarantineLocation != nil else {
                return "Some \(document) were written by a newer version of Phren and couldn't be read."
            }
            return "Some \(document) were written by a newer version of Phren and were set aside — they're saved in the app's data folder, and updating Phren will make them readable again."
        case .unwritable:
            return "Phren couldn't save your \(document) on this device, so they may not survive closing the app."
        }
    }
}

/// Process-wide sink for ``StorageIssue``s, drained by `AppModel` so the user
/// hears about them.
///
/// A singleton because the capture path needs one: `CaptureLog` and the
/// quick-capture settings are written from App Intents that can run with no
/// `AppModel` at all (`AppModel.current` is deliberately weak), so there is no
/// object to hand an issue back to. Owners that *do* exist keep their own copy
/// as well (``LocalStore/storageIssues``, ``SyncEngine/storageIssues``) for
/// per-store attribution; the model reads this log alone, which already has
/// everything, rather than unioning the two.
public final class StorageIssueLog: @unchecked Sendable {
    public static let shared = StorageIssueLog()

    /// A device that refuses every write would otherwise grow this forever.
    private static let limit = 32

    private let lock = NSLock()
    private var stored: [StorageIssue] = []

    public init() {}

    public var issues: [StorageIssue] {
        lock.withLock { stored }
    }

    public func record(_ issue: StorageIssue) {
        lock.withLock {
            stored.append(issue)
            if stored.count > Self.limit {
                stored.removeFirst(stored.count - Self.limit)
            }
        }
    }

    public func removeAll() {
        lock.withLock { stored.removeAll() }
    }
}

// MARK: - Load / save

/// Reads and writes ``VersionedDocument``s, quarantining anything it cannot
/// read instead of starting empty over the top of it.
///
/// Quarantine is the whole point: an unreadable `pending-ops.json` is moved to
/// `pending-ops.corrupt-20260801T120000Z.json` beside itself, so the bytes
/// survive for a future migration or a support request, and the caller starts
/// empty from a *known* empty file rather than from silence.
public enum PersistedState {
    public struct LoadResult<Value> {
        /// The decoded document, or nil when there was nothing readable —
        /// either nothing has been written yet (`issue` is nil) or `issue`
        /// says what happened to what was there.
        public let value: Value?
        public let issue: StorageIssue?
    }

    /// Reads only the version, and only when the document is a JSON object.
    /// It stays silent when it can't (a legacy top-level array, say) so that
    /// shape falls through to the real decode rather than being called
    /// corrupt on the strength of a missing envelope.
    private struct SchemaProbe: Decodable {
        let schemaVersion: Int?
    }

    // MARK: Files

    /// Loads a document from a file. A missing file is not an issue — it is
    /// every first launch.
    public static func load<Value: VersionedDocument>(
        _ type: Value.Type,
        from url: URL,
        document: String,
        decoder: JSONDecoder = JSONDecoder()
    ) -> LoadResult<Value> {
        guard let data = try? Data(contentsOf: url) else {
            return LoadResult(value: nil, issue: nil)
        }
        return decode(type, data: data, document: document, location: url.path, decoder: decoder) {
            quarantineFile(at: url, data: data)
        }
    }

    /// Writes a document, reporting a failed write rather than dropping it.
    /// A queue that can't be saved means the user's offline work dies at app
    /// termination, so this is never a `try?`.
    @discardableResult
    public static func save<Value: VersionedDocument>(
        _ value: Value,
        to url: URL,
        document: String,
        encoder: JSONEncoder = JSONEncoder()
    ) -> StorageIssue? {
        assertWritingCurrentVersion(value)
        do {
            let data = try encoder.encode(value)
            try data.write(to: url, options: .atomic)
            return nil
        } catch {
            return report(
                kind: .unwritable, document: document, location: url.path,
                quarantineLocation: nil, foundSchemaVersion: nil,
                expected: Value.currentSchemaVersion, detail: "\(error)"
            )
        }
    }

    // MARK: UserDefaults

    /// The `UserDefaults` twin of ``load(_:from:document:decoder:)`` — same
    /// contract, same quarantine, for the capture state that lives in
    /// preferences rather than in a file of its own.
    public static func load<Value: VersionedDocument>(
        _ type: Value.Type,
        fromDefaults defaults: UserDefaults,
        key: String,
        document: String,
        decoder: JSONDecoder = JSONDecoder()
    ) -> LoadResult<Value> {
        guard let data = defaults.data(forKey: key) else {
            return LoadResult(value: nil, issue: nil)
        }
        return decode(type, data: data, document: document, location: Self.location(of: key), decoder: decoder) {
            Quarantine(path: quarantineDefaults(data: data, in: defaults, key: key))
        }
    }

    @discardableResult
    public static func save<Value: VersionedDocument>(
        _ value: Value,
        toDefaults defaults: UserDefaults,
        key: String,
        document: String,
        encoder: JSONEncoder = JSONEncoder()
    ) -> StorageIssue? {
        assertWritingCurrentVersion(value)
        do {
            defaults.set(try encoder.encode(value), forKey: key)
            return nil
        } catch {
            return report(
                kind: .unwritable, document: document, location: Self.location(of: key),
                quarantineLocation: nil, foundSchemaVersion: nil,
                expected: Value.currentSchemaVersion, detail: "\(error)"
            )
        }
    }

    // MARK: - Decoding

    private static func decode<Value: VersionedDocument>(
        _ type: Value.Type,
        data: Data,
        document: String,
        location: String,
        decoder: JSONDecoder,
        quarantine: () -> Quarantine
    ) -> LoadResult<Value> {
        // Version first, so a document from a newer build is recognized as
        // such rather than reported as corrupt when its new required field
        // fails to decode here.
        let found = (try? decoder.decode(SchemaProbe.self, from: data))?.schemaVersion
        if let found, found > Value.currentSchemaVersion {
            let moved = quarantine()
            return LoadResult(value: nil, issue: report(
                kind: .futureSchema, document: document, location: location,
                quarantineLocation: moved.path, foundSchemaVersion: found,
                expected: Value.currentSchemaVersion, detail: moved.failure
            ))
        }

        do {
            return LoadResult(value: try decoder.decode(Value.self, from: data), issue: nil)
        } catch {
            let moved = quarantine()
            return LoadResult(value: nil, issue: report(
                kind: .unreadable, document: document, location: location,
                quarantineLocation: moved.path, foundSchemaVersion: found,
                expected: Value.currentSchemaVersion,
                detail: ["\(error)", moved.failure].compactMap { $0 }.joined(separator: "; ")
            ))
        }
    }

    // MARK: - Quarantine

    /// Moves an unreadable file aside as `<name>.corrupt-<ISO8601>.<ext>`.
    /// Never deletes and never overwrites: the bytes have to outlive this
    /// launch for a later build to migrate them.
    static func quarantineFile(at url: URL, data: Data) -> Quarantine {
        let destination = quarantineURL(for: url)
        do {
            try FileManager.default.moveItem(at: url, to: destination)
            return Quarantine(path: destination.path)
        } catch let moveError {
            // A move can fail (an open handle, an odd filesystem). We already
            // hold the bytes, so write the copy ourselves rather than lose
            // them, and only then take the original out of the way. Each
            // failure rides along in the issue's detail instead of vanishing.
            do {
                try data.write(to: destination, options: .atomic)
            } catch {
                return Quarantine(path: nil, failure: "move failed: \(moveError); copy failed: \(error)")
            }
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                return Quarantine(path: destination.path, failure: "copied aside, but the original stayed: \(error)")
            }
            return Quarantine(path: destination.path)
        }
    }

    /// Where a quarantine put the bytes, and why any step of it failed.
    struct Quarantine {
        var path: String?
        var failure: String?
    }

    /// The preferences twin: copy the raw bytes to a sibling key *before*
    /// clearing the unreadable one, so the next save can't land on top of
    /// them.
    static func quarantineDefaults(data: Data, in defaults: UserDefaults, key: String) -> String? {
        var candidate = "\(key).corrupt-\(timestamp())"
        var attempt = 1
        while defaults.object(forKey: candidate) != nil, attempt < 1000 {
            candidate = "\(key).corrupt-\(timestamp())-\(attempt)"
            attempt += 1
        }
        defaults.set(data, forKey: candidate)
        defaults.removeObject(forKey: key)
        return location(of: candidate)
    }

    private static func quarantineURL(for url: URL) -> URL {
        let directory = url.deletingLastPathComponent()
        let base = url.deletingPathExtension().lastPathComponent
        let ext = url.pathExtension
        let stamp = timestamp()

        func candidate(_ suffix: String) -> URL {
            var name = "\(base).corrupt-\(stamp)\(suffix)"
            if !ext.isEmpty { name += ".\(ext)" }
            return directory.appendingPathComponent(name)
        }

        // Two quarantines inside the same second are entirely possible (two
        // stores opening at launch), and the second must not clobber the first.
        for attempt in 0..<1000 {
            let url = candidate(attempt == 0 ? "" : "-\(attempt)")
            if !FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return candidate("-\(UUID().uuidString)")
    }

    /// ISO 8601 *basic* format — the extended one's `:` has no business in a
    /// filename, and this still sorts lexicographically.
    private static let stampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return formatter
    }()

    private static func timestamp() -> String {
        stampFormatter.string(from: Date())
    }

    private static func location(of defaultsKey: String) -> String {
        "UserDefaults:\(defaultsKey)"
    }

    // MARK: - Reporting

    /// A failed on-device write outside a ``VersionedDocument`` (the file
    /// cache, the keychain, a wipe), recorded through the same log and shown
    /// through the same banner as a failed document save.
    @discardableResult
    public static func reportUnwritable(document: String, location: String, error: Error) -> StorageIssue {
        report(kind: .unwritable, document: document, location: location, quarantineLocation: nil,
               foundSchemaVersion: nil, expected: 0, detail: "\(error)")
    }

    private static func report(
        kind: StorageIssue.Kind,
        document: String,
        location: String,
        quarantineLocation: String?,
        foundSchemaVersion: Int?,
        expected: Int,
        detail: String?
    ) -> StorageIssue {
        let issue = StorageIssue(
            kind: kind, document: document, location: location,
            quarantineLocation: quarantineLocation,
            foundSchemaVersion: foundSchemaVersion,
            expectedSchemaVersion: expected, detail: detail
        )
        StorageIssueLog.shared.record(issue)
        #if DEBUG
        // Loud in development, where an unreadable document is almost always a
        // persisted type someone just changed non-additively — the whole point
        // is to find that out at the desk rather than from a user whose
        // offline work went quiet. Printed, not trapped: a developer switching
        // branches shouldn't be locked out of the app by a crash loop.
        print("""
        ⚠️ PhrenKit \(kind.rawValue): \(document) at \(location)
           \(quarantineLocation.map { "set aside at \($0)" } ?? "NOT set aside")
           \(detail ?? "schemaVersion \(foundSchemaVersion.map(String.init) ?? "?") > \(expected)")
           Re-read the compatibility contract on VersionedDocument before changing a persisted type.
        """)
        #endif
        return issue
    }

    private static func assertWritingCurrentVersion<Value: VersionedDocument>(_ value: Value) {
        #if DEBUG
        assert(
            value.schemaVersion == Value.currentSchemaVersion,
            """
            \(Value.self) is being written at schemaVersion \(value.schemaVersion) but its \
            currentSchemaVersion is \(Value.currentSchemaVersion). Stamp the current version \
            on write, or every device that reads it back will quarantine the file.
            """
        )
        #endif
    }
}

// MARK: - Versioned list

/// A versioned envelope around a list whose version-1 on-disk shape is a bare
/// JSON array.
///
/// Several persisted lists shipped before this contract existed as plain
/// arrays — the capture log, the attached-store registry — leaving nowhere to
/// put a `schemaVersion`. This wraps them without breaking those files: it
/// decodes the bare array as version 1, and writes the envelope from now on.
///
/// See ``VersionedDocument`` before changing `Element`. Adding a non-optional
/// field to an element is the same schema break here as anywhere else, and
/// it is the whole list that gets set aside, not the one bad entry.
public struct VersionedList<Element: Codable & Sendable>: Codable, Sendable, VersionedDocument {
    public static var currentSchemaVersion: Int { 1 }

    public var schemaVersion: Int
    public var items: [Element]

    public init(items: [Element]) {
        self.schemaVersion = Self.currentSchemaVersion
        self.items = items
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, items
    }

    public init(from decoder: Decoder) throws {
        // Version 1 on disk is a BARE ARRAY — what every build wrote before
        // this envelope existed. Trying that shape first is a discriminated
        // union, not an error swallow: when neither shape decodes, this
        // initializer still throws and `PersistedState` quarantines the bytes.
        if let legacy = try? decoder.singleValueContainer().decode([Element].self) {
            self.schemaVersion = Self.initialSchemaVersion
            self.items = legacy
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion)
            ?? Self.initialSchemaVersion
        self.items = try container.decode([Element].self, forKey: .items)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(items, forKey: .items)
    }
}
