#if DEBUG && targetEnvironment(simulator)
import AVFoundation
import PhrenKit
import UIKit

@MainActor enum FileViewerFixture {
    static var enabled: Bool { AgentChatFixture.enabled }
    static let names = ["render.mp4", "design.pdf", "result.json", "voice.wav"]
    static var hostFiles: [HostFile] {
        names.map { HostFile(name: $0, path: "/home/sam/.local/share/phren/bridge/uploads/files/" + $0,
                             size: 120_000, modified: "2026-09-22T10:00:00Z") }
    }
    static func file(named name: String) async throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("file-viewer-fixture")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent((name as NSString).lastPathComponent)
        if FileManager.default.fileExists(atPath: url.path) { return url }
        switch url.pathExtension {
        case "mp4": try await video(url)
        case "pdf":
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 300, height: 400))
            try renderer.writePDF(to: url) { context in
                for page in 1...2 {
                    context.beginPage()
                    ("Design preview, page \(page)" as NSString).draw(at: CGPoint(x: 24, y: 40), withAttributes: [.font: UIFont.systemFont(ofSize: 20)])
                }
            }
        case "json": try Data(#"{"render":{"file":"video/render.mp4","frames":60},"colors":["cyan","purple"],"complete":true}"#.utf8).write(to: url)
        case "wav":
            var data = Data("RIFF".utf8)
            func number(_ value: UInt32, bytes: Int = 4) { for index in 0..<bytes { data.append(UInt8((value >> (index * 8)) & 255)) } }
            number(16_036); data.append(Data("WAVEfmt ".utf8)); number(16); number(1, bytes: 2); number(1, bytes: 2)
            number(8_000); number(16_000); number(2, bytes: 2); number(16, bytes: 2)
            data.append(Data("data".utf8)); number(16_000); data.append(Data(count: 16_000)); try data.write(to: url)
        default: try Data("// File contents\nlet color = \"cyan\"\n".utf8).write(to: url)
        }
        return url
    }
    private static func video(_ url: URL) async throws {
        try await Task.detached {
            let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
            let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 160, AVVideoHeightKey: 96])
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                kCVPixelBufferWidthKey as String: 160, kCVPixelBufferHeightKey as String: 96])
            writer.add(input)
            guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
            writer.startSession(atSourceTime: .zero)
            for frame in 0..<60 {
                while !input.isReadyForMoreMediaData {
                    if writer.status == .failed { throw writer.error ?? CocoaError(.fileWriteUnknown) }
                    try await Task.sleep(for: .milliseconds(5))
                }
                var buffer: CVPixelBuffer?
                guard CVPixelBufferCreate(kCFAllocatorDefault, 160, 96, kCVPixelFormatType_32ARGB, nil, &buffer) == kCVReturnSuccess,
                      let buffer else { throw CocoaError(.fileWriteUnknown) }
                CVPixelBufferLockBaseAddress(buffer, [])
                let pointer = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
                let stride = CVPixelBufferGetBytesPerRow(buffer)
                for y in 0..<96 { for x in 0..<160 {
                    let pixel = pointer + y * stride + x * 4
                    pixel[0] = 255; pixel[1] = UInt8(frame * 4); pixel[2] = 190; pixel[3] = 220
                } }
                CVPixelBufferUnlockBaseAddress(buffer, [])
                guard adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
            }
            input.markAsFinished()
            await writer.finishWriting()
            guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        }.value
    }
}
#endif
