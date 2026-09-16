import SwiftUI
import UIKit
import WebKit
import PhrenKit

struct ChatFullDiff: Identifiable, Hashable {
    let id = UUID()
    let file: AgentRepositoryDiff.File
    let section: AgentRepositoryDiff.Section
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private struct OpenChatDiffKey: EnvironmentKey { static let defaultValue: (ChatFullDiff) -> Void = { _ in } }
private struct OpenToolOutputKey: EnvironmentKey { static let defaultValue: (FullToolOutput) -> Void = { _ in } }
extension EnvironmentValues {
    var openChatDiff: (ChatFullDiff) -> Void { get { self[OpenChatDiffKey.self] } set { self[OpenChatDiffKey.self] = newValue } }
    var openToolOutput: (FullToolOutput) -> Void { get { self[OpenToolOutputKey.self] } set { self[OpenToolOutputKey.self] = newValue } }
}

/// What the SwiftUI side needs from UIKit: the navigation controller the
/// bridge found, so keyboard shortcuts declared in SwiftUI can pop it.
private final class NavigationBridgeHandle: ObservableObject {
    weak var navigationController: UINavigationController?
    func back() {
        guard let navigationController else { return }
        if navigationController.viewControllers.count > 1 { navigationController.popViewController(animated: true) }
        else if navigationController.presentingViewController != nil { navigationController.dismiss(animated: true) }
    }
    func closePresentation() {
        guard let navigationController, navigationController.presentingViewController != nil else { return }
        navigationController.dismiss(animated: true)
    }
}

private struct NavigationBridgeModifier: ViewModifier {
    let installsPan: Bool
    var hidesNavigationBar = false
    @StateObject private var handle = NavigationBridgeHandle()
    func body(content: Content) -> some View {
        content
            // Hardware keyboard shortcuts (Escape, ⌘[, ⌘W) are UIKit key
            // commands on the navigation controller — see
            // UINavigationController.installPhrenKeyCommands — because it sits
            // in the responder chain of everything it hosts, whatever has focus.
            .background(NavigationControllerBridge(installsPan: installsPan, hidesNavigationBar: hidesNavigationBar, handle: handle).frame(width: 0, height: 0))
    }
}

/// Restores UINavigationController's native edge pop after a pushed screen
/// hides its navigation bar, and provides the app-wide hold/drag-anywhere
/// gesture for Back.
private struct NavigationControllerBridge: UIViewControllerRepresentable {
    var installsPan = false
    var hidesNavigationBar = false
    let handle: NavigationBridgeHandle

    func makeUIViewController(context: Context) -> Controller { Controller(installsPan: installsPan, hidesNavigationBar: hidesNavigationBar, handle: handle) }
    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.installsPan = installsPan
        controller.hidesNavigationBar = hidesNavigationBar
        controller.installIfNeeded()
    }
    static func dismantleUIViewController(_ controller: Controller, coordinator: Void) { controller.uninstall() }

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        var installsPan: Bool
        var hidesNavigationBar: Bool
        let handle: NavigationBridgeHandle
        private weak var installedNavigationController: UINavigationController?
        private var pan: UIPanGestureRecognizer?

        private var observers: [NSObjectProtocol] = []
        init(installsPan: Bool, hidesNavigationBar: Bool, handle: NavigationBridgeHandle) {
            self.installsPan = installsPan
            self.hidesNavigationBar = hidesNavigationBar
            self.handle = handle
            super.init(nibName: nil, bundle: nil)
            let center = NotificationCenter.default
            observers = [
                center.addObserver(forName: .phrenDisablePanBack, object: nil, queue: .main) { [weak self] _ in self?.pan?.isEnabled = false },
                center.addObserver(forName: .phrenEnablePanBack, object: nil, queue: .main) { [weak self] _ in self?.pan?.isEnabled = true },
                center.addObserver(forName: .phrenDisableAllBackGestures, object: nil, queue: .main) { [weak self] _ in
                    self?.pan?.isEnabled = false
                    self?.navigationController?.interactivePopGestureRecognizer?.isEnabled = false
                },
                center.addObserver(forName: .phrenEnableAllBackGestures, object: nil, queue: .main) { [weak self] _ in
                    self?.pan?.isEnabled = true
                    if let navigationController = self?.navigationController {
                        navigationController.interactivePopGestureRecognizer?.isEnabled = navigationController.viewControllers.count > 1
                    }
                },
            ]
        }
        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
        deinit {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
        }
        override func loadView() {
            view = UIView(frame: .zero)
            view.isUserInteractionEnabled = false
            view.backgroundColor = .clear
        }
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            if hidesNavigationBar { navigationController?.setNavigationBarHidden(true, animated: animated) }
            installIfNeeded()
        }
        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            // Leaving (pop or push onward): give the next screen its bar back
            // unless it hides its own.
            if hidesNavigationBar, let navigationController,
               navigationController.transitionCoordinator?.viewController(forKey: .to).map({ !$0.prefersPhrenHiddenNavigationBar }) ?? true {
                navigationController.setNavigationBarHidden(false, animated: animated)
            }
        }
        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            parent?.phrenHidesNavigationBar = hidesNavigationBar
        }
        // Key commands are found by walking up from the first responder. With
        // no field focused there is none, so this zero-size controller stands
        // in: its chain runs through the hosting controller to the navigation
        // controller, which answers Escape / ⌘[ / ⌘W. A focused text field
        // reaches the same navigation controller on its own.
        override var canBecomeFirstResponder: Bool { true }
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            installIfNeeded()
            // SwiftUI re-arms the pop recognizer's own delegate around a
            // transition; take it back once the transition has settled.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.installIfNeeded()
                if self.view.window?.firstResponderIsTextInput != true { self.becomeFirstResponder() }
            }
        }

        func installIfNeeded() {
            guard let navigationController else { return }
            handle.navigationController = navigationController
            navigationController.installPhrenKeyCommands()
            // With a hidden bar UIKit's own delegate refuses the edge pop;
            // owning the delegate keeps it available on every pushed screen.
            if let pop = navigationController.interactivePopGestureRecognizer {
                pop.delegate = self
                pop.isEnabled = navigationController.viewControllers.count > 1
            }
            guard installsPan else { return }
            if installedNavigationController !== navigationController { uninstall() }
            guard pan == nil else { return }
            let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            recognizer.cancelsTouchesInView = false
            recognizer.delegate = self
            navigationController.view.addGestureRecognizer(recognizer)
            installedNavigationController = navigationController
            pan = recognizer
        }

        func uninstall() {
            if let pan { installedNavigationController?.view.removeGestureRecognizer(pan) }
            pan = nil
            installedNavigationController = nil
        }

        @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
            guard recognizer.state == .ended, let navigationController,
                  navigationController.viewControllers.count > 1,
                  navigationController.transitionCoordinator == nil else { return }
            let translation = recognizer.translation(in: navigationController.view)
            let velocity = recognizer.velocity(in: navigationController.view)
            if translation.x > 70, abs(translation.x) > abs(translation.y) * 1.35, velocity.x > 0 {
                navigationController.popViewController(animated: true)
            }
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let navigationController, navigationController.viewControllers.count > 1 else { return false }
            // The system edge pop: allowed whenever there is somewhere to go back to.
            if gestureRecognizer === navigationController.interactivePopGestureRecognizer { return true }
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: navigationController.view)
            guard velocity.x > 0, abs(velocity.x) > abs(velocity.y) * 1.35 else { return false }
            let point = pan.location(in: navigationController.view)
            // The screen edge is the system pop's; running there too would pop twice.
            guard point.x > 44 else { return false }
            guard let hit = navigationController.view.hitTest(point, with: nil), !Self.excludesPan(hit) else { return false }
            return true
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            otherGestureRecognizer !== navigationController?.interactivePopGestureRecognizer
        }
        /// UIKit's own pop delegate makes every scroll view's pan wait for the
        /// edge pop to fail; owning the delegate drops that rule, and a
        /// scrollable transcript would swallow the edge swipe. Restore it.
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            gestureRecognizer === navigationController?.interactivePopGestureRecognizer
                && otherGestureRecognizer is UIPanGestureRecognizer && otherGestureRecognizer !== pan
        }

        private static func excludesPan(_ initial: UIView) -> Bool {
            var view: UIView? = initial
            while let current = view {
                if current is UITextField || current is UITextView || current is WKWebView { return true }
                if let scroll = current as? UIScrollView,
                   scroll.contentSize.width > scroll.bounds.width + 1 { return true }
                let name = String(describing: type(of: current))
                if name.contains("Terminal") || name.contains("GraphWeb") || name.contains("SimulatorScreen") { return true }
                view = current.superview
            }
            return false
        }
    }
}

/// A NavigationStack whose root carries the app's back affordances: the
/// hold-and-drag-anywhere pop, Escape / ⌘[ / ⌘W, and the archive
/// destinations every tab can reach. They have to sit *inside* the stack —
/// on the stack view itself they have no navigation controller to talk to
/// and `navigationDestination` registrations are ignored.
struct PhrenNavigationStack<Content: View>: View {
    private var path: Binding<NavigationPath>?
    @ViewBuilder private let content: () -> Content
    init(@ViewBuilder content: @escaping () -> Content) { self.path = nil; self.content = content }
    init(path: Binding<NavigationPath>, @ViewBuilder content: @escaping () -> Content) { self.path = path; self.content = content }
    var body: some View {
        if let path {
            NavigationStack(path: path) { content().panToGoBack().archiveNavigationDestinations() }
        } else {
            NavigationStack { content().panToGoBack().archiveNavigationDestinations() }
        }
    }
}

extension View {
    /// Use on a NavigationStack's root content. A rightward, mostly-horizontal
    /// pan from any non-horizontal control performs a real UINavigationController pop.
    func panToGoBack() -> some View {
        modifier(NavigationBridgeModifier(installsPan: true))
    }

    /// Use on pushed full-bleed screens whose custom header replaces the
    /// native bar. `hidesNavigationBar` hides it at the UIKit level: SwiftUI's
    /// `.toolbar(.hidden, for: .navigationBar)` also switches off the edge
    /// pop in a way no delegate can bring back.
    func keepsInteractivePop(hidesNavigationBar: Bool = false) -> some View {
        modifier(NavigationBridgeModifier(installsPan: false, hidesNavigationBar: hidesNavigationBar))
    }

    /// Full-width horizontal canvases own their drag gesture completely.
    func disablesPanToGoBack() -> some View {
        onAppear { NotificationCenter.default.post(name: .phrenDisablePanBack, object: nil) }
            .onDisappear { NotificationCenter.default.post(name: .phrenEnablePanBack, object: nil) }
    }

    func disablesNavigationPopGestures() -> some View {
        onAppear { NotificationCenter.default.post(name: .phrenDisableAllBackGestures, object: nil) }
            .onDisappear { NotificationCenter.default.post(name: .phrenEnableAllBackGestures, object: nil) }
    }

    /// Archive links live in ProjectDetailView but that view is reachable from
    /// every tab. Register these once at each stack root.
    func archiveNavigationDestinations() -> some View {
        navigationDestination(for: ArchiveRoute.self) { route in
            ArchiveBrowserView(storeId: route.storeId, project: route.project)
        }
        .navigationDestination(for: ArchiveTopicRoute.self) { route in
            ArchiveTopicView(storeId: route.storeId, topic: route.topic)
        }
    }
}

private extension Notification.Name {
    static let phrenDisablePanBack = Notification.Name("phren.navigation.pan-back.disable")
    static let phrenEnablePanBack = Notification.Name("phren.navigation.pan-back.enable")
    static let phrenDisableAllBackGestures = Notification.Name("phren.navigation.all-back.disable")
    static let phrenEnableAllBackGestures = Notification.Name("phren.navigation.all-back.enable")
}

/// Escape / ⌘[ / ⌘W answered by the navigation controller itself: it is in
/// the responder chain of every view it hosts, whatever has focus.
extension UINavigationController {
    private static let phrenKeyCommandsMarker = "phren.navigation.keys"
    func installPhrenKeyCommands() {
        guard !(keyCommands ?? []).contains(where: { $0.discoverabilityTitle == Self.phrenKeyCommandsMarker }) else { return }
        let commands = [
            UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(phrenGoBack)),
            UIKeyCommand(input: "[", modifierFlags: .command, action: #selector(phrenGoBack)),
            UIKeyCommand(input: "w", modifierFlags: .command, action: #selector(phrenClosePresentation)),
        ]
        for command in commands {
            command.discoverabilityTitle = Self.phrenKeyCommandsMarker
            command.wantsPriorityOverSystemBehavior = true
            addKeyCommand(command)
        }
    }
    @objc func phrenGoBack() {
        if viewControllers.count > 1 { popViewController(animated: true) }
        else if presentingViewController != nil { dismiss(animated: true) }
    }
    @objc func phrenClosePresentation() {
        guard presentingViewController != nil else { return }
        dismiss(animated: true)
    }
}

/// Whether a hosting controller was marked (by its bridge) as replacing the
/// navigation bar with its own header, so a sibling leaving it alone.
private var phrenHidesNavigationBarKey: UInt8 = 0
extension UIViewController {
    var phrenHidesNavigationBar: Bool {
        get { objc_getAssociatedObject(self, &phrenHidesNavigationBarKey) as? Bool ?? false }
        set { objc_setAssociatedObject(self, &phrenHidesNavigationBarKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }
    var prefersPhrenHiddenNavigationBar: Bool {
        phrenHidesNavigationBar || children.contains { $0.prefersPhrenHiddenNavigationBar }
    }
}

private extension UIWindow {
    var firstResponderIsTextInput: Bool {
        guard let responder = firstResponderInHierarchy(from: self) else { return false }
        return responder is UITextInput
    }
    private func firstResponderInHierarchy(from view: UIView) -> UIResponder? {
        if view.isFirstResponder { return view }
        for child in view.subviews { if let found = firstResponderInHierarchy(from: child) { return found } }
        return nil
    }
}
