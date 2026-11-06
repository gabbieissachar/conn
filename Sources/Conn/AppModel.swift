// App-wide state: the Herdr store, the two pane slots, selection, compose, web panes, editor, and the footprint line.
import SwiftUI
import Combine
import Darwin
import ConnCore
import ConnTerminal

/// Which of the two pane columns: the selected agent's, or the comparison pane's.
enum PaneSlot { case primary, secondary }

/// A pane's history shown in place of its live view: the text `pane.read` (source recent) returns, as a snapshot.
/// A live stream pane has no scrollback, because Herdr's frames never scroll (see ScrollbackTests), so this is how earlier
/// output is reached.
@MainActor
final class PaneHistory: ObservableObject, Identifiable {
    enum Phase: Equatable { case loading, ready(String), failed(String) }
    let id = UUID()
    let paneID: String
    let agentName: String
    @Published var phase: Phase = .loading
    @Published var loadedAt: Date?
    init(paneID: String, agentName: String) { self.paneID = paneID; self.agentName = agentName }
    var text: String? { if case .ready(let t) = phase { return t } else { return nil } }
}

struct HeldMessage: Equatable {
    enum Phase: Equatable { case held, sending, undone, sent, failed(String) }
    var text: String
    var agentName: String
    var paneID: String
    var secondsLeft: Int
    var phase: Phase
}

@MainActor
final class AppModel: ObservableObject {
    let config: AppConfig
    let endpoint: HerdrEndpoint
    let store: HerdrStore
    let primary: PaneSession
    let secondary: PaneSession
    let web: WebHub
    /// The Reader pane's starred sessions (read from the reader's own star list; only their order is Conn's).
    let stars: StarredSessions
    let editor: EditorModel
    let fallback: FallbackTerminalController
    let renderer: RendererKind
    @Published private(set) var client: HerdrClient

    @Published var selectedPaneID: String?
    @Published var comparePaneID: String?
    @Published var selectedWorkspaceID: String?
    @Published var mode: CenterMode = .agent { didSet { if mode != oldValue { syncSessions() } } }
    @Published var showWeb = true {
        didSet { if showWeb && !oldValue && webTab == .organizer { web.box(.organizer).showContextView() } }
    }
    @Published var sidebarVisible = true
    @Published var webWidth: CGFloat = 480
    /// The Organizer pane opens on its Context view every time it is switched to (and when its page loads: see WebBox).
    @Published var webTab: WebKind = .reader {
        didSet { if webTab == .organizer && oldValue != .organizer { web.box(.organizer).showContextView() } }
    }
    @Published var readerFollows = true
    /// Privacy mode hides content for screen sharing; anything that shows pane history closes with it.
    /// Text size of the live panes as a factor of the size that fits (Cmd+= / Cmd+- / Cmd+0); remembered across launches.
    @Published private(set) var paneZoom: Double = AppModel.savedZoom()
    private static let zoomKey = "conn.paneZoom"
    /// Preferences live in the standard domain, except in test mode: a check that zooms must not overwrite the zoom a person saved.
    static var defaults: UserDefaults { Runtime.config.runsInBackground ? (UserDefaults(suiteName: "dev.local.conn.test") ?? .standard) : .standard }
    private static func savedZoom() -> Double { PaneFit.clampedZoom(defaults.object(forKey: zoomKey) as? Double ?? 1) }
    /// The Herdr client pane starts Herdr's client with Herdr's own sidebar hidden (Conn draws the sidebar); remembered across
    /// launches, and read when the client attaches, not while it runs.
    @Published var hideHerdrSidebar: Bool = AppModel.defaults.object(forKey: AppModel.hideHerdrSidebarKey) as? Bool ?? true {
        didSet { Self.defaults.set(hideHerdrSidebar, forKey: Self.hideHerdrSidebarKey) }
    }
    private static let hideHerdrSidebarKey = "conn.herdrClient.hideSidebar"
    /// Why the Herdr client did not attach (its config failed the check), shown in the pane; nil otherwise.
    @Published private(set) var herdrClientError: String?
    /// The keys the sidebar types into the running Herdr client, read from the config it started with; nil with a reason in
    /// `herdrKeymapProblem` when that config binds a key Conn cannot type.
    private var herdrKeymap: HerdrClientKeymap?
    private var herdrKeymapProblem: String?
    /// True while a sidebar click is moving the Herdr client.
    @Published private(set) var herdrNavigating = false
    private var herdrNavTask: Task<Void, Never>?
    private var herdrNavEndedAt: Date?
    /// The highlight before the first click of a run of clicks, which a failed move goes back to.
    private var herdrHighlightBeforeNav: (workspace: String?, pane: String?)?
    /// Decides when the sidebar follows Herdr's focus pointer while the client runs.
    private var clientFocus = HerdrClientFocusFollower()
    @Published var privacy = false { didSet { if privacy { primaryHistory = nil; secondaryHistory = nil } } }
    @Published var showSwitcher = false
    @Published var switcherQuery = ""
    @Published var compose = ""
    @Published var held: HeldMessage?
    /// The history view that replaces a pane's live view while it is on; the stream keeps running underneath.
    @Published var primaryHistory: PaneHistory?
    @Published var secondaryHistory: PaneHistory?
    /// nil follows the system. Applied to the whole app: SwiftUI's preferredColorScheme closes the window when it
    /// changes at runtime, NSApp.appearance does not.
    @Published var appearance: ColorScheme? = nil {
        didSet { NSApp.appearance = appearance.map { NSAppearance(named: $0 == .dark ? .darkAqua : .aqua) } ?? nil }
    }
    @Published var statsLine = ""
    @Published var toastText: String?
    @Published private(set) var streamVerdict: StreamVerdict = .ok
    @Published private(set) var windowVisible = true
    /// False once the app has been in the background for `inactivePauseSeconds`: streams stop, the sidebar keeps running.
    @Published private(set) var attentive = true
    private var inactiveTimer: Timer?
    var inactivePauseSeconds: TimeInterval = ProcessInfo.processInfo.environment["CONN_INACTIVE_PAUSE"].flatMap(Double.init) ?? 30
    @Published var confirmWrites = false

    private var cancellables = Set<AnyCancellable>()
    private var recents: [String] = []
    private var pinWork: DispatchWorkItem?
    private var heldTimer: Timer?
    private var statsTimer: Timer?
    private var cpu = CPUSampler()
    private var lastCPUPercent = 0.0
    private var wasLive = false
    private var probing = false
    private let holdSeconds: Int

    init(config: AppConfig) {
        // A crash or kill -9 of an earlier run can leave observer children behind; end the ones that are provably ours
        // and whose owning instance is gone (another running instance's children are left alone). It can wait up to a
        // second for a child that ignores SIGTERM, so it runs off the main thread; this instance's own children are
        // never its target (their owner is alive).
        DispatchQueue.global(qos: .utility).async { ObserverRegistry.shared.reapOrphans() }
        self.config = config
        let endpoint = config.endpoint
        self.endpoint = endpoint
        holdSeconds = config.holdSeconds
        renderer = config.renderer
        client = HerdrClient(endpoint: endpoint, writePolicy: config.writePolicy)
        store = HerdrStore(client: HerdrClient(endpoint: endpoint))
        func engine() -> TerminalEngine { config.renderer == .swiftTerm ? SwiftTermEngine() : GridEngine() }
        primary = PaneSession(engine: engine(), source: ObserveProcessSource(endpoint: endpoint))
        secondary = PaneSession(engine: engine(), source: ObserveProcessSource(endpoint: endpoint))
        let res = Bundle.main.resourceURL
        web = WebHub(fixture: config.fixture, resourceDir: res?.appendingPathComponent("fixture"))
        let env = ProcessInfo.processInfo.environment
        let fixtureDir = res?.appendingPathComponent("fixture")
        // A fixture launch reads invented stars (never the owner's file) and keeps its order apart from the real one.
        let starsFile = config.fixture ? URL(fileURLWithPath: env["CONN_READER_STARS"] ?? fixtureDir?.appendingPathComponent("fixture-stars.json").path ?? "/nonexistent") : ReaderStars.defaultFile(env: env)
        let labelsFile = config.fixture ? URL(fileURLWithPath: env["CONN_READER_LABELS"] ?? fixtureDir?.appendingPathComponent("fixture-pane-labels.json").path ?? "/nonexistent") : StarLabels.defaultFile(env: env)
        stars = StarredSessions(starsFile: starsFile, labelsFile: labelsFile,
                                store: StarOrderStore(defaults: AppModel.defaults, key: config.fixture ? "conn.readerStarOrder.fixture" : "conn.readerStarOrder"))
        stars.start()
        editor = EditorModel()
        fallback = FallbackTerminalController()
        // A link in one web pane that points at the other switches to it and shows that exact address.
        web.onShowPane = { [weak self] kind, url in
            guard let self = self else { return }
            self.showWeb = true
            self.webTab = kind
            self.web.box(kind).show(address: url)
        }
        showWeb = config.showWeb ?? true
        for p in [primary, secondary] {
            p.onProtocolMismatch = { [weak self] in self?.streamRefused() }
            p.onStreamFailedBeforeFrames = { [weak self] _ in self?.probeCompatibility() }
        }
        store.objectWillChange.sink { [weak self] _ in
            // snapshot changes arrive on the main queue; react after the new value is stored
            self?.objectWillChange.send()
            DispatchQueue.main.async { self?.snapshotChanged() }
        }.store(in: &cancellables)
        store.$link.removeDuplicates().sink { [weak self] link in DispatchQueue.main.async { self?.linkChanged(link) } }.store(in: &cancellables)
        store.start()
        if config.textPanes { applyVerdict(.ok) }   // starts on the text path before the first pane opens
        probeCompatibility()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.updateStats() } }
        NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.appResigned() }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.appBecameActive() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.wokeFromSleep() }
        }
        DispatchQueue.main.async { self.snapshotChanged() }
    }

    var snapshot: Snapshot { store.snapshot }
    var selectedAgent: Agent? { snapshot.agent(selectedPaneID) }
    var compareAgent: Agent? { snapshot.agent(comparePaneID) }
    var waiting: [Agent] { snapshot.prioritized.filter { $0.state.waitsOnCaptain } }
    var writesEnabled: Bool { client.writePolicy.allowsWrites(to: endpoint.session) }
    var themeIsDark: Bool { (appearance ?? (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .dark : .light)) == .dark }
    var terminalTheme: TerminalTheme { themeIsDark ? .dark : .light }

    // MARK: Herdr link and compatibility

    private func linkChanged(_ link: HerdrStore.Link) {
        let live = link == .live
        if live && !wasLive {
            // Herdr is reachable (again): re-check the protocol, and bring pane streams back without waiting out their backoff.
            probeCompatibility()
            primary.restartIfNotLive(); secondary.restartIfNotLive()
        }
        wasLive = live
    }

    func probeCompatibility() {
        guard !probing else { return }
        probing = true
        let ep = endpoint
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let status = HerdrCompatibility.probe(endpoint: ep)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.probing = false
                // No answer is not a protocol problem: say what is missing instead of blaming the stream.
                let verdict = status.map { HerdrCompatibility.verdict(for: $0) }
                    ?? (ep.binaryPath == nil ? .textOnly("The herdr command was not found; panes show text") : .down("The herdr command did not answer; is the Herdr server running?"))
                self.applyVerdict(verdict)
            }
        }
    }

    private func applyVerdict(_ v: StreamVerdict) {
        // `--text-panes` pins the text path whatever the status check says.
        let v: StreamVerdict = config.textPanes ? .textOnly("requested with --text-panes") : v
        let changedKind = v.allowsStream != streamVerdict.allowsStream
        streamVerdict = v
        if changedKind {
            for p in [primary, secondary] { p.replaceSource(makeSource()) }
        }
    }

    private func makeSource() -> PaneStreamSource {
        streamVerdict.allowsStream ? ObserveProcessSource(endpoint: endpoint) : PaneReadSource(client: HerdrClient(endpoint: endpoint), interval: 1)
    }

    /// The observer command said the protocol is refused although the status check allowed it: fall back to text panes.
    private func streamRefused() {
        guard streamVerdict.allowsStream else { return }
        applyVerdict(.textOnly("Herdr refused the pane stream (protocol mismatch); panes show text until the server and client match"))
    }

    private func wokeFromSleep() {
        store.reconnectNow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.probeCompatibility()
            self?.primary.restartIfNotLive(); self?.secondary.restartIfNotLive()
        }
    }

    /// The Herdr server pays for every observed working pane (about 3 to 8 points of a core each), so panes nobody is
    /// looking at do not stream: after 30 s in the background they stop, and they restart (one full frame, about 80 ms) on return.
    func appResigned() {
        inactiveTimer?.invalidate()
        inactiveTimer = Timer.scheduledTimer(withTimeInterval: inactivePauseSeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { guard let self = self else { return }; self.attentive = false; self.syncSessions() }
        }
    }

    func appBecameActive() {
        inactiveTimer?.invalidate()
        if !attentive { attentive = true; syncSessions() }
    }

    func setWindowVisible(_ v: Bool) {
        guard v != windowVisible else { return }
        windowVisible = v
        syncSessions()
    }

    // MARK: selection

    private func snapshotChanged() {
        let s = snapshot
        if selectedPaneID == nil || s.agent(selectedPaneID) == nil {
            if let f = s.agent(s.focusedPaneID) ?? s.prioritized.first { select(f.id) }
        }
        if let c = comparePaneID, s.agent(c) == nil { comparePaneID = nil }
        syncSessions()
        followHerdrClientFocus()
        let n = waiting.count
        NSApplication.shared.dockTile.badgeLabel = n > 0 ? "\(n)" : ""
    }

    /// Streams run only for panes that are on screen: the window is visible and the Agent view is showing.
    /// The size is the pane's own (an observer cannot resize it), so the app asks Herdr for exactly that.
    private func syncSessions() {
        let active = windowVisible && attentive && mode == .agent
        primary.configure(pane: active ? selectedPaneID : nil, size: snapshot.paneSizes[selectedPaneID ?? ""])
        secondary.configure(pane: active ? comparePaneID : nil, size: snapshot.paneSizes[comparePaneID ?? ""])
        // A history belongs to the pane it was opened for: another agent in the column shows live again.
        if let h = primaryHistory, h.paneID != selectedPaneID { primaryHistory = nil }
        if let h = secondaryHistory, h.paneID != comparePaneID { secondaryHistory = nil }
    }

    func select(_ paneID: String, pin: Bool = true) {
        guard let a = snapshot.agent(paneID) else { return }
        if paneID == comparePaneID { comparePaneID = selectedPaneID }
        if let cur = selectedPaneID, cur != paneID { recents.removeAll { $0 == cur }; recents.insert(cur, at: 0) }
        selectedPaneID = paneID
        selectedWorkspaceID = a.workspaceID
        if mode != .agent { mode = .agent }
        syncSessions()
        if pin { pinReader() }
    }

    func selectTab(_ tab: HerdrTab) { if let a = snapshot.agent(inTab: tab.id) { select(a.id) } }

    func selectWorkspace(_ id: String) {
        selectedWorkspaceID = id
        if let a = snapshot.agents(in: id).first(where: { $0.id == selectedPaneID }) ?? snapshot.agents(in: id).first { select(a.id) }
    }

    func selectNth(_ i: Int) { let list = snapshot.prioritized; if i < list.count { select(list[i].id) } }

    func cycle(_ delta: Int) {
        if let a = snapshot.agent(after: selectedPaneID, offset: delta) { select(a.id) }
    }

    func jumpToWaiting() {
        guard let a = snapshot.nextWaiting(after: selectedPaneID) else { toast("Nothing is waiting on you"); return }
        select(a.id)
    }

    func toggleCompare() {
        if comparePaneID != nil { comparePaneID = nil; syncSessions(); return }
        let other = recents.first { snapshot.agent($0) != nil && $0 != selectedPaneID }
            ?? snapshot.prioritized.first { $0.id != selectedPaneID }?.id
        comparePaneID = other
        syncSessions()
    }

    var readerVisible: Bool { showWeb && webTab == .reader }

    /// "Open the reader pinned to the selected pane": debounced, because every pin is a page load.
    func pinReader() {
        pinWork?.cancel()
        guard readerFollows, readerVisible, let a = selectedAgent else { return }
        let w = DispatchWorkItem { [weak self] in self?.web.box(.reader).pin(sessionID: a.sessionID) }
        pinWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: w)
    }

    /// The Reader pane's row of starred sessions: open this conversation in the reader (the pin path an agent selection uses,
    /// so the reader loads it with its `#s=` address). The one on screen is left alone: opening it again would reload the page.
    func openStarred(_ conv: String) {
        guard !StarSelection.matches(conv: conv, shown: web.box(.reader).shownSession) else { return }
        if webTab != .reader { webTab = .reader }
        web.box(.reader).pin(sessionID: conv)
    }

    /// Names of the agents by session id, for the starred sessions an agent runs now.
    var agentNamesBySession: [String: String] {
        Dictionary(snapshot.agents.compactMap { a in a.sessionID.map { ($0, a.name) } }, uniquingKeysWith: { first, _ in first })
    }

    func reloadWeb() { web.allBoxes.forEach { $0.reload() } }

    // MARK: history view (the toggle that stands in for scrollback)

    func history(for slot: PaneSlot) -> PaneHistory? { slot == .primary ? primaryHistory : secondaryHistory }

    private func paneID(for slot: PaneSlot) -> String? { slot == .primary ? selectedPaneID : comparePaneID }

    /// Swap the live pane for its history, or back. The stream keeps running underneath, so going back is instant.
    func toggleHistory(_ slot: PaneSlot = .primary) {
        if history(for: slot) != nil { closeHistory(slot) } else { openHistory(slot) }
    }

    func openHistory(_ slot: PaneSlot = .primary) {
        guard !privacy, mode == .agent, history(for: slot) == nil, let id = paneID(for: slot), let a = snapshot.agent(id) else { return }
        let h = PaneHistory(paneID: id, agentName: a.name)
        if slot == .primary { primaryHistory = h } else { secondaryHistory = h }
        loadHistory(h)
    }

    func closeHistory(_ slot: PaneSlot = .primary) {
        if slot == .primary { primaryHistory = nil } else { secondaryHistory = nil }
        // Back to live: SwiftTerm draws from a display-link tick, so ask for the draw now instead of waiting for one.
        (( slot == .primary ? primary : secondary).engine as? SwiftTermEngine)?.view.nudgeDisplay()
    }

    func refreshHistory(_ slot: PaneSlot = .primary) {
        guard let h = history(for: slot) else { return }
        h.phase = .loading
        loadHistory(h)
    }

    /// `pane.read` with source recent, plain text, the newest 3000 lines (scrollback plus the screen). Read-only.
    private func loadHistory(_ h: PaneHistory) {
        let c = HerdrClient(endpoint: endpoint)
        let pane = h.paneID
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak h] in
            let r: Result<String, Error> = Result { try c.readPane(pane, source: .recent, ansi: false, lines: 3000) }
            DispatchQueue.main.async {
                guard let self = self, let h = h, !self.privacy, self.primaryHistory === h || self.secondaryHistory === h else { return }
                switch r {
                case .success(let t): h.phase = .ready(t); h.loadedAt = Date()
                case .failure(let e): h.phase = .failed("\(e)")
                }
            }
        }
    }

    // MARK: compose: the one write path

    var composeText: String { compose.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Why the text in the box cannot be sent, if it cannot (shown under the box).
    var composeProblem: String? { composeText.isEmpty ? nil : ComposePolicy.problem(for: composeText) }

    /// Moves the text into a short undo window, then delivers it with `pane.send_input` (text, then Enter).
    func send() {
        guard writesEnabled else { toast("Writes to \(endpoint.session) are off"); return }
        let text = composeText
        if let why = ComposePolicy.problem(for: text) { if !text.isEmpty { toast(why) }; return }
        guard let a = selectedAgent else { return }
        compose = ""
        let h = HeldMessage(text: text, agentName: a.name, paneID: a.id, secondsLeft: holdSeconds, phase: .held)
        heldTimer?.invalidate()
        if holdSeconds <= 0 { held = h; deliver(h); return }
        held = h
        heldTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self = self, var h = self.held, h.phase == .held else { t.invalidate(); return }
                h.secondsLeft -= 1
                self.held = h
                if h.secondsLeft <= 0 { t.invalidate(); self.deliver(h) }
            }
        }
    }

    func undoHeld() {
        guard var h = held, h.phase == .held else { return }
        heldTimer?.invalidate()
        compose = h.text
        h.phase = .undone
        held = h
        clearHeld(after: 2)
    }

    private func deliver(_ h: HeldMessage) {
        var m = h
        m.phase = .sending
        held = m
        let c = client
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result: Result<Void, Error> = Result { try c.sendInput(pane: h.paneID, text: h.text, keys: ["Enter"]) }
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch result {
                case .success:
                    m.phase = .sent
                    self.held = m
                    self.clearHeld(after: 2.5)
                case .failure(let e):
                    // Nothing is lost: the text goes back into the box.
                    if self.compose.isEmpty { self.compose = h.text }
                    m.phase = .failed("\(e)")
                    self.held = m
                    self.clearHeld(after: 8)
                }
            }
        }
    }

    private func clearHeld(after s: Double) {
        let snapshot = held
        DispatchQueue.main.asyncAfter(deadline: .now() + s) { [weak self] in if self?.held == snapshot { self?.held = nil } }
    }

    /// Turn writes on for this session. Only the user's explicit confirmation reaches here.
    func enableWrites() {
        var policy = client.writePolicy
        policy.writableSessions.insert(endpoint.session)
        client = HerdrClient(endpoint: endpoint, writePolicy: policy)
        toast("Sending to \(endpoint.session) is on")
    }

    func disableWrites() {
        var policy = client.writePolicy
        policy.writableSessions.remove(endpoint.session)
        client = HerdrClient(endpoint: endpoint, writePolicy: policy)
    }

    // MARK: pane text size

    func zoomPane(_ direction: Int) { setPaneZoom(PaneFit.stepZoom(paneZoom, direction: direction)) }
    func resetPaneZoom() { setPaneZoom(1) }

    func setPaneZoom(_ z: Double, remember: Bool = true) {
        let z = PaneFit.clampedZoom(z)
        guard z != paneZoom else { return }
        paneZoom = z
        if remember { Self.defaults.set(z, forKey: Self.zoomKey) }
        toast(z == 1 ? "Text fits the pane" : "Text \(Int((z * 100).rounded()))% of the fit")
    }

    func toast(_ s: String) {
        toastText = s
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in if self?.toastText == s { self?.toastText = nil } }
    }

    // MARK: footprint line shown in the status bar

    func updateStats() {
        var pids: [(String, pid_t)] = [("app", getpid())]
        if let p = primary.processID { pids.append(("pane", p)) }
        if let p = secondary.processID { pids.append(("pane", p)) }
        for b in web.allBoxes { if let p = b.pid { pids.append(("web", p)) } }
        var parts: [String: UInt64] = [:]
        for (label, pid) in pids { if let u = ProcessUsage.read(pid) { parts[label, default: 0] += u.footprint } }
        let c = cpu.sample(pids: pids.map { $0.1 }, minWindow: 2)
        if c > 0 || lastCPUPercent == 0 { lastCPUPercent = c }
        func mb(_ v: UInt64?) -> String { String(format: "%.0f MB", Double(v ?? 0) / ProcessUsage.mebibyte) }
        var line = "app \(mb(parts["app"]))"
        if let p = parts["pane"] { line += " · pane streams \(mb(p))" }
        if let w = parts["web"] { line += " · web content \(mb(w))" }
        line += String(format: " · CPU %.1f%%", lastCPUPercent)
        statsLine = line
    }

    /// Start the Herdr client pane. Its config is checked first (`HerdrClientConfig.resolve`); a config that fails the check
    /// stops the attach and says why, rather than starting a client that would read some other file.
    func attachHerdrClient() {
        do {
            let clientConfig = try HerdrClientConfig.resolve(hideSidebar: hideHerdrSidebar, custom: config.clientConfigPath)
            herdrClientError = nil
            do { herdrKeymap = try HerdrClientKeymap.load(configPath: clientConfig); herdrKeymapProblem = nil }
            catch { herdrKeymap = nil; herdrKeymapProblem = "\(error)" }
            fallback.start(endpoint: endpoint, theme: terminalTheme, clientConfig: clientConfig)
            // A new client opens on the workspace and tab Herdr last focused: show that in the sidebar.
            clientFocus.reset()
            followHerdrClientFocus(adopt: true)
        } catch {
            herdrClientError = "\(error)"
        }
    }

    // MARK: Herdr client navigation

    /// True while the Herdr client view is showing and its client is running: the sidebar then moves that client instead of
    /// switching to the Agent view.
    var herdrClientDriving: Bool { mode == .herdr && fallback.running }

    /// A click on a space in the sidebar.
    func sidebarOpenWorkspace(_ id: String) {
        guard herdrClientDriving else { selectWorkspace(id); return }
        moveHerdrClient(to: .workspace(id), label: snapshot.workspace(id)?.label ?? id, workspace: id, pane: nil)
    }

    /// A click on an agent in the sidebar: its tab.
    func sidebarOpenAgent(_ a: Agent) {
        guard herdrClientDriving else { select(a.id); return }
        moveHerdrClient(to: .tab(a.tabID), label: a.name, workspace: a.workspaceID, pane: a.id)
    }

    /// Type the keys that move the embedded client to `target` and confirm it got there. Only the embedded client moves: the
    /// keys go to its pty, and Herdr's session-wide focus commands are never called. The highlight moves at once and goes back
    /// if the client did not confirm.
    private func moveHerdrClient(to target: HerdrClientNavigation.Target, label: String, workspace: String, pane: String?) {
        guard let keymap = herdrKeymap else { toast(herdrKeymapProblem ?? "The Herdr client has not started."); return }
        let stages: [HerdrClientNavigation.Stage]
        do { stages = try HerdrClientNavigation.plan(to: target, in: snapshot, keymap: keymap) } catch { toast("\(error)"); return }
        if !herdrNavigating { herdrHighlightBeforeNav = (selectedWorkspaceID, selectedPaneID) }
        let shownLabel = privacy ? "that item" : label
        selectedWorkspaceID = workspace
        if let p = pane { selectedPaneID = p }
        let fb = fallback
        let reader = HerdrClient(endpoint: endpoint)
        let readFocus: @Sendable () async -> HerdrClientNavigator.Focus? = {
            await Task.detached { (try? reader.snapshot()).map { HerdrClientNavigator.Focus(workspaceID: $0.focusedWorkspaceID, tabID: $0.focusedTabID) } }.value
        }
        let navigator = HerdrClientNavigator(send: { bytes in await MainActor.run { _ = fb.sendNavigation(bytes) } }, readFocus: readFocus)
        // The latest click wins, but a stage already typed finishes first, so two sequences never interleave in the pty.
        let previous = herdrNavTask
        previous?.cancel()
        herdrNavigating = true
        let task = Task { [weak self] in
            await previous?.value
            let outcome = await navigator.run(stages)
            guard let self = self, !Task.isCancelled else { return }
            self.herdrNavigating = false
            self.herdrNavEndedAt = Date()
            if outcome == .landed, pane == nil, let tab = await readFocus()?.tabID, let a = self.snapshot.agent(inTab: tab), a.workspaceID == workspace {
                self.selectedPaneID = a.id    // a space opens on its own current tab: highlight that tab's agent
            }
            if case .failed(_, _, let reason) = outcome {
                if let before = self.herdrHighlightBeforeNav {
                    if self.selectedWorkspaceID == workspace { self.selectedWorkspaceID = before.workspace }
                    if let p = pane, self.selectedPaneID == p { self.selectedPaneID = before.pane }
                }
                self.toast("The Herdr client did not switch to \(shownLabel). \(reason).")
            }
        }
        herdrNavTask = task
    }

    /// Keep the sidebar in step with the client. Herdr reports one focus pointer for the whole session (the workspace and tab
    /// last selected by any attached client), not a position per client, so the sidebar follows a change only when the person
    /// just typed or clicked in the embedded client, or when the client has just attached. A change made on another screen
    /// while they are not using this client is left alone.
    private func followHerdrClientFocus(adopt: Bool = false) {
        guard herdrClientDriving else { return }
        let settled = !herdrNavigating && (herdrNavEndedAt.map { Date().timeIntervalSince($0) > 1.5 } ?? true)
        guard let at = clientFocus.observe(workspace: snapshot.focusedWorkspaceID, tab: snapshot.focusedTabID, adopt: adopt,
                                           settled: settled, userActive: fallback.hadUserInput(within: 2)) else { return }
        selectedWorkspaceID = at.workspace
        if let a = snapshot.agent(inTab: at.tab) { selectedPaneID = a.id }
    }

    func shutdown() {
        store.stop(); primary.stop(); secondary.stop(); fallback.stop()
    }
}
