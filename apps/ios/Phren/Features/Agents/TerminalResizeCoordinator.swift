import Foundation

/// Keeps only the latest grid while a socket is attaching or a resize is in
/// flight. A slower old request can never finish after the newest request.
@MainActor
final class TerminalResizeCoordinator {
    struct Size: Equatable { let columns: Int; let rows: Int }
    private(set) var latest: Size?
    private var revision = 0
    private var delivered = -1
    private var generation = UUID()
    private var send: ((Size) async throws -> Void)?
    private var task: Task<Void, Never>?
    private var debounce: Task<Void, Never>?

    func update(columns: Int, rows: Int) {
        guard columns > 0, rows > 0 else { return }
        latest = Size(columns: columns, rows: rows)
        revision += 1
        // The keyboard animation lays the terminal out on every frame; only the
        // settled grid should reach the remote PTY, or it reflows in a storm.
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            self?.drain()
        }
    }
    func attach(send: @escaping (Size) async throws -> Void) {
        detach()
        self.send = send
        delivered = -1
        drain()
    }
    func detach() {
        debounce?.cancel(); debounce = nil
        generation = UUID()
        task?.cancel(); task = nil; send = nil
    }
    private func drain() {
        guard task == nil, send != nil, latest != nil else { return }
        let run = generation
        task = Task { [weak self] in
            guard let self else { return }
            defer { if generation == run { task = nil } }
            while !Task.isCancelled, generation == run, delivered != revision, let latest, let send {
                let sending = revision
                do { try await send(latest) } catch { return }
                guard generation == run else { return }
                delivered = sending
            }
        }
    }
}
