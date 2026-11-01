// App-wide state: the Herdr store, the two pane slots, selection, compose, web panes, editor, and the footprint line.
import SwiftUI
import Combine
import Darwin
import HelmCore
import HelmTerminal

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
    let editor: EditorModel
    let fallback: FallbackTerminalController
    let renderer: RendererKind
    @Published private(set) var client: HerdrClient

    @Published var selectedPaneID: String?
    @Published var comparePaneID: String?
    @Published var selectedWorkspaceID: String?
    @Published var mode: CenterMode = .agent { didSet { if mode != oldValue { syncSessions() } } }
    @Published var showWeb = true
    @Published var sidebarVisible = true
    @Published var webWidth: CGFloat = 480
    @Published var webTab: WebKind = .reader
    @Published var readerFollows = true
    @Published var privacy = false
    @Published var showSwitcher = false
    @Published var switcherQuery = ""
    @Published var compose = ""
    @Published var held: HeldMessage?
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
    let inactivePauseSeconds: TimeInterval = 30
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
        // A crash or kill -9 of an earlier run can leave observer children behind; end the ones that are provably ours.
        ObserverRegistry.reapOrphans()
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
        editor = EditorModel()
        fallback = FallbackTerminalController()
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
                let verdict = status.map { HerdrCompatibility.verdict(for: $0) } ?? .textOnly("The herdr command was not found or did not answer; panes show text")
                self.applyVerdict(verdict)
            }
        }
    }

    private func applyVerdict(_ v: StreamVerdict) {
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
    private func appResigned() {
        inactiveTimer?.invalidate()
        inactiveTimer = Timer.scheduledTimer(withTimeInterval: inactivePauseSeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { guard let self = self else { return }; self.attentive = false; self.syncSessions() }
        }
    }

    private func appBecameActive() {
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
        let n = waiting.count
        NSApplication.shared.dockTile.badgeLabel = n > 0 ? "\(n)" : ""
    }

    /// Streams run only for panes that are on screen: the window is visible and the Agent view is showing.
    /// The size is the pane's own (an observer cannot resize it), so the app asks Herdr for exactly that.
    private func syncSessions() {
        let active = windowVisible && attentive && mode == .agent
        primary.configure(pane: active ? selectedPaneID : nil, size: snapshot.paneSizes[selectedPaneID ?? ""])
        secondary.configure(pane: active ? comparePaneID : nil, size: snapshot.paneSizes[comparePaneID ?? ""])
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
        let list = snapshot.prioritized
        guard !list.isEmpty else { return }
        let i = list.firstIndex { $0.id == selectedPaneID } ?? -1
        select(list[(i + delta + list.count) % list.count].id)
    }

    func jumpToWaiting() {
        let w = waiting
        guard !w.isEmpty else { toast("Nothing is waiting on you"); return }
        let i = w.firstIndex { $0.id == selectedPaneID }.map { ($0 + 1) % w.count } ?? 0
        select(w[i].id)
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
        let w = DispatchWorkItem { [weak self] in self?.web.box(.reader).pin(sessionID: a.sessionID, label: a.name) }
        pinWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: w)
    }

    func reloadWeb() { web.allBoxes.forEach { $0.reload() } }

    // MARK: compose: the one write path

    var composeText: String { compose.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Moves the text into a short undo window, then delivers it with `pane.send_input` (text, then Enter).
    func send() {
        guard writesEnabled else { toast("Writes to \(endpoint.session) are off"); return }
        let text = composeText
        guard !text.isEmpty, let a = selectedAgent else { return }
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

    func shutdown() {
        store.stop(); primary.stop(); secondary.stop(); fallback.stop()
    }
}
