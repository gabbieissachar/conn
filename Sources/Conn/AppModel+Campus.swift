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
