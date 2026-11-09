// The real side of Conn Focus: the parts of `FocusCoordinator` that touch the Mac. Idle time and screen lock, the two chimes, the Focus Status check, the timer, and the
// floating eye-break panel. A person's own launch gets these; every scripted launch (`--ui-check`, `--fixture`, `--background`) gets the stand-ins from ConnCore instead
// (see `FocusRuntime.make`), so a check never plays a sound, runs `shortcuts`, changes a Focus or puts a panel on a screen.
import SwiftUI
import AppKit
import Intents
import ConnCore

// MARK: idle time and screen lock (decision F10)

/// Idle time from the HID system's own counter, and the screen lock and sleep from the system's notifications (plus the login session's lock flag).
/// None of these ask for a permission; they were read from a command-line probe on this Mac before this was written (see README "Focus sessions").
@MainActor
final class SystemPresence: PresenceReading {
    private var locked = false
    private var asleep = false
    private var left = false
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []

    init() {
        let ws = NSWorkspace.shared.notificationCenter
        let dc = DistributedNotificationCenter.default()
        func watch(_ center: NotificationCenter, _ name: Notification.Name, _ handler: @escaping @MainActor (SystemPresence) -> Void) {
            let t = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { if let s = self { handler(s) } }
            }
            tokens.append((center, t))
        }
        for n in [NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification] { watch(ws, n) { $0.asleep = true; $0.left = true } }
        for n in [NSWorkspace.screensDidWakeNotification, NSWorkspace.didWakeNotification] { watch(ws, n) { $0.asleep = false } }
        // Not public names, but present in macOS's loginwindow: if they ever stop firing, the idle rule and the session's lock flag still cover a lock.
        watch(dc, Notification.Name("com.apple.screenIsLocked")) { $0.locked = true; $0.left = true }
        watch(dc, Notification.Name("com.apple.screenIsUnlocked")) { $0.locked = false }
    }

    deinit { for (c, t) in tokens { c.removeObserver(t) } }

    func sample() -> PresenceSample {
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        var sessionLocked = false
        if let d = CGSessionCopyCurrentDictionary() as? [String: Any] {
            sessionLocked = (d["CGSSessionScreenIsLocked"] as? Bool) ?? ((d["CGSSessionScreenIsLocked"] as? Int) == 1)
        }
        defer { left = false }
        return PresenceSample(idleSeconds: max(0, idle), screenLocked: locked || sessionLocked, asleep: asleep, leftSinceLastSample: left || sessionLocked)
    }
}

// MARK: chimes (decision F19)

/// Glass at the end of a session, Submarine when an eye break starts and Hero when it ends: system sounds, no permission, and a Focus does not mute an app's own sound.
/// Tink (the first pick) was too short and quiet to notice. Submarine (1.5 s sonar ping) and Hero (1.1 s rising two-note, the loudest of the set) are not used by Herdr, Claude's hooks, the pmos notifier (those use Herdr's own Done and Request sounds, the spoken "Approval needed" and the default banner sound) or the session end, and they differ from each other: a ping to look away, a rise for back to it.
@MainActor
final class SystemChimes: FocusChiming {
    private var playing: NSSound?
    private func play(_ name: String) { playing = NSSound(named: NSSound.Name(name)); playing?.play() }
    func sessionEnded() { play("Glass") }
    func eyeBreakStarted() { play("Submarine") }
    func eyeBreakEnded() { play("Hero") }
}

// MARK: Focus Status (decision F21)

/// macOS's public "is a Focus on?" check. It answers yes or no for any Focus, never which one, and needs the person to allow it once (the system prompt, then
/// System Settings > Focus > Focus Status). Without `NSFocusStatusUsageDescription` in Info.plist the call would be refused, so a launch that has none (not from the
/// built bundle) reports `.restricted` and never calls it.
@MainActor
final class SystemFocusStatus: FocusStatusReading {
    private var hasUsageDescription: Bool { Bundle.main.object(forInfoDictionaryKey: "NSFocusStatusUsageDescription") != nil }

    private nonisolated static func map(_ s: INFocusStatusAuthorizationStatus) -> FocusAuthorization {
        switch s {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .restricted
        }
    }

    var authorization: FocusAuthorization {
        hasUsageDescription ? Self.map(INFocusStatusCenter.default.authorizationStatus) : .restricted
    }

    func requestAuthorization() async -> FocusAuthorization {
        guard hasUsageDescription else { return .restricted }
        return await withCheckedContinuation { c in
            INFocusStatusCenter.default.requestAuthorization { c.resume(returning: Self.map($0)) }
        }
    }

    func isFocused() -> Bool? {
        guard authorization == .authorized else { return nil }
        return INFocusStatusCenter.default.focusStatus.isFocused
    }
}

// MARK: the timer

/// A repeating main-thread timer in the common modes (it keeps firing while a menu is open). While it runs, Conn holds an activity so App Nap cannot coalesce it into
/// late ticks when Conn is covered by other apps: a chime that comes a minute late is a wrong timer. The activity allows the Mac to sleep.
@MainActor
final class TimerTicker: FocusTicking {
    private var timer: Timer?
    private var activity: NSObjectProtocol?

    func start(every seconds: TimeInterval, _ fire: @escaping @MainActor () -> Void) {
        timer?.invalidate()
        let t = Timer(timeInterval: seconds, repeats: true) { _ in MainActor.assumeIsolated { fire() } }
        t.tolerance = min(0.2, seconds * 0.1)
        RunLoop.main.add(t, forMode: .common)
        timer = t
        if activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Conn Focus: a focus session or the eye clock is running")
        }
    }

    func stop() {
        timer?.invalidate(); timer = nil
        if let a = activity { ProcessInfo.processInfo.endActivity(a); activity = nil }
    }
}

// MARK: the eye-break panel (decisions F9, F20, F22)

/// A panel that never becomes the key or main window, so it cannot take the keyboard from whatever the person is using.
final class EyePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// A hosting view that answers the first click: in a window that is never key, a button needs it to react to a first click.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Draws the eye-break panel: small, floating over every app and every Space (a full-screen app too), top centre of the display that has the mouse pointer, never taking
/// the keyboard. While Privacy mode is on it is hidden from screen capture and sharing (it still shows for the person).
///
/// A headless controller (every scripted launch) builds the same panel and records where it would go, but never orders it onto a screen.
@MainActor
final class EyeBreakPanelController: EyePanelPresenting {
    let headless: Bool
    private(set) var panel: EyePanel?
    /// The frame the panel was last placed at (checked by `--ui-check`; for a headless controller this is where it would have shown).
    private(set) var lastFrame: CGRect?
    private(set) var presentedCount = 0
    /// A break is on the panel (true from `present` until the break ends, however it ends).
    private(set) var isShowing = false
    /// The panel is still up after a completed break, saying "Good. Back to it." for a moment.
    private(set) var isLingering = false
    private weak var focus: FocusCoordinator?
    private var privacyTokens: [Any] = []
    private var closeWork: DispatchWorkItem?

    init(headless: Bool) { self.headless = headless }

    func attach(_ focus: FocusCoordinator) {
        self.focus = focus
        let c = focus.$privacyActive.sink { [weak self] on in self?.applyPrivacy(on) }
        privacyTokens.append(c)
    }

    /// The window with the properties the decisions need; created once, kept for later breaks.
    private func makePanel() -> EyePanel {
        if let p = panel { return p }
        let p = EyePanel(contentRect: NSRect(origin: .zero, size: EyePanelPlacement.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isFloatingPanel = true
        p.becomesKeyOnlyIfNeeded = true
        p.hidesOnDeactivate = false
        p.level = .statusBar                    // above floating windows (3) and the menu bar (24)
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .canJoinAllApplications, .ignoresCycle, .stationary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isReleasedWhenClosed = false
        p.animationBehavior = .none
        p.sharingType = (focus?.privacyActive ?? false) ? .none : .readOnly
        if let f = focus { p.contentView = FirstMouseHostingView(rootView: EyeBreakView(focus: f, face: f.face)) }
        panel = p
        return p
    }

    private func applyPrivacy(_ on: Bool) { panel?.sharingType = on ? .none : .readOnly }

    /// Top centre of the display that has the pointer.
    func placement() -> CGRect {
        let screens = NSScreen.screens
        let frames = screens.map(\.frame)
        guard let i = EyePanelPlacement.screenIndex(containing: NSEvent.mouseLocation, frames: frames) else {
            return CGRect(origin: .zero, size: EyePanelPlacement.size)
        }
        return EyePanelPlacement.frame(visibleFrame: screens[i].visibleFrame)
    }

    func present() {
        closeWork?.cancel()
        let p = makePanel()
        let f = placement()
        lastFrame = f
        p.setFrame(f, display: false)
        presentedCount += 1
        isShowing = true; isLingering = false
        if !headless { p.orderFrontRegardless() }          // never makeKey, never activate the app
    }

    func completed() {
        // The panel says it is over for a moment, then goes.
        closeWork?.cancel()
        isShowing = false; isLingering = true
        let w = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.dismiss() } }
        closeWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: w)
    }

    func dismiss() {
        closeWork?.cancel()
        isShowing = false; isLingering = false
        panel?.orderOut(nil)
    }
}

// MARK: assembling it

/// The stand-ins a scripted launch runs on, kept so `--ui-check` can drive them and read what they were asked.
@MainActor
final class FocusStandInSet {
    let clock: ManualFocusClock?
    let focusSwitch: ScriptedFocusSwitch
    let status: ScriptedFocusStatus
    let chimes: SilentChimes
    let presence: ScriptedPresence
    let ticker: ManualTicker?
    let markerDirectory: URL
    init(clock: ManualFocusClock?, focusSwitch: ScriptedFocusSwitch, status: ScriptedFocusStatus, chimes: SilentChimes, presence: ScriptedPresence, ticker: ManualTicker?, markerDirectory: URL) {
        self.clock = clock; self.focusSwitch = focusSwitch; self.status = status; self.chimes = chimes; self.presence = presence; self.ticker = ticker; self.markerDirectory = markerDirectory
    }
}

@MainActor
enum FocusRuntime {
    /// The coordinator for this launch. A person's own launch gets the real Mac (the system clock, `shortcuts`, macOS's Focus Status, system sounds, the idle and lock readers,
    /// the floating panel, `~/Library/Application Support/Conn`). A scripted launch gets stand-ins (no sound, no `shortcuts run`, no Focus change, a panel that is never
    /// ordered onto a screen, its own temporary marker folder and the test preferences), and a hand-moved clock when it is a check.
    static func make(config: AppConfig) -> (coordinator: FocusCoordinator, panel: EyeBreakPanelController, standIns: FocusStandInSet?) {
        var eyeConfig = EyeBreakConfig()
        if config.isScriptedLaunch, let s = ProcessInfo.processInfo.environment["CONN_FOCUS_EYE_INTERVAL"].flatMap(Double.init), s >= 5 { eyeConfig.intervalSeconds = s }
        if !config.isScriptedLaunch {
            let panel = EyeBreakPanelController(headless: false)
            let c = FocusCoordinator(clock: SystemFocusClock(), focusSwitch: ShortcutRunner(), status: SystemFocusStatus(), chimes: SystemChimes(), panel: panel,
                                     presence: SystemPresence(), ticker: TimerTicker(), marker: FocusMarkerFile(directory: FocusMarker.defaultDirectory()),
                                     totals: FocusTotalsStore(defaults: AppModel.defaults), prefs: FocusPrefs(defaults: AppModel.defaults), eyeConfig: eyeConfig)
            panel.attach(c)
            return (c, panel, nil)
        }
        let isCheck = config.uiTour || config.focusCheck
        let testDefaults = UserDefaults(suiteName: "dev.local.conn.test") ?? .standard
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("conn-focus-\(getpid())", isDirectory: true)
        let clock = isCheck ? ManualFocusClock() : nil
        let sw = ScriptedFocusSwitch()
        let status = ScriptedFocusStatus()
        status.switchState = { [sw] in sw.focusIsOn }
        let chimes = SilentChimes()
        let presence = ScriptedPresence()
        let ticker: FocusTicking = isCheck ? ManualTicker() : TimerTicker()
        let panel = EyeBreakPanelController(headless: !(config.focusShowPanel && !config.runsInBackground))
        let coordinator = FocusCoordinator(clock: clock ?? SystemFocusClock(), focusSwitch: sw, status: status, chimes: chimes, panel: panel, presence: presence, ticker: ticker,
                                           marker: FocusMarkerFile(directory: dir), totals: FocusTotalsStore(defaults: testDefaults), prefs: FocusPrefs(defaults: testDefaults),
                                           eyeConfig: eyeConfig)
        panel.attach(coordinator)
        return (coordinator, panel, FocusStandInSet(clock: clock, focusSwitch: sw, status: status, chimes: chimes, presence: presence, ticker: ticker as? ManualTicker, markerDirectory: dir))
    }
}
