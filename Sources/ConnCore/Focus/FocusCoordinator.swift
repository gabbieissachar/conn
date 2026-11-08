// The focus feature's one owner: it holds the focus session and the eye clock (both pure value types), drives them from an injected clock, and does what their
// events call for: the chimes, the eye-break panel, the macOS Focus (through a Shortcut), the marker file for other tools, and the daily total.
//
// Everything outside the app's own memory sits behind a small protocol (`FocusSwitching`, `FocusStatusReading`, `FocusChiming`, `EyePanelPresenting`,
// `PresenceReading`, `FocusTicking`), so the unit tests and every scripted launch run the whole thing with stand-ins: no sound, no `shortcuts run`, no Focus
// change, no panel that can show over a person's screen (`FocusStandIns.swift`). The app's real ones are in `Sources/Conn/FocusPlatform.swift`.
//
// Decisions it carries out (README "Focus sessions"): F1 only other apps' banners go quiet (Conn's own badge and Herdr's toasts are not notifications, so the
// Focus allows no apps and needs no exception), F5 a countdown in the toolbar and the menu bar, F6 a chime and Done with Restart, F7 pause, +5 min, stop early,
// F8 the eye clock has its own switch and runs outside sessions, F9 to F11 the eye panel with Skip and Snooze, F10 away resets the clock, F13 the daily total,
// F14 the marker file, F15 the Focus stays on while paused, F16 it goes off the moment the time is up, F18 Mac only, F21 a check that the Focus really came on.
import Foundation
import Combine

public enum FocusAuthorization: Equatable, Sendable { case notDetermined, denied, restricted, authorized }

/// Whether the Focus really turned on, as far as Conn knows (decision F21).
public enum FocusLink: Equatable, Sendable {
    /// Conn Focus is not on (no session, or it has been switched off).
    case off
    case switchingOn
    /// macOS says a Focus is on.
    case onConfirmed
    /// The shortcut ran, but Conn cannot tell (Focus Status not allowed, or another Focus was already on): a neutral state, not an alarm.
    case onUnconfirmed(String)
    /// Red: Conn Focus did not switch on, so other apps' banners are not silenced. The sentence says why.
    case didNotSwitchOn(String)
    /// Red: Conn Focus may still be on because the Off shortcut did not finish.
    case couldNotSwitchOff(String)

    public var isRed: Bool {
        switch self { case .didNotSwitchOn, .couldNotSwitchOff: return true; default: return false }
    }
}

@MainActor
public protocol FocusStatusReading: AnyObject {
    var authorization: FocusAuthorization { get }
    /// Shows macOS's one-time Focus Status prompt when the answer is not yet known.
    func requestAuthorization() async -> FocusAuthorization
    /// Whether some Focus is on (never which one); nil when macOS does not say.
    func isFocused() -> Bool?
}

@MainActor
public protocol FocusChiming: AnyObject {
    func sessionEnded()
    func eyeBreakStarted()
    func eyeBreakEnded()
}

@MainActor
public protocol EyePanelPresenting: AnyObject {
    /// Show the break panel (never taking the keyboard); it reads what to draw from the coordinator.
    func present()
    func dismiss()
}

@MainActor
public protocol PresenceReading: AnyObject {
    /// One reading of idle time, lock and sleep. Clears `leftSinceLastSample`.
    func sample() -> PresenceSample
}

@MainActor
public protocol FocusTicking: AnyObject {
    func start(every seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void)
    func stop()
}

/// Redraws the countdowns: views that show a time left observe this, so the second-by-second change does not invalidate anything that only needs the state.
@MainActor
public final class FocusFace: ObservableObject {
    @Published public private(set) var now: Date
    public init(now: Date) { self.now = now }
    func set(_ d: Date) { if d != now { now = d } }
}

@MainActor
public final class FocusCoordinator: ObservableObject {
    // MARK: state

    @Published public private(set) var session: FocusSession
    @Published public private(set) var eye = EyeBreakClock()
    @Published public private(set) var link: FocusLink = .off
    @Published public private(set) var setupStatus: FocusSetupStatus?
    @Published public private(set) var statusAccess: FocusAuthorization
    /// A one-line message the UI shows until it is dismissed (for example, the Focus was still on after the last run and has been switched off).
    @Published public private(set) var notice: String?
    @Published public private(set) var totals: FocusDayTotal
    /// Privacy mode is on: the eye panel is hidden from screen capture and sharing (decision F22). Set by the app.
    @Published public var privacyActive = false
    /// The length the Start button offers: the last one used.
    @Published public var chosenMinutes: Int
    /// True once the app has quit (or `shutdown` ran): nothing starts again.
    public private(set) var isShutDown = false
    /// The last time the marker file could not be written, if ever (the session goes on without it).
    public private(set) var markerWriteFailed = false

    public let face: FocusFace

    public var eyeEnabled: Bool { eye.isOn }

    // MARK: collaborators

    private let clock: FocusClock
    private let focusSwitch: FocusSwitching
    private let status: FocusStatusReading
    private let chimes: FocusChiming
    private let panel: EyePanelPresenting
    private let presence: PresenceReading
    private let ticker: FocusTicking
    private let marker: FocusMarkerFile
    private let totalsStore: FocusTotalsStore
    private let prefs: FocusPrefs
    private let pid: Int32
    /// How long a "turn on" waits for macOS to say a Focus is on, and how often it asks.
    public var confirmSeconds: TimeInterval = 3
    public var confirmEvery: TimeInterval = 0.5
    /// A pause between two asks; tests replace it so they do not wait.
    public var pause: (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }

    private var chain: Task<Void, Never>?
    private var tickEvery: TimeInterval?
    private var watchers = 0

    public init(clock: FocusClock, focusSwitch: FocusSwitching, status: FocusStatusReading, chimes: FocusChiming, panel: EyePanelPresenting, presence: PresenceReading,
                ticker: FocusTicking, marker: FocusMarkerFile, totals: FocusTotalsStore, prefs: FocusPrefs, eyeConfig: EyeBreakConfig = EyeBreakConfig(), pid: Int32 = getpid()) {
        self.clock = clock; self.focusSwitch = focusSwitch; self.status = status; self.chimes = chimes; self.panel = panel; self.presence = presence
        self.ticker = ticker; self.marker = marker; self.totalsStore = totals; self.prefs = prefs; self.pid = pid
        chosenMinutes = prefs.minutes
        session = FocusSession(lengthMinutes: prefs.minutes)
        eye = EyeBreakClock(config: eyeConfig)
        statusAccess = status.authorization
        self.totals = totals.today(at: clock.now)
        face = FocusFace(now: clock.now)
    }

    // MARK: launch and quit

    /// At every launch: remove a marker whose owner is gone, switch the Focus off if the last run left it on (a crash or a kill), and start the eye clock if its
    /// switch is on.
    public func launch() {
        guard !isShutDown else { return }
        marker.removeIfStale()
        if prefs.focusMayBeOn {
            enqueue { [self] in
                let r = await focusSwitch.set(on: false)
                if r.isDone {
                    prefs.focusMayBeOn = false
                    if !session.isActive { link = .off }
                    notice = "Conn Focus was still on from the last run. It is off now."
                } else if !session.isActive {
                    link = .couldNotSwitchOff(r.problem ?? "unknown")
                }
            }
        }
        if prefs.eyeEnabled { apply(\.eye) { $0.enable(now: clock.now) } }
        statusAccess = status.authorization
        refreshTotals()
        tick()
    }

    /// At quit: the session ends (what was focused counts), the marker goes, the eye panel closes and the Focus is switched off, waiting for it a few seconds.
    public func shutdown() {
        guard !isShutDown else { return }
        isShutDown = true
        ticker.stop(); tickEvery = nil
        panel.dismiss()
        let now = clock.now
        if session.isActive {
            for case .ended(_, let focused) in apply(\.session, { $0.stopEarly(now: now) }) { totalsStore.addFocused(focused, at: now) }
        }
        marker.remove()
        if prefs.focusMayBeOn {
            if focusSwitch.setBlocking(on: false).isDone { prefs.focusMayBeOn = false }
        }
    }

    // MARK: the session

    public func start(minutes: Int) {
        guard !isShutDown else { return }
        let now = clock.now
        guard !apply(\.session, { $0.start(minutes: minutes, now: now) }).isEmpty else { return }
        prefs.minutes = session.lengthMinutes
        chosenMinutes = session.lengthMinutes
        began()
    }

    /// Run the last length again (from Done).
    public func restart() {
        guard !isShutDown else { return }
        let now = clock.now
        guard !apply(\.session, { $0.restart(now: now) }).isEmpty else { return }
        began()
    }

    private func began() {
        writeMarker()
        switchOn()
        refresh()
    }

    public func pauseSession() {
        let now = clock.now
        let events = apply(\.session) { $0.pause(now: now) }
        guard !events.isEmpty else { return }
        for e in events { handleSessionEnd(e) }      // a pause at the very moment the time is up is the end
        writeMarker()
        refresh()
    }

    public func resumeSession() {
        let now = clock.now
        guard !apply(\.session, { $0.resume(now: now) }).isEmpty else { return }
        writeMarker()
        refresh()
    }

    public func extendSession() {
        let now = clock.now
        guard !apply(\.session, { $0.extend(now: now) }).isEmpty else { return }
        writeMarker()
        refresh()
    }

    public func stopEarly() {
        let now = clock.now
        let events = apply(\.session) { $0.stopEarly(now: now) }
        guard !events.isEmpty else { return }
        for e in events { handleSessionEnd(e) }
        refresh()
    }

    /// Leave Done without restarting.
    public func dismissDone() {
        if apply(\.session, { $0.dismissDone() }) { refresh() }
    }

    private func handleSessionEnd(_ event: FocusSession.Event) {
        guard case .ended(let how, let focused) = event else { return }
        let now = clock.now
        totals = totalsStore.addFocused(focused, at: now)
        marker.remove()
        if how == .finished { chimes.sessionEnded() }
        switchOff()
    }

    // MARK: the eye clock

    public func setEyeEnabled(_ on: Bool) {
        guard !isShutDown else { return }
        prefs.eyeEnabled = on
        let now = clock.now
        if on { apply(\.eye) { $0.enable(now: now) } } else { handleEye(apply(\.eye) { $0.disable() }) }
        refresh()
    }

    public func skipBreak() {
        let now = clock.now
        handleEye(apply(\.eye) { $0.skip(now: now) }); refresh()
    }

    public func snoozeBreak() {
        let now = clock.now
        handleEye(apply(\.eye) { $0.snooze(now: now) }); refresh()
    }

    private func handleEye(_ events: [EyeBreakEvent]) {
        let now = clock.now
        for e in events {
            switch e {
            case .breakStarted:
                chimes.eyeBreakStarted(); panel.present()
            case .breakEnded(let outcome):
                panel.dismiss()
                switch outcome {
                case .completed: chimes.eyeBreakEnded(); totals = totalsStore.addBreak(taken: true, at: now)
                case .leftTheScreen: totals = totalsStore.addBreak(taken: true, at: now)
                case .skipped: totals = totalsStore.addBreak(taken: false, at: now)
                case .switchedOff: break
                }
            case .snoozed:
                panel.dismiss()
            case .clockRestarted:
                break
            }
        }
    }

    // MARK: the clock

    /// One step: the session may have run out, the eye clock may need a look at the person. Called by the ticker, and after every action.
    public func tick() {
        guard !isShutDown else { return }
        let now = clock.now
        face.set(now)
        for e in apply(\.session, { $0.tick(now: now) }) { handleSessionEnd(e) }
        if eye.isOn {
            let sample = presence.sample()
            handleEye(apply(\.eye) { $0.tick(now: now, presence: sample) })
        }
        updateTicker()
    }

    private func refresh() { tick() }

    /// Change a published value only when the change is real: `@Published` announces every mutating call, even one that changes nothing, and a tick every second
    /// must not make every view that observes the coordinator redraw.
    @discardableResult
    private func apply<T: Equatable, R>(_ path: ReferenceWritableKeyPath<FocusCoordinator, T>, _ body: (inout T) -> R) -> R {
        var v = self[keyPath: path]
        let r = body(&v)
        if v != self[keyPath: path] { self[keyPath: path] = v }
        return r
    }

    /// A view that shows a countdown asks for second-by-second ticks while it is on screen (the popover), and lets go when it goes.
    public func beginWatching() { watchers += 1; updateTicker() }
    public func endWatching() { watchers = max(0, watchers - 1); updateTicker() }

    private func updateTicker() {
        guard !isShutDown else { return }
        let want: TimeInterval?
        if session.isRunning || eye.isOnBreak || (watchers > 0 && eye.isOn) { want = 1 } else if eye.isOn { want = 5 } else { want = nil }
        guard want != tickEvery else { return }
        tickEvery = want
        if let s = want { ticker.start(every: s) { [weak self] in self?.tick() } } else { ticker.stop() }
    }

    // MARK: totals

    private func refreshTotals() { totals = totalsStore.today(at: clock.now) }

    /// Today's numbers including the focus time of the run that is on right now.
    public func dayTotal(at now: Date) -> FocusDayTotal {
        var t = totalsStore.today(at: now)
        if session.isActive { t.focusedSeconds += Int(session.focused(at: now).rounded()) }
        return t
    }

    // MARK: the marker file (decision F14)

    private func writeMarker() {
        guard session.isActive, let started = session.startedAt else { return }
        let m = FocusMarker(pid: pid, startedAt: Int(started.timeIntervalSince1970), endsAt: session.endsAt.map { Int($0.timeIntervalSince1970.rounded()) })
        markerWriteFailed = !marker.write(m)
    }

    // MARK: the macOS Focus

    private func enqueue(_ op: @escaping @MainActor () async -> Void) {
        let prev = chain
        chain = Task { @MainActor in
            await prev?.value
            await op()
        }
    }

    /// Wait until everything queued for the Focus has finished (tests, and `--ui-check`).
    public func settled() async {
        var seen: Task<Void, Never>?
        while let c = chain, c != seen { seen = c; await c.value }
    }

    private func switchOn() {
        link = .switchingOn
        prefs.focusMayBeOn = true
        enqueue { [self] in
            let before = status.authorization == .authorized ? status.isFocused() : nil
            let r = await focusSwitch.set(on: true)
            guard session.isActive else { return }      // the session ended while the shortcut ran; the Off that follows owns the state
            guard r.isDone else { link = .didNotSwitchOn(r.problem ?? "unknown"); return }
            let confirmed = await confirm(alreadyFocused: before == true)
            if session.isActive { link = confirmed }
        }
    }

    private func confirm(alreadyFocused: Bool) async -> FocusLink {
        var access = status.authorization
        if access == .notDetermined { access = await status.requestAuthorization() }
        statusAccess = access
        switch access {
        case .authorized: break
        case .notDetermined: return .onUnconfirmed("Conn has not asked macOS yet whether a Focus is on")
        case .denied, .restricted: return .onUnconfirmed("Focus Status is not allowed for Conn, so Conn cannot tell whether the Focus came on")
        }
        if alreadyFocused { return .onUnconfirmed("Another Focus was already on, so Conn cannot tell whether Conn Focus came on") }
        var waited: TimeInterval = 0
        var sawAnswer = false
        while true {
            if let f = status.isFocused() {
                sawAnswer = true
                if f { return .onConfirmed }
            }
            if waited >= confirmSeconds { break }
            await pause(confirmEvery)
            waited += confirmEvery
        }
        return sawAnswer ? .didNotSwitchOn("macOS does not show a Focus as on") : .onUnconfirmed("macOS did not say whether a Focus is on")
    }

    private func switchOff() {
        enqueue { [self] in
            let r = await focusSwitch.set(on: false)
            if r.isDone {
                prefs.focusMayBeOn = false
                if !session.isActive { link = .off }
            } else if !session.isActive {
                link = .couldNotSwitchOff(r.problem ?? "unknown")
            }
        }
    }

    /// "Try again" on the red warning: run the On shortcut again for the session that is running.
    public func retryFocus() {
        guard session.isActive, !isShutDown else { return }
        switchOn()
    }

    /// "Try again" on the red "may still be on" warning.
    public func retrySwitchOff() {
        guard !session.isActive, !isShutDown else { return }
        switchOff()
    }

    // MARK: setup

    /// Check Focus Setup: list the shortcuts (nothing is run) and see whether both names exist; also reads whether Focus Status is allowed.
    public func checkSetup() async {
        setupStatus = nil
        statusAccess = status.authorization
        setupStatus = await focusSwitch.checkSetup()
    }

    /// Ask macOS to let Conn read whether a Focus is on (shows its one-time prompt).
    public func requestFocusStatusAccess() async {
        statusAccess = await status.requestAuthorization()
    }

    public func dismissNotice() { notice = nil }
}
