// Stand-ins for everything the focus coordinator touches outside the app's own memory. The unit tests use them, and so does every scripted launch
// (`--ui-check`, `--fixture`, `--background`): nothing here plays a sound, runs `shortcuts`, changes a Focus, reads the person's input or puts a window on a screen.
// Each one records what it was asked, so a check can say "the chime was requested" without it ever being heard.
import Foundation

/// A "Conn Focus On / Off" that only records the calls. `results` is what each call answers (the last one repeats); `delay` makes a call take time.
public final class ScriptedFocusSwitch: FocusSwitching, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [Bool] = []
    private var _blocking: [Bool] = []
    private var _results: [FocusSwitchResult]
    private var _setup: FocusSetupStatus
    private var _checks = 0
    private var _focusOn = false
    public var delay: TimeInterval

    public init(results: [FocusSwitchResult] = [.done], setup: FocusSetupStatus = .ready, delay: TimeInterval = 0) {
        _results = results; _setup = setup; self.delay = delay
    }

    /// Every `set(on:)` in order: true for On, false for Off.
    public var calls: [Bool] { lock.lock(); defer { lock.unlock() }; return _calls }
    public var blockingCalls: [Bool] { lock.lock(); defer { lock.unlock() }; return _blocking }
    public var setupChecks: Int { lock.lock(); defer { lock.unlock() }; return _checks }
    public func setResults(_ r: [FocusSwitchResult]) { lock.lock(); _results = r; lock.unlock() }
    public func setSetup(_ s: FocusSetupStatus) { lock.lock(); _setup = s; lock.unlock() }
    /// Whether the pretend Focus is on: true after an On that answered `.done`, false after an Off that did.
    public var focusIsOn: Bool { lock.lock(); defer { lock.unlock() }; return _focusOn }

    private func next() -> FocusSwitchResult {
        lock.lock(); defer { lock.unlock() }
        return _calls.count <= _results.count ? _results[max(0, _calls.count - 1)] : _results.last ?? .done
    }

    public func set(on: Bool) async -> FocusSwitchResult {
        lock.withLock { _calls.append(on) }
        if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
        let r = next()
        if r == .done { lock.withLock { _focusOn = on } }
        return r
    }

    public func setBlocking(on: Bool) -> FocusSwitchResult {
        lock.lock(); _blocking.append(on); lock.unlock()
        let r = next()
        if r == .done { lock.withLock { _focusOn = on } }
        return r
    }

    public func checkSetup() async -> FocusSetupStatus {
        lock.withLock { _checks += 1; return _setup }
    }
}

/// Focus Status: what macOS "says". By default it follows the stand-in switch (`switchState`: on after an On that worked, off after an Off), like a Focus that really
/// switches; with `fixed` set it answers `answer` whatever the switch did (true, false, or nil for "no answer").
@MainActor
public final class ScriptedFocusStatus: FocusStatusReading {
    public var authorization: FocusAuthorization
    public var answer: Bool?
    public var fixed = false
    public var switchState: (() -> Bool)?
    public var authorizationAfterRequest: FocusAuthorization
    public private(set) var requests = 0
    public private(set) var asks = 0

    public init(authorization: FocusAuthorization = .authorized, afterRequest: FocusAuthorization = .authorized) {
        self.authorization = authorization; authorizationAfterRequest = afterRequest
    }

    public func requestAuthorization() async -> FocusAuthorization {
        requests += 1
        authorization = authorizationAfterRequest
        return authorization
    }

    public func isFocused() -> Bool? {
        asks += 1
        guard authorization == .authorized else { return nil }
        if fixed { return answer }
        return switchState?() ?? answer
    }
}

@MainActor
public final class SilentChimes: FocusChiming {
    public enum Chime: Equatable, Sendable { case sessionEnded, eyeBreakStarted, eyeBreakEnded }
    public private(set) var played: [Chime] = []
    public init() {}
    public func sessionEnded() { played.append(.sessionEnded) }
    public func eyeBreakStarted() { played.append(.eyeBreakStarted) }
    public func eyeBreakEnded() { played.append(.eyeBreakEnded) }
}

/// A panel that is never drawn: it only counts how often it was asked to show or hide, and whether it is "up".
@MainActor
public final class ScriptedPanel: EyePanelPresenting {
    public private(set) var presented = 0
    public private(set) var dismissed = 0
    public private(set) var completedCount = 0
    public private(set) var isUp = false
    public init() {}
    public func present() { presented += 1; isUp = true }
    public func completed() { completedCount += 1; isUp = false }
    public func dismiss() { dismissed += 1; isUp = false }
}

/// A person who does what the test says: idle for so long, screen locked or not.
@MainActor
public final class ScriptedPresence: PresenceReading {
    public var idleSeconds: TimeInterval = 0
    public var screenLocked = false
    public var asleep = false
    public var left = false
    public private(set) var samples = 0
    public init() {}
    public func sample() -> PresenceSample {
        samples += 1
        defer { left = false }
        return PresenceSample(idleSeconds: idleSeconds, screenLocked: screenLocked, asleep: asleep, leftSinceLastSample: left)
    }
}

/// A ticker that never fires on its own: a test (or the scripted launch) calls `fire()`.
@MainActor
public final class ManualTicker: FocusTicking {
    public private(set) var interval: TimeInterval?
    public private(set) var starts = 0
    private var handler: (@MainActor () -> Void)?
    public init() {}
    public func start(every seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) { interval = seconds; handler = fire; starts += 1 }
    public func stop() { interval = nil; handler = nil }
    public var isRunning: Bool { interval != nil }
    public func fire() { handler?() }
}
