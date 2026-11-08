// Campus in the app model: which conversation is shown, how a link or a row opens one (the Watch column rule, C6), the sign-in sheet, Cmd+J and
// the quick switcher's Campus rows. The feed itself is `CampusStore` (ConnCore); this file only decides where a conversation goes on screen.
import SwiftUI
import Combine
import ConnCore

/// Something that waits on the person: a Herdr agent or a Campus conversation.
enum WaitingTarget: Equatable {
    case herdr(String)       // pane id
    case campus(String)      // conversation id
}

extension AppModel {
    func wireCampus() {
        // A person's own launch always starts with writes off; only a scripted check may start them on.
        if config.campusWritesAtLaunch && config.isScriptedLaunch { campus.writesEnabled = true }
        campusAuth?.onSignIn = { [weak self] in self?.campusSignInShown = true }
        watch.onOpenCampusLink = { [weak self] kind, folder, id, command, column in self?.openCampusLink(kind: kind, folder: folder, id: id, command: command, fromColumn: column) }
        // The stars the person keeps: the feed asks for the ones its lists do not carry, and a change redraws the row, the rows and the switcher.
        campus.starAddresses = campusStars.entries
        campusStars.$list.dropFirst().sink { [weak self] list in
            guard let self = self else { return }
            self.campus.starAddresses = list.entries
            self.campus.kick()
            self.objectWillChange.send()
        }.store(in: &cancellables)
        // The agent bridge: its switch is off at every launch (only a scripted check may start it on); what it shows redraws the status bar and the rows.
        if config.campusBridgeAtLaunch && config.isScriptedLaunch { campusBridge?.setEnabled(true) }
        campusBridge?.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.objectWillChange.send() } }.store(in: &cancellables)
        campusBridge?.ownership.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.objectWillChange.send() } }.store(in: &cancellables)
        // The silent refresh: it waits while the sign-in sheet is open (the person is signing in by hand) and looks at the session again when the sheet closes.
        if let keeper = campusKeeper {
            $campusSignInShown.sink { shown in keeper.paused = shown; if !shown { keeper.nudge() } }.store(in: &cancellables)
            keeper.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { self?.objectWillChange.send() } }.store(in: &cancellables)
            keeper.start()
        }
        campus.start()
    }

    /// A Campus row (sidebar, quick switcher, Cmd+J, a link): with Watch on the conversation goes to a column by the column rule, otherwise it is shown in
    /// the centre and the Reader column.
    func openCampus(_ id: String, fromColumn column: Int? = nil) {
        guard campus.conversation(id) != nil else { return }
        campus.markSeen(id)
        if watchOn { watch.openCampus(id, from: column); campusSelectedID = id; return }
        campusSelectedID = id
    }

    /// A link that names a Campus conversation (a reply in a Watch column, or text in a Campus transcript). The conversation is looked up when Conn does
    /// not know it yet. A plain click goes by the column rule; Cmd-click shows it in the normal view, leaving Watch (C6).
    func openCampusLink(kind: String, folder: String, id: String, command: Bool, fromColumn column: Int?) {
        Task { @MainActor in
            guard await campus.ensureConversation(kind: kind, folder: folder, id: id) != nil else { toast("That Campus conversation is not available"); return }
            if command {
                if watchOn { watchOn = false }
                openCampus(id)
            } else {
                openCampus(id, fromColumn: column)
            }
        }
    }

    // MARK: stars (S1)

    func campusIsStarred(_ id: String) -> Bool { campusStars.isStarred(id) }

    /// Star a conversation, or take its star off (the row's menu, the Campus menu, the header button).
    func toggleCampusStar(_ c: CampusConversation) {
        let was = campusStars.isStarred(c.id)
        let on = campusStars.toggle(CampusAddress(c))
        if !was && !on { toast("Campus stars are full", detail: "Remove one first: at most \(CampusStarList.limit) Campus conversations are kept in the starred row.") }
    }

    /// A Campus chip: the conversation opens by the Watch rule (`openCampus`: a column when Watch is on, else the centre and the Reader column). One the feed
    /// does not have yet (Campus not signed in, or not yet listed) is asked for by its address first.
    func openCampusStar(_ id: String) {
        if campus.conversation(id) != nil { openCampus(id); return }
        guard let a = campusStars.list.address(of: id) else { return }
        openCampusLink(kind: a.kind, folder: a.folder, id: a.id, command: false, fromColumn: nil)
    }

    /// "Open in a Watch Column" (a CAMPUS row, a chip, the Campus menu): turn Watch on if it is off, then place the conversation by the column rule.
    func showCampusInWatch(_ id: String) {
        guard campus.conversation(id) != nil else { toast("That Campus conversation is not available"); return }
        if !watchOn { watchOn = true }
        openCampus(id)
    }

    /// The Campus conversation on screen, if any.
    var campusSelected: CampusConversation? { campusSelectedID.flatMap { campus.conversation($0) } }

    // MARK: Cmd+J

    /// Everything waiting on the person: Herdr agents first (prompt waiting or done, in the usual order), then Campus questions, newest first.
    var waitingTargets: [WaitingTarget] {
        snapshot.prioritized.filter { $0.state.waitsOnCaptain }.map { .herdr($0.id) } + campus.asks.map { .campus($0.id) }
    }

    var currentTarget: WaitingTarget? { campusSelectedID.map { .campus($0) } ?? selectedPaneID.map { .herdr($0) } }

    func nextWaitingTarget() -> WaitingTarget? {
        let list = waitingTargets
        guard !list.isEmpty else { return nil }
        guard let cur = currentTarget, let i = list.firstIndex(of: cur) else { return list[0] }
        return list[(i + 1) % list.count]
    }

    func jumpToNextWaiting() {
        switch nextWaitingTarget() {
        case .herdr(let pane)?: select(pane)
        case .campus(let id)?: openCampus(id)
        case nil: toast("Nothing is waiting on you")
        }
    }

    // MARK: the quick switcher

    /// The quick switcher's rows: Herdr agents as before, then Campus conversations (asks first), each with the label "Campus".
    /// Asks first, then the starred ones in the order the person arranged them, then the rest.
    var campusSwitcherRows: [CampusConversation] {
        guard campus.link != .disabled else { return [] }
        let all = campus.attentionOrder
        let starIDs = campusStars.list.ids
        let asks = all.filter { $0.needsYou }
        let starred = starIDs.compactMap { id in all.first { $0.id == id && !$0.needsYou } }
        let rest = all.filter { !$0.needsYou && !starIDs.contains($0.id) }
        return asks + starred + rest
    }

    /// Show the sign-in sheet's page.
    func signInToCampus() { campusAuth?.beginSignIn() }

    func closeCampusSignIn() { campusSignInShown = false; campus.kick(); campusKeeper?.nudge() }

    var campusTimeText: String? { campus.asOf.map { CampusTime.clock($0) } }
}

enum CampusTime {
    static func clock(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: d)
    }
    /// The time of day, with the date when it is not today.
    static func stamp(_ d: Date, now: Date = Date()) -> String {
        if Calendar.current.isDate(d, inSameDayAs: now) { return clock(d) }
        let f = DateFormatter(); f.dateFormat = "d MMM HH:mm"; return f.string(from: d)
    }
}

// MARK: - writes (slice 2): every one goes through CampusStore's gate; a refusal is said in a toast

extension AppModel {
    /// Turning the switch on asks first (as Herdr's compose box does); turning it off is immediate.
    func requestCampusWrites() { campusConfirmWrites = true }
    func enableCampusWrites() { campus.writesEnabled = true; toast("Campus writes are on") }
    func disableCampusWrites() { campus.writesEnabled = false }

    /// Send the text. True when it was taken (the box is emptied; Undo or a failure brings it back through `campusDraftRestore`).
    @discardableResult
    func campusSend(_ text: String, to c: CampusConversation, delivery: String?) -> Bool {
        let id = c.id
        if let why = campus.send(text, to: c, delivery: delivery, restore: { [weak self] t in self?.campusDraftRestore.send((id, t)) }) { toast(why.message); return false }
        return true
    }

    func campusStop(_ c: CampusConversation) { if let why = campus.stop(c) { toast(why.message) } }

    func campusPick(_ form: CampusForm, in c: CampusConversation, question: Int, option: String) {
        guard campus.writesEnabled else { toast(CampusWriteRefusal.off.message); return }
        campus.pick(form, question: question, option: option)
        if form.questions.count == 1, let why = campus.answer(form, in: c) { toast(why.message) }
    }

    func campusAnswer(_ form: CampusForm, in c: CampusConversation) { if let why = campus.answer(form, in: c) { toast(why.message) } }
    func campusSetModel(_ m: CampusChoice, for c: CampusConversation) { if let why = campus.setModel(m, for: c) { toast(why.message) } }
    func campusSetAgent(_ a: CampusChoice, for c: CampusConversation) { if let why = campus.setAgent(a, for: c) { toast(why.message) } }
}

// MARK: - starting a conversation

extension AppModel {
    /// The spaces a person can start a conversation in: My space first, then the team spaces that are not read-only.
    var campusStartSpaces: [CampusSpace] { campus.spaces.filter { !$0.readOnly }.sorted { !$0.isTeam && $1.isTeam } }

    /// "New conversation" (the sidebar's plus, the Campus menu): opens the sheet for the first message. Behind the same gate as every write, so with the switch
    /// off or Campus not live it says why and opens nothing.
    func newCampusConversation(in space: CampusSpace) {
        if !campus.writesEnabled { toast(CampusWriteRefusal.off.message); return }
        if campus.link != .live { toast(CampusWriteRefusal.notLive.message); return }
        campusNewIn = space
    }

    /// Start it with the first message. True when the write was taken (the sheet shows the Undo window and closes itself when Campus answers).
    @discardableResult
    func startCampusConversation(_ text: String, in space: CampusSpace) -> Bool {
        if let why = campus.startConversation(in: space, text: text, onCreated: { [weak self] c in self?.campusConversationStarted(c, in: space) }) { toast(why.message); return false }
        return true
    }

    private func campusConversationStarted(_ c: CampusConversation?, in space: CampusSpace) {
        campusNewIn = nil
        guard let c = c else { toast("Campus started the conversation. It will show in the list in a moment."); return }
        if watchOn { watchOn = false }
        openCampus(c.id)
    }

    /// Cancel the sheet. A start still inside its Undo window is taken back first, so closing the sheet never leaves a conversation to appear on its own.
    func closeCampusNew() {
        if let space = campusNewIn, campus.held?.conversationID == CampusStore.startKey(space), campus.held?.phase == .held { campus.undo() }
        campusNewIn = nil
    }
}

// MARK: - the agent bridge (S2)

extension AppModel {
    static let bridgeAlsoAllowedKey = "conn.campus.bridge.alsoAllowed"

    /// The bridge's files: a person's own launch uses the real session registry (`FM_SESSIONS_DIR`, else `~/.local/state/firstmate/sessions`) and Conn's own folder for the audit.
    /// A scripted launch never touches either: its registry is `FM_SESSIONS_DIR` when the launch is told one (a lab), else a folder of its own, and so is its audit.
    static func makeBridge(config: AppConfig, env: [String: String], store: CampusStore) -> BridgeEngine {
        let scripted = config.isScriptedLaunch
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("conn-bridge-\(getpid())", isDirectory: true)
        let labGiven = !(env["FM_SESSIONS_DIR"] ?? "").isEmpty
        let registryDir = scripted && !labGiven ? scratch.appendingPathComponent("registry", isDirectory: true) : BridgeRegistry.defaultDirectory(env: env)
        let auditFile = scripted ? scratch.appendingPathComponent("audit.jsonl") : ConnMigration.stateDirectory().appendingPathComponent("campus-bridge/audit.jsonl")
        let ownership = BridgeOwnership(defaults: AppModel.defaults, key: config.fixture ? "conn.campus.bridge.threads.fixture" : "conn.campus.bridge.threads")
        let also = (AppModel.defaults.array(forKey: bridgeAlsoAllowedKey) as? [String]) ?? []
        let engine = BridgeEngine(store: store, registry: BridgeRegistry(directory: registryDir), ownership: ownership, audit: BridgeAuditLog(file: auditFile), callers: BridgeCallers(alsoAllowed: also))
        if let agents = AppModel.defaults.array(forKey: "conn.campus.bridge.agents") as? [String], !agents.isEmpty { engine.allowedAgents = agents }
        return engine
    }

    /// Turning the switch on asks first; turning it off is immediate.
    func requestCampusBridge() { campusConfirmBridge = true }
    func enableCampusBridge() {
        campusBridge?.setEnabled(true)
        if let why = campusBridge?.problem { toast("The Agent bridge did not start", detail: why) } else { toast("The Agent bridge is on") }
    }
    func disableCampusBridge() { campusBridge?.setEnabled(false) }

    func setCampusBridgeAlsoAllowed(_ labels: [String]) {
        let clean = Array(Set(labels.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && $0.range(of: "^[A-Za-z0-9._-]{1,80}$", options: .regularExpression) != nil })).sorted()
        AppModel.defaults.set(clean, forKey: Self.bridgeAlsoAllowedKey)
        campusBridge?.callers = BridgeCallers(alsoAllowed: clean)
    }

    /// "Share with Agents" on a Campus row: nothing, reading, or reading and sending. A thread the bridge started is always shared.
    func shareCampus(_ c: CampusConversation, _ mode: BridgeShare?) {
        campusBridge?.ownership.setShared(CampusAddress(c), mode)
    }
}

// MARK: - the silent session refresh

extension AppModel {
    /// Where the attempts are logged: Conn's own folder for a person's launch; a scripted launch writes a folder of its own, never the person's.
    static func makeRenewalLog(config: AppConfig) -> CampusRenewalLog {
        let dir = config.isScriptedLaunch
            ? FileManager.default.temporaryDirectory.appendingPathComponent("conn-campus-refresh-\(getpid())", isDirectory: true)
            : ConnMigration.stateDirectory().appendingPathComponent("campus", isDirectory: true)
        return CampusRenewalLog(file: dir.appendingPathComponent("session-refresh.log"))
    }
}
