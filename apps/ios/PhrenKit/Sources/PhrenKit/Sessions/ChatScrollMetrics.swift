import Foundation

/// Geometry used to decide whether a followed chat transcript needs to move.
/// Keeping this independent of SwiftUI makes the keyboard and streaming cases
/// deterministic and testable.
public struct ChatScrollMetrics: Equatable, Sendable {
    public let contentHeight: CGFloat
    public let viewportHeight: CGFloat
    public let offsetY: CGFloat

    public init(contentHeight: CGFloat, viewportHeight: CGFloat, offsetY: CGFloat) {
        self.contentHeight = contentHeight
        self.viewportHeight = viewportHeight
        self.offsetY = offsetY
    }

    /// The largest valid vertical offset. Insets are deliberately excluded:
    /// they alter the viewport, not the transcript's real end.
    public var bottomOffset: CGFloat {
        max(0, contentHeight - viewportHeight)
    }

    public var distanceFromBottom: CGFloat {
        bottomOffset - offsetY
    }

    /// Returns the clamped bottom offset for transcript growth or an already
    /// invalid offset. A keyboard or surrounding control changing the viewport
    /// alone must not enqueue another follow scroll against intermediate
    /// layout geometry.
    public static func shouldRepin(
        old: ChatScrollMetrics,
        new: ChatScrollMetrics,
        userDriven: Bool
    ) -> CGFloat? {
        let contentGrew = new.contentHeight > old.contentHeight + 0.5
        let offsetPastEnd = new.offsetY > new.bottomOffset + 0.5
        guard !userDriven,
              new.contentHeight > new.viewportHeight + 0.5,
              contentGrew || offsetPastEnd else { return nil }
        return new.bottomOffset
    }
}
