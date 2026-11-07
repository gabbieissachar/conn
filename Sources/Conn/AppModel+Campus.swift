// Campus in the app model: which conversation is shown, how a link or a row opens one (the Watch column rule, C6), the sign-in sheet, Cmd+J and
// the quick switcher's Campus rows. The feed itself is `CampusStore` (ConnCore); this file only decides where a conversation goes on screen.
import SwiftUI
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
    var campusSwitcherRows: [CampusConversation] { campus.link == .disabled ? [] : campus.attentionOrder }

    /// Show the sign-in sheet's page.
    func signInToCampus() { campusAuth?.beginSignIn() }

    func closeCampusSignIn() { campusSignInShown = false; campus.kick() }

    var campusTimeText: String? { campus.asOf.map { CampusTime.clock($0) } }
}

enum CampusTime {
    static func clock(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"; return f.string(from: d)
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
