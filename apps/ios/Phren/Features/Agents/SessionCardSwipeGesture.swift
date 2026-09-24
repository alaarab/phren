import SwiftUI
import UIKit

/// A horizontal card swipe cancels its tap, while vertical drags remain
/// available to the surrounding scroll view.
/// The horizontal swipe that reveals a session card's Close: a UIKit pan on
/// iOS 18 and newer (it cancels the tap and leaves vertical scrolling alone),
/// and the older drag gesture before that.
struct SessionCardSwipe: ViewModifier {
    var isEnabled = true
    let onSwipe: (Bool) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.gesture(SessionCardSwipeGesture(isEnabled: isEnabled, onSwipe: onSwipe))
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 30).onEnded { value in
                guard isEnabled, abs(value.translation.width) > abs(value.translation.height) else { return }
                onSwipe(value.translation.width < 0)
            })
        }
    }
}

@available(iOS 18, *)
struct SessionCardSwipeGesture: UIGestureRecognizerRepresentable {
    var isEnabled = true
    let onSwipe: (Bool) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.isEnabled = isEnabled
        recognizer.maximumNumberOfTouches = 1
        recognizer.cancelsTouchesInView = true
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isEnabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        guard recognizer.state == .ended else { return }
        let translation = recognizer.translation(in: recognizer.view)
        guard abs(translation.x) >= 30 else { return }
        onSwipe(translation.x < 0)
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            // The scroll view waits for the direction check. Vertical pans
            // fail it immediately and continue scrolling normally.
            otherGestureRecognizer is UIPanGestureRecognizer && otherGestureRecognizer.view is UIScrollView
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y) * 1.3
        }
    }
}
