import AVFoundation
import SwiftUI

struct FileMediaView: View {
    let url: URL
    let audio: Bool
    @Binding var fullscreen: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var player: AVPlayer?
    @State private var elapsed = 0.0
    @State private var duration = 0.0
    @State private var playing = false
    @State private var muted = false
    @State private var error: String?
    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            if let player {
                if audio {
                    Image(systemName: "waveform").font(.largeTitle).foregroundStyle(PhrenTheme.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityHidden(true)
                } else {
                    FilePlayerSurface(player: player).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else { Spacer() }
            if let error { Text(error).font(PhrenTypography.body).foregroundStyle(PhrenTheme.warning).padding() }
            VStack(spacing: 4) {
                FileScrubber(value: elapsed, total: duration) { value in
                    elapsed = value
                    player?.seek(to: CMTime(seconds: value, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                }.phrenIdentifier("file-media-scrubber")
                HStack(spacing: 6) {
                    PhrenIconButton(icon: playing ? "pause.fill" : "play.fill", label: playing ? "Pause" : "Play") {
                        guard let player else { return }
                        if playing { player.pause() }
                        else {
                            if duration > 0, elapsed >= duration - 0.1 { player.seek(to: .zero) }
                            player.play()
                        }
                        playing.toggle()
                    }.disabled(player == nil || error != nil).phrenIdentifier("file-media-play")
                    Text("\(Self.time(elapsed)) / \(Self.time(duration))").font(PhrenTypography.monoCaption)
                        .phrenIdentifier("file-media-time")
                    Spacer(minLength: 0)
                    PhrenIconButton(icon: muted ? "speaker.slash.fill" : "speaker.wave.2.fill", label: muted ? "Unmute" : "Mute") {
                        muted.toggle(); player?.isMuted = muted
                    }.phrenIdentifier("file-media-mute")
                    PhrenIconButton(icon: fullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                    label: fullscreen ? "Exit fullscreen" : "Fullscreen") { fullscreen.toggle() }
                        .phrenIdentifier("file-media-fullscreen")
                }
            }.padding(.horizontal, 12).padding(.bottom, 8).background(PhrenTheme.surface)
        }
        .phrenIdentifier(audio ? "file-viewer-audio" : "file-viewer-video")
        .task(id: url) {
            do {
                let asset = AVURLAsset(url: url)
                guard try await asset.load(.isPlayable) else { throw MediaError.unsupported }
                let time = try await asset.load(.duration).seconds
                try Task.checkCancellation()
                duration = time.isFinite ? max(0, time) : 0
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: audio ? .default : .moviePlayback)
                try AVAudioSession.sharedInstance().setActive(true)
                player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            } catch { if !Task.isCancelled { self.error = "This media format cannot play on this iPhone. Save or share the file to open it elsewhere." } }
        }
        .onReceive(tick) { _ in
            guard let player else { return }
            let time = player.currentTime().seconds
            elapsed = time.isFinite ? max(0, time) : 0
            playing = player.rate > 0
            if player.currentItem?.status == .failed {
                error = "Playback failed. Save or share the file to open it elsewhere."
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .background { player?.pause(); playing = false } }
        .onDisappear {
            player?.pause(); playing = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
    private enum MediaError: Error { case unsupported }
    private static func time(_ seconds: Double) -> String {
        let value = seconds.isFinite ? max(0, Int(seconds)) : 0
        return value >= 3600 ? String(format: "%d:%02d:%02d", value / 3600, value / 60 % 60, value % 60)
            : String(format: "%d:%02d", value / 60, value % 60)
    }
}

/// A phren track and thumb with touch seeking and VoiceOver adjustments.
private struct FileScrubber: View {
    let value: Double
    let total: Double
    let seek: (Double) -> Void
    var body: some View {
        GeometryReader { geometry in
            let fraction = total > 0 ? min(1, max(0, value / total)) : 0
            ZStack(alignment: .leading) {
                FileProgressBar(value: fraction).frame(height: 4)
                Circle().fill(PhrenTheme.accent).frame(width: 14, height: 14)
                    .offset(x: max(0, geometry.size.width - 14) * fraction)
            }.frame(height: 44).contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { event in
                    if total > 0 { seek(min(1, max(0, event.location.x / max(1, geometry.size.width))) * total) }
                })
        }.frame(height: 44)
            .accessibilityElement().accessibilityLabel("Playback position")
            .accessibilityValue("\(Int(value)) of \(Int(total)) seconds")
            .accessibilityAdjustableAction { direction in
                seek(min(total, max(0, value + (direction == .increment ? 10 : -10))))
            }
    }
}
private struct FilePlayerSurface: UIViewRepresentable {
    let player: AVPlayer
    func makeUIView(context: Context) -> LayerView { LayerView() }
    func updateUIView(_ view: LayerView, context: Context) { view.playerLayer.player = player }
    static func dismantleUIView(_ view: LayerView, coordinator: ()) { view.playerLayer.player = nil }
    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
