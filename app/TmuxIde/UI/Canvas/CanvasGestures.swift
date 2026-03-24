import AppKit
import SwiftUI

// MARK: - SwipeTracker

/// Velocity tracker for gesture momentum. Keeps a sliding window of deltas
/// and computes velocity + projected end position using exponential deceleration.
/// Adapted from IDX0's SwipeTracker.
struct SwipeTracker {
    private struct Event {
        let delta: CGFloat
        let timestamp: TimeInterval
    }

    var historyLimit: TimeInterval = 0.150
    var deceleration: CGFloat = 0.997

    private var events: [Event] = []
    private(set) var position: CGFloat = 0

    init(historyLimit: TimeInterval = 0.150, deceleration: CGFloat = 0.997) {
        self.historyLimit = historyLimit
        self.deceleration = deceleration
    }

    mutating func push(delta: CGFloat, at timestamp: TimeInterval) {
        if let last = events.last, timestamp < last.timestamp { return }
        events.append(Event(delta: delta, timestamp: timestamp))
        position += delta
        trimHistory(now: timestamp)
    }

    func velocity() -> CGFloat {
        guard let first = events.first, let last = events.last else { return 0 }
        let dt = CGFloat(last.timestamp - first.timestamp)
        guard dt > 0 else { return 0 }
        return events.reduce(CGFloat.zero) { $0 + $1.delta } / dt
    }

    /// Project where position will end up after momentum decays to zero.
    func projectedEndPosition() -> CGFloat {
        let v = velocity()
        let clamped = min(0.9999, max(0.0001, deceleration))
        return position - v / (1000 * log(clamped))
    }

    mutating func reset() {
        events.removeAll(keepingCapacity: false)
        position = 0
    }

    private mutating func trimHistory(now: TimeInterval) {
        let minTimestamp = now - historyLimit
        if let firstKeptIndex = events.firstIndex(where: { $0.timestamp >= minTimestamp }),
           firstKeptIndex > 0 {
            events.removeFirst(firstKeptIndex)
        }
    }
}

// MARK: - Gesture State Types

enum CanvasGestureAxis {
    case undecided
    case horizontal
    case vertical
}

struct CanvasGestureState {
    var axis: CanvasGestureAxis = .undecided
    var cumulative: CGSize = .zero
    var isActive: Bool = false
}

enum CanvasPanInputKind {
    case oneFingerDrag
    case twoFingerScroll
}

// MARK: - Canvas Gesture Manager

/// Manages canvas pan and zoom gestures with momentum and axis locking.
/// Wires into CameraStateManager for pan offset and CanvasMetrics for scale.
@MainActor
final class CanvasGestureManager: ObservableObject {
    // MARK: - Configuration

    /// Minimum gesture distance before axis lock decision (pixels).
    static let axisDecisionThreshold: CGFloat = 20

    /// Velocity threshold to trigger column-snap behavior (px/sec).
    static let snapVelocityThreshold: CGFloat = 500

    /// Zoom scale bounds.
    static let minScale: CGFloat = 0.3
    static let maxScale: CGFloat = 1.5

    /// Spring parameters for momentum decay.
    static let springStiffness: Double = 170
    static let springDamping: Double = 0.92

    // MARK: - Gesture runtime state

    private(set) var gesture = CanvasGestureState()
    private var committedOffset: CGSize = .zero

    /// Transient offset applied during an active gesture or momentum animation.
    @Published private(set) var transientOffset: CGSize = .zero

    /// Current zoom scale (published so views can react).
    @Published var scale: CGFloat = 1.0

    private var lastDragTranslation: CGSize = .zero
    private var horizontalTracker = SwipeTracker()
    private var verticalTracker = SwipeTracker()
    private var inputKind: CanvasPanInputKind = .oneFingerDrag

    // MARK: - External references

    private weak var camera: CameraStateManager?

    func attach(camera: CameraStateManager) {
        self.camera = camera
    }

    // MARK: - Computed offset

    /// Total visual offset = committed camera pan + transient gesture/animation offset.
    var effectiveOffset: CGPoint {
        CGPoint(
            x: (camera?.panOffset.x ?? 0) + committedOffset.width + transientOffset.width,
            y: (camera?.panOffset.y ?? 0) + committedOffset.height + transientOffset.height
        )
    }

    // MARK: - Begin gesture

    func beginGesture(inputKind: CanvasPanInputKind) {
        // Capture in-flight transient offset for velocity continuity on interrupted animations.
        committedOffset.width += transientOffset.width
        committedOffset.height += transientOffset.height
        transientOffset = .zero

        self.inputKind = inputKind
        gesture = CanvasGestureState(axis: .undecided, cumulative: .zero, isActive: true)
        lastDragTranslation = .zero
        horizontalTracker = SwipeTracker()
        verticalTracker = SwipeTracker()
    }

    // MARK: - One-finger drag

    func handleDragChanged(translation: CGSize) {
        if !gesture.isActive {
            beginGesture(inputKind: .oneFingerDrag)
        }
        let delta = CGSize(
            width: translation.width - lastDragTranslation.width,
            height: translation.height - lastDragTranslation.height
        )
        lastDragTranslation = translation
        handleGestureDelta(delta)
    }

    // MARK: - Two-finger scroll

    func handleScrollDelta(_ delta: CGSize) {
        if !gesture.isActive {
            beginGesture(inputKind: .twoFingerScroll)
        }
        // Invert delta: scroll direction → pan direction
        handleGestureDelta(CGSize(width: -delta.width, height: -delta.height))
    }

    // MARK: - Delta processing with axis locking

    private func handleGestureDelta(_ delta: CGSize) {
        let now = Date.timeIntervalSinceReferenceDate

        gesture.cumulative.width += delta.width
        gesture.cumulative.height += delta.height

        // Axis decision: wait until cumulative distance exceeds threshold
        if gesture.axis == .undecided {
            let distance = hypot(gesture.cumulative.width, gesture.cumulative.height)
            if distance < Self.axisDecisionThreshold { return }

            if abs(gesture.cumulative.width) >= abs(gesture.cumulative.height) {
                gesture.axis = .horizontal
                horizontalTracker.push(delta: gesture.cumulative.width, at: now)
                transientOffset = CGSize(width: horizontalTracker.position, height: 0)
            } else {
                gesture.axis = .vertical
                verticalTracker.push(delta: gesture.cumulative.height, at: now)
                transientOffset = CGSize(width: 0, height: verticalTracker.position)
            }
            return
        }

        // Once locked, only process the locked axis
        switch gesture.axis {
        case .horizontal:
            horizontalTracker.push(delta: delta.width, at: now)
            transientOffset = CGSize(width: horizontalTracker.position, height: 0)
        case .vertical:
            verticalTracker.push(delta: delta.height, at: now)
            transientOffset = CGSize(width: 0, height: verticalTracker.position)
        case .undecided:
            break
        }
    }

    // MARK: - End gesture

    func endGesture() {
        guard gesture.isActive else { return }
        gesture.isActive = false
        lastDragTranslation = .zero

        switch gesture.axis {
        case .horizontal:
            finishWithMomentum(axis: .horizontal)
        case .vertical:
            finishWithMomentum(axis: .vertical)
        case .undecided:
            animateReset(initialVelocity: 0)
        }
    }

    // MARK: - Momentum finish

    private func finishWithMomentum(axis: CanvasGestureAxis) {
        let tracker = axis == .horizontal ? horizontalTracker : verticalTracker
        let velocity = tracker.velocity()

        // Commit the tracker position into the camera's committed offset
        switch axis {
        case .horizontal:
            committedOffset.width += horizontalTracker.position
        case .vertical:
            committedOffset.height += verticalTracker.position
        case .undecided:
            break
        }

        // Push committed offset into the camera pan
        commitToCameraOffset()

        // Reset trackers
        horizontalTracker.reset()
        verticalTracker.reset()
        transientOffset = .zero
        gesture = CanvasGestureState()

        // If velocity is significant, animate with spring momentum
        if abs(velocity) > 50 {
            let projected = velocity / (1000 * log(min(0.9999, max(0.0001, CGFloat(0.997)))))
            let targetDelta = projected * 0.15 // Scale down for natural feel

            let springAnimation = Animation.interpolatingSpring(
                mass: 1,
                stiffness: Self.springStiffness,
                damping: 2.0 * sqrt(Self.springStiffness) * Self.springDamping,
                initialVelocity: velocity / max(abs(targetDelta), 1)
            )

            withAnimation(springAnimation) {
                guard let camera else { return }
                switch axis {
                case .horizontal:
                    camera.panOffset.x -= targetDelta
                case .vertical:
                    camera.panOffset.y -= targetDelta
                case .undecided:
                    break
                }
            }
        }
    }

    private func commitToCameraOffset() {
        guard let camera else { return }
        camera.panOffset.x -= committedOffset.width
        camera.panOffset.y -= committedOffset.height
        committedOffset = .zero
    }

    private func animateReset(initialVelocity: CGFloat) {
        // Commit any accumulated offset and reset
        commitToCameraOffset()
        horizontalTracker.reset()
        verticalTracker.reset()

        let spring = Animation.interpolatingSpring(
            mass: 1,
            stiffness: Self.springStiffness,
            damping: 2.0 * sqrt(Self.springStiffness) * Self.springDamping,
            initialVelocity: initialVelocity
        )
        withAnimation(spring) {
            transientOffset = .zero
        }
        gesture = CanvasGestureState()
    }

    // MARK: - Zoom (MagnifyGesture)

    func handleMagnification(_ magnification: CGFloat) {
        let newScale = max(Self.minScale, min(Self.maxScale, scale * (1 + magnification)))
        scale = newScale
    }

    func handleMagnificationEnd() {
        // Snap to overview scale if close
        let overviewThreshold: CGFloat = 0.08
        if abs(scale - CanvasMetrics.overviewScale) < overviewThreshold {
            withAnimation(CameraStateManager.cameraSpring) {
                scale = CanvasMetrics.overviewScale
            }
        } else if abs(scale - CanvasMetrics.focusedScale) < overviewThreshold {
            withAnimation(CameraStateManager.cameraSpring) {
                scale = CanvasMetrics.focusedScale
            }
        }
    }
}

// MARK: - Pan Capture NSView

/// Native NSView for capturing mouse drag and trackpad scroll events.
/// Ctrl+click/scroll activates canvas panning; unmodified events pass through to terminals.
struct CanvasPanCaptureView: NSViewRepresentable {
    let onDragBegan: () -> Void
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: () -> Void
    let onScrollBegan: () -> Void
    let onScroll: (CGSize) -> Void
    let onScrollEnded: () -> Void

    func makeNSView(context: Context) -> CanvasPanCaptureNSView {
        let view = CanvasPanCaptureNSView()
        view.onDragBegan = onDragBegan
        view.onDragChanged = onDragChanged
        view.onDragEnded = onDragEnded
        view.onScrollBegan = onScrollBegan
        view.onScroll = onScroll
        view.onScrollEnded = onScrollEnded
        return view
    }

    func updateNSView(_ nsView: CanvasPanCaptureNSView, context: Context) {
        nsView.onDragBegan = onDragBegan
        nsView.onDragChanged = onDragChanged
        nsView.onDragEnded = onDragEnded
        nsView.onScrollBegan = onScrollBegan
        nsView.onScroll = onScroll
        nsView.onScrollEnded = onScrollEnded
    }
}

final class CanvasPanCaptureNSView: NSView {
    var onDragBegan: (() -> Void)?
    var onDragChanged: ((CGSize) -> Void)?
    var onDragEnded: (() -> Void)?
    var onScrollBegan: (() -> Void)?
    var onScroll: ((CGSize) -> Void)?
    var onScrollEnded: (() -> Void)?

    private var dragStartInWindow: NSPoint?
    private var scrollGestureActive = false
    private var scrollEndWorkItem: DispatchWorkItem?

    override var acceptsFirstResponder: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Ctrl key gates canvas panning — unmodified events pass through to terminals.
    private func hasPanModifier(_ event: NSEvent) -> Bool {
        event.modifierFlags.contains(.control)
    }

    // MARK: - Mouse drag (Ctrl+click)

    override func mouseDown(with event: NSEvent) {
        guard hasPanModifier(event) else {
            super.mouseDown(with: event)
            return
        }
        window?.makeFirstResponder(self)
        dragStartInWindow = event.locationInWindow
        onDragBegan?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStartInWindow else {
            super.mouseDragged(with: event)
            return
        }
        let current = event.locationInWindow
        onDragChanged?(CGSize(
            width: current.x - start.x,
            height: current.y - start.y
        ))
    }

    override func mouseUp(with event: NSEvent) {
        if dragStartInWindow != nil {
            onDragEnded?()
            dragStartInWindow = nil
        } else {
            super.mouseUp(with: event)
        }
    }

    // MARK: - Right-click drag (Ctrl+right-click)

    private var rightDragStartInWindow: NSPoint?

    override func rightMouseDown(with event: NSEvent) {
        guard hasPanModifier(event) else {
            super.rightMouseDown(with: event)
            return
        }
        window?.makeFirstResponder(self)
        rightDragStartInWindow = event.locationInWindow
        onDragBegan?()
    }

    override func rightMouseDragged(with event: NSEvent) {
        guard let start = rightDragStartInWindow else {
            super.rightMouseDragged(with: event)
            return
        }
        let current = event.locationInWindow
        onDragChanged?(CGSize(
            width: current.x - start.x,
            height: current.y - start.y
        ))
    }

    override func rightMouseUp(with event: NSEvent) {
        if rightDragStartInWindow != nil {
            onDragEnded?()
            rightDragStartInWindow = nil
        } else {
            super.rightMouseUp(with: event)
        }
    }

    // MARK: - Trackpad scroll (Ctrl+two-finger scroll)

    override func scrollWheel(with event: NSEvent) {
        guard event.hasPreciseScrollingDeltas else { return }
        guard hasPanModifier(event) else {
            super.scrollWheel(with: event)
            return
        }

        if !scrollGestureActive {
            scrollGestureActive = true
            onScrollBegan?()
        }

        onScroll?(CGSize(width: event.scrollingDeltaX, height: event.scrollingDeltaY))
        scheduleScrollEnd()

        if event.phase == .ended || event.phase == .cancelled || event.momentumPhase == .ended {
            finishScrollGesture()
        }
    }

    private func scheduleScrollEnd() {
        scrollEndWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.finishScrollGesture()
        }
        scrollEndWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09, execute: work)
    }

    private func finishScrollGesture() {
        scrollEndWorkItem?.cancel()
        scrollEndWorkItem = nil
        if scrollGestureActive {
            scrollGestureActive = false
            onScrollEnded?()
        }
    }
}

// MARK: - Gesture-Enabled Canvas Overlay

/// Wraps canvas content with pan and zoom gesture handling.
/// Replaces the ScrollView in CanvasContainerView with a gesture-driven canvas.
struct CanvasGestureOverlay<Content: View>: View {
    @ObservedObject var gestureManager: CanvasGestureManager
    @ObservedObject var camera: CameraStateManager
    let content: Content

    init(
        gestureManager: CanvasGestureManager,
        camera: CameraStateManager,
        @ViewBuilder content: () -> Content
    ) {
        self.gestureManager = gestureManager
        self.camera = camera
        self.content = content()
    }

    var body: some View {
        GeometryReader { proxy in
            content
                .scaleEffect(gestureManager.scale, anchor: .center)
                .offset(
                    x: -gestureManager.effectiveOffset.x,
                    y: -gestureManager.effectiveOffset.y
                )
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                .clipped()
                .overlay {
                    // Native NSView pan capture layer
                    CanvasPanCaptureView(
                        onDragBegan: {
                            gestureManager.beginGesture(inputKind: .oneFingerDrag)
                        },
                        onDragChanged: { translation in
                            gestureManager.handleDragChanged(translation: translation)
                        },
                        onDragEnded: {
                            gestureManager.endGesture()
                        },
                        onScrollBegan: {
                            gestureManager.beginGesture(inputKind: .twoFingerScroll)
                        },
                        onScroll: { delta in
                            gestureManager.handleScrollDelta(delta)
                        },
                        onScrollEnded: {
                            gestureManager.endGesture()
                        }
                    )
                    .allowsHitTesting(true)
                }
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in
                            gestureManager.handleMagnification(value.magnification - 1)
                        }
                        .onEnded { _ in
                            gestureManager.handleMagnificationEnd()
                        }
                )
        }
    }
}
