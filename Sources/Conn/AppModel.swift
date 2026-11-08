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
    /// The Watch view's columns (see `watchOn`).
    let watch: WatchModel
    /// The Reader pane's starred sessions (read from the reader's own star list; only their order is Conn's).
    let stars: StarredSessions
    /// The reader's open asks, shown on the agent rows (read from the reader's open-asks endpoint; see OpenAskStore).
    let openAsks: OpenAskStore
    /// Agents at a Claude permission prompt that Herdr did not call blocked (read from their screens; see PermissionPromptWatch).
    let promptWatch: PermissionPromptWatch
    /// Campus conversations (README "Campus in Conn"): one in-memory feed behind the CAMPUS sidebar section, the live view, the transcript and the Watch column.
    let campus: CampusStore
    /// The cookie-based sign-in the feed reads through (nil when Campus is not part of this launch). An API key would be another `CampusAuth`.
    let campusAuth: CampusWebAuth?
    /// The Campus conversations the person starred in Conn (S1): addresses and order only, in Conn's own settings; shown as chips beside the reader's stars.
    let campusStars: CampusStarStore
    /// The agent bridge (S2): leaders ask Campus through Conn. Off at every launch; nil when Campus is not part of this launch.
    let campusBridge: BridgeEngine?
    /// The silent session refresh (J7=a): knows when the Campus session ends and, about five minutes before, signs in again by itself in a hidden web view when
    /// Google and Campus finish it unaided; otherwise says "sign in again". nil when Campus is not part of this launch.
    let campusKeeper: CampusSessionKeeper?
    let campusRenewal: CampusSilentRenewal?
    /// Asking before the "Agent bridge" switch goes on, and the activity sheet.
    @Published var campusConfirmBridge = false
    @Published var campusBridgeActivityShown = false
    /// The Campus conversation shown in the centre (and in the Reader column), or nil: a Herdr agent or a view is shown instead.
    @Published var campusSelectedID: String?
    @Published var campusSignInShown = false
    /// Asking before the "Campus writes" switch goes on.
    @Published var campusConfirmWrites = false
    /// Text that goes back into a conversation's box (an Undo, or a send that failed): (conversation id, text).
    let campusDraftRestore = PassthroughSubject<(String, String), Never>()
    /// The space a "New conversation" sheet is open for (nil: no sheet).
    @Published var campusNewIn: CampusSpace?
    /// The sheet that names a Watch preset to save, or lists the presets to rename and delete (`AppModel+WatchSetups`).
    @Published var watchPresetSheet: WatchPresetSheet?
    /// Focus sessions and 20-20-20 eye breaks (README "Focus sessions"): the session, the eye clock, Conn Focus (the macOS Focus Conn switches through a Shortcut), the marker file
    /// other tools read, and the daily total. A scripted launch runs it on stand-ins (see `FocusRuntime`).
    let focus: FocusCoordinator
    let focusPanel: EyeBreakPanelController
    let focusStandIns: FocusStandInSet?
    /// The toolbar popover of the focus session, and the one-time setup sheet.
    @Published var focusPopoverShown = false
    @Published var focusSetupShown = false
    let editor: EditorModel
    let fallback: FallbackTerminalController
    let renderer: RendererKind
    @Published private(set) var client: HerdrClient

    @Published var selectedPaneID: String?
    @Published var comparePaneID: String?
    @Published var selectedWorkspaceID: String?
    /// The launch sets the first view (`LaunchPlan`): the Herdr client for a person's own launch, the Agent view for a scripted one.
    /// Choosing another view leaves Watch, which stands in for the centre pane and the reader column while it is on.
    /// Every way of setting the view lands here, so with the Agent view off (`ViewPolicy`) nothing can reach it.
    @Published var mode: CenterMode = .herdr {
        didSet {
            let resolved = viewPolicy.resolve(mode)
            if resolved != mode { mode = resolved }
            if mode != oldValue { if watchOn { watchOn = false }; campusSelectedID = nil; syncSessions() }
        }
    }
    /// The Agent-view flag (README "The Agent view flag"). Read once at launch; a check turns it on and off in process.
    @Published var agentViewEnabled: Bool {
        didSet {
            guard agentViewEnabled != oldValue else { return }
            if !agentViewEnabled {
                if mode == .agent { mode = .herdr }
                comparePaneID = nil; primaryHistory = nil; secondaryHistory = nil
            }
            syncSessions()
        }
    }
    var viewPolicy: ViewPolicy { ViewPolicy(agentViewEnabled: agentViewEnabled) }
    /// Watch: 2 to 4 conversations side by side, each on the reader's lite page, instead of the centre pane and the reader column.
    /// While it is on the full reader is unloaded (its page holds every conversation and document); turning it off loads the
    /// reader again, pinned to the selected agent. Every way of choosing an agent follows the column rule (`WatchLayout`).
    @Published var watchOn = false { didSet { if watchOn != oldValue { watchChanged() } } }
    @Published var showWeb = true {
        didSet { if showWeb && !oldValue && webTab == .organizer { web.box(.organizer).showContextView() } }
    }
    /// The left panel (spaces and agents): shown or hidden with the toolbar button, Layout > Hide Sidebar or Ctrl+Cmd+S, and remembered
    /// across launches. Hidden, it gives its 251 pt to the centre pane or to the Watch columns.
    @Published var sidebarVisible: Bool = AppModel.defaults.object(forKey: AppModel.sidebarVisibleKey) as? Bool ?? true {
        didSet { if sidebarVisible != oldValue { Self.defaults.set(sidebarVisible, forKey: Self.sidebarVisibleKey) } }
    }
    private static let sidebarVisibleKey = "conn.sidebar.visible"
    @Published var webWidth: CGFloat = 480
    /// The Editor view's Explorer: shown or hidden (Cmd+B), and its width. Remembered across launches.
    @Published var explorerVisible: Bool = AppModel.defaults.object(forKey: AppModel.explorerVisibleKey) as? Bool ?? true {
        didSet {
            Self.defaults.set(explorerVisible, forKey: Self.explorerVisibleKey)
            // Hiding the Explorer while it has the keyboard gives the keyboard to the editor, not to nobody.
            if !explorerVisible && editor.explorerFocused { editor.focusEditor() }
        }
    }
    @Published var explorerWidth: Double = ExplorerLayout.clamped(AppModel.defaults.object(forKey: AppModel.explorerWidthKey) as? Double ?? ExplorerLayout.defaultWidth) {
        didSet { Self.defaults.set(explorerWidth, forKey: Self.explorerWidthKey) }
    }
    private static let explorerVisibleKey = "conn.explorer.visible"
    private static let explorerWidthKey = "conn.explorer.width"
    /// The Reader column steps aside while the Editor view would otherwise leave the editor under 520 pt (`ExplorerLayout`); the
    /// window reports its width here. Showing the Reader by hand in that state keeps it (`readerForced`) until the room is back.
    /// The `conn` shell command's link in ~/.local/bin (File menu).
    @Published var connCommand: CommandInstall.State = ConnCommandLink.currentState()
    @Published private(set) var readerSteppedAside = false
    @Published private(set) var readerForced = false
    /// Whether the Reader column is on screen: switched on and not stepped aside.
    var readerShown: Bool { showWeb && !readerSteppedAside }
    /// The Reader toggle (toolbar, menu, Opt+Cmd+R): what is on screen. Turning it on while it is stepped aside shows it anyway.
    var readerToggle: Bool {
        get { readerShown }
        set {
            if newValue, showWeb, readerSteppedAside { readerForced = true; readerSteppedAside = false }
            else { showWeb = newValue; if !newValue { readerForced = false; readerSteppedAside = false } }
        }
    }
    private(set) var windowWidth: CGFloat = 1500
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
    private var herdrAdoptPending = false
    @Published var privacy = false {
        didSet {
            if privacy { primaryHistory = nil; secondaryHistory = nil }
            focus.privacyActive = privacy          // the eye-break panel is hidden from screen capture while Privacy mode is on
        }
    }
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
    /// A second, smaller line under the toast (the text a copy put on the clipboard).
    @Published var toastDetail: String?
    @Published private(set) var streamVerdict: StreamVerdict = .ok
    @Published private(set) var windowVisible = true
    /// False once the app has been in the background for `inactivePauseSeconds`: streams stop, the sidebar keeps running.
    @Published private(set) var attentive = true
    private var inactiveTimer: Timer?
    var inactivePauseSeconds: TimeInterval = ProcessInfo.processInfo.environment["CONN_INACTIVE_PAUSE"].flatMap(Double.init) ?? 30
    @Published var confirmWrites = false

    var cancellables = Set<AnyCancellable>()
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
        agentViewEnabled = config.agentViewEnabled
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
        watch = WatchModel(hub: web, defaults: AppModel.defaults)
        // While Watch is on the full Reader page is unloaded: the asks are read from a column's lite page instead (nil: Watch is off).
        web.extraReaderPages = { [weak watch = watch] in guard let w = watch, w.active else { return nil }; return w.boxes.values.map(\.webView) }
        let env = ProcessInfo.processInfo.environment
        let fixtureDir = res?.appendingPathComponent("fixture")
        // A fixture launch reads invented stars (never the owner's file) and keeps its order apart from the real one.
        let starsFile = config.fixture ? URL(fileURLWithPath: env["CONN_READER_STARS"] ?? fixtureDir?.appendingPathComponent("fixture-stars.json").path ?? "/nonexistent") : ReaderStars.defaultFile(env: env)
        let labelsFile = config.fixture ? URL(fileURLWithPath: env["CONN_READER_LABELS"] ?? fixtureDir?.appendingPathComponent("fixture-pane-labels.json").path ?? "/nonexistent") : StarLabels.defaultFile(env: env)
        stars = StarredSessions(starsFile: starsFile, labelsFile: labelsFile,
                                store: StarOrderStore(defaults: AppModel.defaults, key: config.fixture ? "conn.readerStarOrder.fixture" : "conn.readerStarOrder"))
        stars.start()
        promptWatch = PermissionPromptWatch(client: HerdrClient(endpoint: endpoint))
        openAsks = AppModel.makeOpenAskStore(config: config, env: env, web: web, fixtureDir: fixtureDir, herdrSession: endpoint.session)
        // A scripted launch reads cookies from a store of its own, so a check never touches a person's own sign-in.
        campusAuth = config.campusEnabled ? CampusWebAuth(origin: config.campusBase, persistent: !config.isScriptedLaunch) : nil
        campus = CampusStore(auth: campusAuth, baseURL: config.campusBase)
        // A fixture launch keeps its Campus stars apart from the real ones (as it does the reader's chip order).
        campusStars = CampusStarStore(defaults: AppModel.defaults, key: config.fixture ? "conn.campusStars.fixture" : "conn.campusStars")
        campusBridge = config.campusEnabled ? AppModel.makeBridge(config: config, env: env, store: campus) : nil
        campusRenewal = campusAuth.map { CampusSilentRenewal(origin: config.campusBase, store: $0.store) }
        campusKeeper = campusRenewal.map { CampusSessionKeeper(renewer: $0, log: AppModel.makeRenewalLog(config: config)) }
        web.campusHost = config.campusBase.host
        editor = EditorModel(defaults: AppModel.defaults)
        let made = FocusRuntime.make(config: config)
        focus = made.coordinator; focusPanel = made.panel; focusStandIns = made.standIns
        fallback = FallbackTerminalController()
        // A link in one web pane that points at the other switches to it and shows that exact address.
        // A click on a file in the reader's page (a link in a reply, a button in its Documents view) opens it in the Editor view, as `conn <path>` does.
        web.onFileRef = { [weak self] path in self?.openReaderFile(path) }
        web.onShowPane = { [weak self] kind, url in
            guard let self = self else { return }
            self.showWeb = true
            self.webTab = kind
            self.web.box(kind).show(address: url)
        }
        showWeb = config.showWeb ?? true
        mode = config.launchPlan.mode
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
        // The Editor's own changes (open files, the folder, the selected tab) reach views that read them through the app model.
        editor.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.objectWillChange.send() } }.store(in: &cancellables)
        editor.toast = { [weak self] title, detail in self?.toast(title, detail: detail) }
        editor.showExplorer = { [weak self] in if self?.explorerVisible == false { self?.explorerVisible = true } }
        store.start()
        openAsks.start { [weak self] in self.map { $0.windowVisible && $0.attentive } ?? false }
        // The screens of working and idle Claude agents are read for a permission prompt Herdr did not report (CONN_PROMPT_WATCH=off stops it).
        if env["CONN_PROMPT_WATCH"] != "off" {
            promptWatch.start(snapshot: { [weak self] in self?.store.snapshot ?? .empty }, active: { [weak self] in self.map { $0.windowVisible && $0.attentive } ?? false })
        }
        promptWatch.$panes.dropFirst().sink { [weak self] _ in
            self?.objectWillChange.send()
            DispatchQueue.main.async { self?.refreshDockBadge() }
        }.store(in: &cancellables)
        wireWatchAsks()
        wireWatchSetups()
        openAsks.$asks.dropFirst().sink { [weak self] _ in DispatchQueue.main.async { self?.readerTargetMayHaveChanged() } }.store(in: &cancellables)
        wireCampus()
        // A Cmd-click on a session link in a column leaves Watch for the normal reader on that session.
        watch.onOpenInReader = { [weak self] session in self?.openSessionInReader(session) }
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

    /// Herdr's snapshot, with the agents at a permission prompt that Herdr did not call blocked shown as needing you.
    var snapshot: Snapshot {
        let base = store.snapshot, panes = promptWatch.panes
        if panes.isEmpty { return base }
        if let c = promptOverlay, c.panes == panes, c.base == base { return c.shown }
        let shown = base.showingPermissionPrompts(on: panes)
        promptOverlay = (base, panes, shown)
        return shown
    }
    private var promptOverlay: (base: Snapshot, panes: Set<String>, shown: Snapshot)?
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
        openAsks.refresh()
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
            // The first pick is only a highlight: it must not change the view the launch opened on.
            if let f = s.agent(s.focusedPaneID) ?? s.prioritized.first { highlight(f.id) }
        }
        if let c = comparePaneID, s.agent(c) == nil { comparePaneID = nil }
        if watchOn && watchSeedPending {
            let c = watchCandidates()
            if !c.isEmpty { watchSeedPending = false; watch.fill(with: c) }
        }
        syncSessions()
        followHerdrClientFocus()
        readerTargetMayHaveChanged()
        refreshDockBadge()
    }

    private func refreshDockBadge() {
        let n = waiting.count
        NSApplication.shared.dockTile.badgeLabel = n > 0 ? "\(n)" : ""
    }

    /// Streams run only for panes that are on screen: the window is visible and the Agent view is showing.
    /// The size is the pane's own (an observer cannot resize it), so the app asks Herdr for exactly that.
    private func syncSessions() {
        let active = windowVisible && attentive && mode == .agent && !watchOn
        primary.configure(pane: active ? selectedPaneID : nil, size: snapshot.paneSizes[selectedPaneID ?? ""])
        secondary.configure(pane: active ? comparePaneID : nil, size: snapshot.paneSizes[comparePaneID ?? ""])
        // A history belongs to the pane it was opened for: another agent in the column shows live again.
        if let h = primaryHistory, h.paneID != selectedPaneID { primaryHistory = nil }
        if let h = secondaryHistory, h.paneID != comparePaneID { secondaryHistory = nil }
    }

    /// Make this the selected agent (sidebar highlight, recents, reader pin) without choosing a view.
    func highlight(_ paneID: String, pin: Bool = true) {
        guard let a = snapshot.agent(paneID) else { return }
        campusSelectedID = nil
        recordVisit(paneID)
        selectedPaneID = paneID
        selectedWorkspaceID = a.workspaceID
        syncSessions()
        if pin { askPane = nil; pinReader() }
    }

    private func recordVisit(_ paneID: String) {
        if paneID == comparePaneID { comparePaneID = selectedPaneID }
        if let cur = selectedPaneID, cur != paneID { recents.removeAll { $0 == cur }; recents.insert(cur, at: 0) }
    }

    /// Open a session: Cmd+K, Cmd+1..9, Cmd+J, Cmd+[ and Cmd+], a sidebar click with no client attached, the menu-bar list. Where it
    /// lands is `ViewPolicy.action`: Cmd+K always shows it in the Herdr client view, and the rest do too unless the Agent view is on.
    /// A jump never attaches the client.
    func select(_ paneID: String, via jump: ViewPolicy.Jump = .other, pin: Bool = true) {
        guard let a = snapshot.agent(paneID) else { return }
        if watchOn {
            // Watch is on: the agent goes to a column by the column rule, and the view stays Watch.
            highlight(paneID, pin: false)
            watchOpen(a)
            return
        }
        switch viewPolicy.action(for: jump, clientRunning: fallback.running) {
        case .showInAgentView:
            highlight(paneID, pin: pin)
            mode = .agent
        case .showHerdrClientView:
            mode = .herdr
            highlight(paneID, pin: pin)
        case .moveHerdrClient:
            campusSelectedID = nil
            mode = .herdr
            recordVisit(paneID)
            moveHerdrClient(to: .tab(a.tabID), label: a.name, workspace: a.workspaceID, pane: a.id)
            syncSessions()
            if pin { askPane = nil; pinReader() }
        }
    }

    func selectTab(_ tab: HerdrTab) { if let a = snapshot.agent(inTab: tab.id) { select(a.id) } }

    func selectWorkspace(_ id: String) {
        selectedWorkspaceID = id
        if watchOn { return }     // a space is not a conversation: Watch keeps its columns
        if let a = snapshot.agents(in: id).first(where: { $0.id == selectedPaneID }) ?? snapshot.agents(in: id).first { select(a.id) }
    }

    /// The agents in the order the sidebar shows them and Cmd+1...9 follows: those that need you first (prompt waiting, then the
    /// newest ask), then the rest as `Snapshot.prioritized` orders them. Without asks (the reader is down) it is `prioritized`.
    var agentOrder: [Agent] { snapshot.prioritized(asks: openAsks.visible()) }

    /// The agents that need the captain, as the AGENTS header counts them: prompt waiting, or an unread open ask (a read ask is not counted).
    var needYouCount: Int {
        let unread = openAsks.visible()
        return snapshot.agents.filter { $0.state == .blocked || unread[$0.id] != nil }.count
    }

    func selectNth(_ i: Int) { let list = agentOrder; if i < list.count { select(list[i].id) } }

    func cycle(_ delta: Int) {
        if let a = snapshot.agent(after: selectedPaneID, offset: delta, asks: openAsks.visible()) { select(a.id) }
    }

    func jumpToWaiting() { jumpToNextWaiting() }

    func toggleCompare() {
        guard agentViewEnabled else { return }
        if comparePaneID != nil { comparePaneID = nil; syncSessions(); return }
        let other = recents.first { snapshot.agent($0) != nil && $0 != selectedPaneID }
            ?? snapshot.prioritized.first { $0.id != selectedPaneID }?.id
        comparePaneID = other
        syncSessions()
    }

    var readerVisible: Bool { showWeb && webTab == .reader && !watchOn }

    /// The reader conversation an agent stands for: the session Herdr names, else the one its open ask names. nil: the agent has no
    /// transcript yet (Herdr reports a session only once an integration has, so a pane started a moment ago has none).
    func readerSession(for agent: Agent) -> String? { ReaderTarget.session(herdr: agent.sessionID, ask: openAsks.listed()[agent.id]?.session) }

    /// The Reader column has nothing for the selected agent: it says so instead of staying on the conversation of the agent chosen
    /// before, which would read as this agent's transcript.
    var readerHasNoTranscript: Bool {
        guard readerFollows, !watchOn, let a = selectedAgent else { return false }
        return readerSession(for: a) == nil
    }

    /// The conversation the selected agent stood for when last looked at, so a session that appears later (Herdr reports one once an
    /// integration has, or an open ask names one) reaches the reader without another click.
    private var readerTargetSeen: (pane: String, session: String?)?

    private func readerTargetMayHaveChanged() {
        guard let a = selectedAgent else { readerTargetSeen = nil; return }
        let now = readerSession(for: a)
        defer { readerTargetSeen = (a.id, now) }
        if let seen = readerTargetSeen, seen.pane == a.id, seen.session != now { pinReader() }
    }

    /// "Open the reader pinned to the selected pane": debounced, because every pin is a page load.
    func pinReader() {
        pinWork?.cancel()
        guard readerFollows, readerVisible, let a = selectedAgent else { return }
        // The reader was just opened on this agent's ask: a pin to its newest turn would take it away again.
        if askPane == a.id { return }
        // No conversation to show: the column's own notice covers the page (`readerHasNoTranscript`), and nothing is pinned.
        guard let session = readerSession(for: a) else { return }
        let w = DispatchWorkItem { [weak self] in self?.web.box(.reader).pin(sessionID: session) }
        pinWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: w)
    }

    /// The pane whose open ask the reader was last opened on (a click on its row). While that agent stays selected, the pin that
    /// follows an agent selection leaves the reader where it is; choosing an agent again (`select` with a pin) lets it follow.
    private var askPane: String?

    /// A click on an agent row that has an ask: open the reader column on the reply that asks (`#s=<session>&m=<message>`; the reader
    /// scrolls to the reply and flashes it once). The column is shown if it was hidden, and the Reader tab comes to the front.
    func openAsk(_ ask: OpenAsk) {
        pinWork?.cancel()
        // Watch has no Reader column: choosing the agent already put its conversation in a column, on the asking reply (`watch.openAskTurnID`).
        if watchOn { return }
        askPane = ask.paneID
        if !showWeb { showWeb = true }
        if webTab != .reader { webTab = .reader }
        web.box(.reader).pin(sessionID: ask.session, message: ask.message)
    }

    /// Show one conversation in the normal reader, leaving Watch if it is on (a Cmd-click on a session link in a Watch column). The
    /// reader is pinned to it the way an ask row pins it: the agent selection's own pin is cancelled and does not run again while
    /// that agent stays selected, so the reader stays on this conversation until another agent is chosen.
    func openSessionInReader(_ session: String) {
        guard WatchAddress.validSession(session) else { return }
        pinWork?.cancel()
        askPane = selectedPaneID
        if watchOn { watchOn = false }      // lets go of the columns and schedules the selected agent's pin: dropped just below
        pinWork?.cancel()
        if !showWeb { showWeb = true }
        if webTab != .reader { webTab = .reader }
        web.box(.reader).pin(sessionID: session)
    }

    /// A Watch column that opens a conversation with an open ask (a click on its row, or any way of choosing the agent) opens on the
    /// asking reply: the lite page scrolls to it and outlines it. Folded (older) asks count as none, as on the rows.
    func wireWatchAsks() {
        watch.openAskTurnID = { [weak self] session in self?.openAsks.shown().values.first { $0.session == session }?.message }
    }

    /// The ask an agent's row shows now (nil: no ask, an older one still folded away, or one already read and not listed).
    func ask(for agent: Agent) -> OpenAsk? { openAsks.shown()[agent.id] }

    /// Where the asks come from: `CONN_OPEN_ASKS_URL` (an address or a `file:` one), else the fixture's invented list, else the
    /// reader's own endpoint, asked from inside the Reader web view because the route needs the token that only the reader page
    /// holds (the page is loaded in the background if the Reader pane was never shown). `herdrSession` is the Herdr session Conn is
    /// attached to: the reader names the session of each pane, and an ask for another one is not ours.
    static func makeOpenAskStore(config: AppConfig, env: [String: String], web: WebHub, fixtureDir: URL?, herdrSession: String) -> OpenAskStore {
        // A fixture launch keeps its read marks apart from the real ones (as it does the starred order).
        let readKey = config.fixture ? "conn.asks.read.fixture" : "conn.asks.read"
        if let u = env["CONN_OPEN_ASKS_URL"], !u.isEmpty, let url = URL(string: u) {
            return OpenAskStore(url: url, herdrSession: herdrSession, rebaseToNow: config.fixture, defaults: AppModel.defaults, readKey: readKey)
        }
        if config.fixture { return OpenAskStore(url: fixtureDir?.appendingPathComponent("open-asks.json"), herdrSession: herdrSession, rebaseToNow: true, defaults: AppModel.defaults, readKey: readKey) }
        return OpenAskStore(source: { @MainActor [web] in await web.fetchOpenAsks() }, herdrSession: herdrSession, defaults: AppModel.defaults, readKey: readKey)
    }

    /// The Reader pane's row of starred sessions: open this conversation in the reader (the pin path an agent selection uses,
    /// so the reader loads it with its `#s=` address). The one on screen is left alone: opening it again would reload the page.
    func openStarred(_ conv: String) {
        if watchOn { watch.open(session: conv); return }
        guard !StarSelection.matches(conv: conv, shown: web.box(.reader).shownSession) else { return }
        if webTab != .reader { webTab = .reader }
        web.box(.reader).pin(sessionID: conv)
    }

    /// Names of the agents by session id, for the starred sessions an agent runs now.
    var agentNamesBySession: [String: String] {
        Dictionary(snapshot.agents.compactMap { a in a.sessionID.map { ($0, a.name) } }, uniquingKeysWith: { first, _ in first })
    }

    func reloadWeb() { web.allBoxes.forEach { $0.reload() }; watch.reloadAll() }

    // MARK: Watch

    /// Watch was turned on (a `--watch` launch) before Herdr's first snapshot arrived: the columns are filled when it does.
    private var watchSeedPending = false

    private func watchChanged() {
        watch.active = watchOn
        if watchOn {
            pinWork?.cancel()
            web.evictReader()
            // Watch opens on the setup it was left in: kept while another view was shown, and across launches (`WatchModel.setups`). A
            // session that no longer exists leaves its column free, and only free columns the person did not choose (none at all, or
            // the ones that session left) are filled from the sidebar's order; a column the person closed stays closed.
            let gone = watch.pruneGone()
            if !gone.isEmpty { toastWatchGone(gone) }
            let needsFill = watch.layout.openCount == 0 || !gone.isEmpty
            watchSeedPending = needsFill && watchCandidates().isEmpty
            if needsFill { watch.fill(with: watchCandidates()) }
        } else {
            watchSeedPending = false
            watch.unload()
        }
        syncSessions()
        if !watchOn { pinReader() }
        objectWillChange.send()
    }

    /// The sessions Watch opens on, best first: the selected agent (else Herdr's focused one), then the agents in the sidebar's order (needs you first).
    func watchCandidates() -> [String] {
        ((selectedAgent ?? snapshot.agent(snapshot.focusedPaneID)).flatMap(watchConversation).map { [$0] } ?? []) + agentOrder.compactMap(watchConversation)
    }

    /// The reader conversation an agent shows in a Watch column: the session its open ask names (the reader's own id for the pane's
    /// conversation, which can be a later session of a /clear chain than the one Herdr names, and is the one the asking reply is in),
    /// else the session Herdr names for it.
    private func watchConversation(_ a: Agent) -> String? { openAsks.listed()[a.id]?.session ?? a.sessionID }

    /// An agent chosen while Watch is on. An agent with no conversation in the reader (neither Herdr nor an open ask names a session
    /// for it) has nothing to show in a column.
    private func watchOpen(_ a: Agent) {
        guard let sid = watchConversation(a) else { toast("\(privacy ? "That agent" : a.name) has no conversation in the reader"); return }
        if watch.open(session: sid) == nil { toast("That conversation cannot be opened in a column") }
    }

    /// Choose how many columns Watch has (2 to 4, remembered). More columns are filled from the sidebar's order.
    /// Each count opens on its own last setup (`WatchSetups`); a count never used is filled from the sidebar's order, as are the columns
    /// of a remembered setup whose session no longer exists.
    func setWatchCount(_ n: Int) {
        let change = watch.setCount(n)
        if !change.gone.isEmpty { toastWatchGone(change.gone) }
        if watchOn && ((change.grew && !change.restored) || !change.gone.isEmpty) { watch.fill(with: watchCandidates()) }
    }

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

    func toast(_ s: String, detail: String? = nil) {
        toastText = s
        toastDetail = detail
        DispatchQueue.main.asyncAfter(deadline: .now() + (detail == nil ? 2.2 : 3.0)) { [weak self] in
            if self?.toastText == s { self?.toastText = nil; self?.toastDetail = nil }
        }
    }

    // MARK: Editor: folders and files from outside

    /// Paths from the `conn` command, Finder (Open With, a drop on the Dock icon), a drop on the window or a menu: the Editor view
    /// shows them (README "Opening a folder from the terminal").
    func openFromOutside(_ urls: [URL]) {
        mode = .editor
        editor.openFromOutside(urls)
    }

    /// A click on a file the reader's page names (`.file-ref[data-path]`): the Editor view opens it in this window, as `conn <path>` would. A path that is not absolute,
    /// is gone or is not a regular file opens nothing and says so in a notice.
    func openReaderFile(_ path: String) {
        switch ReaderFileRef.check(path) {
        case .open(let url): openFromOutside([url])
        case .refused(let name, let reason):
            let n = ReaderFileRef.notice(name: name, reason: reason)
            toast(n.title, detail: n.detail)
        }
    }

    /// Right-click an agent: its working folder in the Explorer.
    func openWorkingFolder(of agent: Agent) {
        guard !agent.cwd.isEmpty else { return }
        openFromOutside([URL(fileURLWithPath: agent.cwd)])
    }

    /// The window's width changed, or something that decides whether the Reader has room (the view, the Explorer, the sidebar).
    func updateReaderLayout(windowWidth w: CGFloat? = nil) {
        if let w = w { windowWidth = w }
        let needsRoom = mode == .editor && !watchOn && showWeb
            && ExplorerLayout.readerStepsAside(windowWidth: Double(windowWidth), sidebarVisible: sidebarVisible, explorerVisible: explorerVisible,
                                               explorerWidth: explorerWidth, readerWidth: Double(webWidth))
        let aside = needsRoom && !readerForced
        if aside != readerSteppedAside { readerSteppedAside = aside }
        if !needsRoom && readerForced { readerForced = false }
    }

    // MARK: footprint line shown in the status bar

    func updateStats() {
        var pids: [(String, pid_t)] = [("app", getpid())]
        if let p = primary.processID { pids.append(("pane", p)) }
        if let p = secondary.processID { pids.append(("pane", p)) }
        for b in web.allBoxes + Array(watch.boxes.values) { if let p = b.pid { pids.append(("web", p)) } }
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
    var herdrClientDriving: Bool { mode == .herdr && fallback.running && !watchOn }

    /// A click on a space in the sidebar.
    func sidebarOpenWorkspace(_ id: String) {
        guard herdrClientDriving else { selectWorkspace(id); return }
        campusSelectedID = nil
        moveHerdrClient(to: .workspace(id), label: snapshot.workspace(id)?.label ?? id, workspace: id, pane: nil)
    }

    /// A click on an agent in the sidebar: its tab.
    /// A row with an open ask also opens the reader column on the reply that asks; a row without one does what it always did.
    func sidebarOpenAgent(_ a: Agent) {
        campusSelectedID = nil
        let asking = ask(for: a)
        if herdrClientDriving {
            moveHerdrClient(to: .tab(a.tabID), label: a.name, workspace: a.workspaceID, pane: a.id)
            // The reader follows the selection here too (a row with an ask opens it on the ask just below).
            if asking == nil { askPane = nil; pinReader() }
        } else {
            select(a.id, pin: asking == nil)
        }
        if let asking = asking { openAsk(asking); openAsks.markRead(asking) }     // opening the ask is reading it
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
                    if let p = pane, self.selectedPaneID == p { self.selectedPaneID = before.pane; self.askPane = nil; self.pinReader() }
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
    private func followHerdrClientFocus(adopt requested: Bool = false) {
        guard herdrClientDriving else { return }
        // A client attached at launch starts before the first snapshot has arrived: its opening position is adopted once there is one.
        if requested { herdrAdoptPending = true }
        let adopt = herdrAdoptPending
        if adopt && snapshot.focusedWorkspaceID != nil && snapshot.focusedTabID != nil { herdrAdoptPending = false }
        let settled = !herdrNavigating && (herdrNavEndedAt.map { Date().timeIntervalSince($0) > 1.5 } ?? true)
        guard let at = clientFocus.observe(workspace: snapshot.focusedWorkspaceID, tab: snapshot.focusedTabID, adopt: adopt,
                                           settled: settled, userActive: fallback.hadUserInput(within: 2)) else { return }
        selectedWorkspaceID = at.workspace
        if let a = snapshot.agent(inTab: at.tab), a.id != selectedPaneID {
            selectedPaneID = a.id
            askPane = nil; pinReader()      // the reader follows the highlight, whoever moved it
        }
    }

    func shutdown() {
        focus.shutdown()          // the session ends, the marker goes, Conn Focus is switched off (waiting a few seconds for it)
        campusBridge?.shutdown()
        campusKeeper?.stop()
        campus.stop(); store.stop(); primary.stop(); secondary.stop(); fallback.stop(); promptWatch.stop()
    }
}
