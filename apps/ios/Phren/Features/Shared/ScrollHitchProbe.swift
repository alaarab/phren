import PhrenKit
import QuartzCore
import UIKit

/// Frame pacing while a scroll view moves, for `PerformanceCounters`: frames
/// drawn, frames that missed their deadline, the time lost to them, and the
/// time from a gesture's start to the scroll coming to rest. It runs only
/// between a scroll phase leaving and returning to idle, and only in debug
/// builds with `PHREN_PERFORMANCE_LOG=1`, so an idle app keeps no display link.
@MainActor
final class ScrollHitchProbe: NSObject {
    static let shared = ScrollHitchProbe()
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var startedAt: CFTimeInterval = 0

    func moving(_ moving: Bool, name: String) {
        guard PerformanceCounters.enabled else { return }
        if moving, link == nil {
            last = 0; startedAt = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        } else if !moving, let link {
            link.invalidate(); self.link = nil
            PerformanceCounters.bump("scroll.\(name).settle-ms", by: Int((CACurrentMediaTime() - startedAt) * 1_000))
            PerformanceCounters.bump("scroll.\(name).gestures")
        }
    }

    @objc private func frame(_ link: CADisplayLink) {
        defer { last = link.timestamp }
        guard last > 0 else { return }
        let expected = link.targetTimestamp - link.timestamp
        let interval = link.timestamp - last
        PerformanceCounters.bump("scroll.frames")
        // A frame that arrived more than half a frame late is a hitch; the
        // time past its deadline is what the person saw as a stall.
        if expected > 0, interval > expected * 1.5 {
            PerformanceCounters.bump("scroll.hitches")
            PerformanceCounters.bump("scroll.hitch-ms", by: Int(((interval - expected) * 1_000).rounded()))
        }
    }
}
