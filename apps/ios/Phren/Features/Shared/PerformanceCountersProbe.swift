import PhrenKit
import SwiftUI
import UIKit

/// A one-point accessibility element whose value is `PerformanceCounters`
/// at the moment it is read. The value is computed when XCUITest asks for it,
/// so the probe never redraws and adds no work of its own between reads.
/// Present only in debug builds with `PHREN_PERFORMANCE_LOG=1`.
struct PerformanceCountersProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> ProbeView { ProbeView() }
    func updateUIView(_ uiView: ProbeView, context: Context) {}

    final class ProbeView: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isAccessibilityElement = true
            accessibilityIdentifier = "perf-counters"
            accessibilityLabel = "Performance counters"
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { nil }
        override var accessibilityValue: String? {
            get { PerformanceCounters.formatted() }
            set {}
        }
    }
}

extension View {
    /// Adds the counters probe in debug builds with performance logging on.
    @ViewBuilder func performanceCountersProbe() -> some View {
        #if DEBUG
        if PerformanceCounters.enabled {
            overlay(alignment: .topLeading) {
                PerformanceCountersProbe().frame(width: 1, height: 1).allowsHitTesting(false)
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}
