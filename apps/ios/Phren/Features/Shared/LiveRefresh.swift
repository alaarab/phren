import Foundation
import PhrenKit

/// The app's one loop for periodic reads the Hook does not push: account
/// usage, web servers, a simulator's screen, sub-agent trees, a worker's
/// messages, scheduled-prompt reminders. A screen asks for a job while it is
/// on screen; jobs with the same key share one run at the shortest interval
/// any caller asked for, a job never overlaps itself, and one timer sleeps
/// until the next job is due instead of every screen running its own.
///
/// The session overview is not here: it arrives over the Hook's overview
/// stream (or its own poll where a Hook predates it). Chat transcripts and
/// status are streams too; GitHub sync has its own loop in `SyncEngine`.
@MainActor
final class LiveRefresh {
    static let shared = LiveRefresh()

    private final class Job {
        var intervals: [UUID: Duration] = [:]
        var work: @MainActor () async -> Void
        var due = ContinuousClock.now
        var running = false
        init(work: @escaping @MainActor () async -> Void) { self.work = work }
        var interval: Duration { intervals.values.min() ?? .seconds(60) }
    }

    private var jobs: [String: Job] = [:]
    private var driver: Task<Void, Never>?
    private var sleeper: Task<Void, Never>?

    /// Runs `work` now and then every `interval` until the calling task is
    /// cancelled (a view's `.task`), sharing the run with any other caller of
    /// the same `key`. The first caller's `work` is the one that runs.
    func every(_ interval: Duration, key: String, _ work: @escaping @MainActor () async -> Void) async {
        let subscriber = UUID()
        let job = jobs[key] ?? Job(work: work)
        let fresh = jobs[key] == nil
        job.intervals[subscriber] = interval
        jobs[key] = job
        if fresh { job.due = .now }
        wake()
        do { while !Task.isCancelled { try await Task.sleep(for: .seconds(3_600)) } } catch { }
        job.intervals[subscriber] = nil
        if job.intervals.isEmpty, jobs[key] === job { jobs[key] = nil }
        wake()
    }

    /// Runs a job now, ahead of its interval (after an action changed what it reads).
    func refresh(_ key: String) {
        guard let job = jobs[key] else { return }
        job.due = .now
        wake()
    }

    private func wake() {
        sleeper?.cancel()
        if driver == nil { driver = Task { [weak self] in await self?.drive() } }
    }

    private func drive() async {
        while !Task.isCancelled {
            guard !jobs.isEmpty else { driver = nil; return }
            let now = ContinuousClock.now
            for (key, job) in jobs where job.due <= now && !job.running {
                job.running = true
                job.due = now.advanced(by: job.interval)
                PerformanceCounters.bump("refresh.\(key.split(separator: ":").first ?? "")")
                Task { [weak self] in
                    await job.work()
                    job.running = false
                    // A job that ran past its next due time is picked up now.
                    self?.wake()
                }
            }
            // A running job is not due until it finishes (and wakes the loop).
            let next = jobs.values.filter { !$0.running }.map(\.due).min() ?? now.advanced(by: .seconds(3_600))
            let sleeper = Task { _ = try? await Task.sleep(until: max(next, ContinuousClock.now.advanced(by: .milliseconds(50))), clock: .continuous) }
            self.sleeper = sleeper
            await sleeper.value
        }
    }
}
