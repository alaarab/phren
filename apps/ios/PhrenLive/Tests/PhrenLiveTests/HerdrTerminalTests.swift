import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class HerdrTerminalTests: XCTestCase {
    func testTerminalRouteCommandsMatchTheDispatcherGrammar() {
        XCTAssertEqual(TerminalRoute.herdr(server: "work").command, "phren-hook v1 terminal work")
        // base64url without padding, so a path with `/` and `+`-producing bytes stays inside [A-Za-z0-9_-].
        let folder = "/Users/me/Projects/app one?"
        let command = TerminalRoute.shell(directory: folder, agent: .claude).command
        XCTAssertTrue(command.hasPrefix("phren-hook v1 shell "))
        XCTAssertTrue(command.hasSuffix(" claude"))
        let encoded = command.dropFirst("phren-hook v1 shell ".count).dropLast(" claude".count)
        XCTAssertTrue(encoded.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        var padded = String(encoded).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
        XCTAssertEqual(Data(base64Encoded: padded).flatMap { String(data: $0, encoding: .utf8) }, folder)
        XCTAssertEqual(TerminalRoute.shell(directory: "/tmp", agent: nil).command, "phren-hook v1 shell L3RtcA")
        XCTAssertFalse(TerminalRoute.shell(directory: "/tmp", agent: nil).needsHerdr)
    }

    func testBurstPreservesEveryByteAcrossCoalescedWakeupsAndPartialDrains() async throws {
        let buffer = TerminalOutputBuffer()
        let (signals, continuation) = AsyncThrowingStream<Void, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let output = HerdrTerminalOutput(buffer: buffer, signals: signals)
        let expected = Data(String(repeating: "\u{1B}[32mPhren 🦀\u{1B}[0m\r\n", count: 8_000).utf8)
        // Thousands of tiny frames must not overflow an eight-frame queue or
        // lose parts of a multibyte character/control sequence.
        for byte in expected { try buffer.append(Data([byte])); continuation.yield(()) }
        var iterator = output.makeAsyncIterator()
        let first = try await iterator.next()
        var actual = try XCTUnwrap(first)
        XCTAssertEqual(actual.count, 65_536)
        let suffix = Data("after partial drain".utf8)
        try buffer.append(suffix); continuation.yield(())
        continuation.finish(throwing: LiveConnectionError.disconnected)
        do {
            while let bytes = try await iterator.next() {
                XCTAssertLessThanOrEqual(bytes.count, 65_536)
                actual.append(bytes)
            }
            XCTFail("The disconnect must reach the reader after buffered output")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .disconnected) }
        XCTAssertEqual(actual, expected + suffix)
    }

    func testTerminalBufferBoundsBytesAndReleasesConsumedCapacity() throws {
        let buffer = TerminalOutputBuffer()
        try buffer.append(Data(repeating: 65, count: TerminalOutputBuffer.capacity))
        XCTAssertThrowsError(try buffer.append(Data([66]))) { XCTAssertEqual($0 as? LiveConnectionError, .oversized) }
        let consumed = try XCTUnwrap(buffer.take())
        try buffer.append(Data(repeating: 66, count: consumed.count))
        var count = 0, last = Data()
        while let bytes = buffer.take() { count += bytes.count; last = bytes }
        XCTAssertEqual(count, TerminalOutputBuffer.capacity)
        XCTAssertEqual(last, Data(repeating: 66, count: consumed.count))
    }

    func testCancelledTerminalDoesNotRenderBufferedOutput() async throws {
        let buffer = TerminalOutputBuffer()
        try buffer.append(Data("pending".utf8))
        let (signals, continuation) = AsyncThrowingStream<Void, Error>.makeStream()
        defer { continuation.finish() }
        let output = HerdrTerminalOutput(buffer: buffer, signals: signals)
        let task = Task {
            while !Task.isCancelled { await Task.yield() }
            var iterator = output.makeAsyncIterator()
            do { _ = try await iterator.next(); XCTFail("Cancelled output must not render") }
            catch { XCTAssertTrue(error is CancellationError) }
        }
        task.cancel(); await task.value
    }

    func testRecoveryBoundsFlappingAndNeverRetriesAuthenticationOrCancellation() {
        var recovery = HerdrTerminalRecovery()
        for (time, expected) in [(1.0, 1), (2.0, 2), (3.0, 4)] {
            recovery.connected(at: time)
            XCTAssertEqual(recovery.delay(after: LiveConnectionError.disconnected, now: time + 0.5), expected)
        }
        XCTAssertNil(recovery.delay(after: LiveConnectionError.timeout, now: 5))
        recovery.connected(at: 10)
        XCTAssertEqual(recovery.delay(after: LiveConnectionError.timeout, now: 21), 1)
        for error: Error in [LiveConnectionError.changedHost, LiveConnectionError.authentication,
                             LiveConnectionError.response(403), LiveConnectionError.oversized, CancellationError()] {
            XCTAssertNil(recovery.delay(after: error, now: 30))
        }
    }

}
