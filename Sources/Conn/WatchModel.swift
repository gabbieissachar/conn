// The Watch view's state: which session is in which column, and the web view of each column.
//
// Watch shows 2 to 4 conversations side by side, each on the reader's lite page (one conversation per page, never the full
// reader). The placement rule is `WatchLayout` (ConnCore); this class owns the web views that go with it and what the rule's
// outcome does to them. A column keeps its web view when another session replaces the one it shows, so the other columns are
// never touched by a replacement.
import SwiftUI
import ConnCore

@MainActor
final class WatchModel: ObservableObject {
    /// The columns. Changes that matter to the view (open, close, count) publish; a column being used does not, because it only
    /// moves a counter that no view draws.
    private(set) var layout: WatchLayout
    /// Each column's web view, by the column's id. Made when a column is first shown and let go of when it is closed or Watch ends.
    private(set) var boxes: [Int: WebBox] = [:]
    /// How many times each column was asked to draw attention to itself (the view flashes an outline when it changes).
    @Published private(set) var flashes: [Int: Int] = [:]

    /// THE ONE SWITCH for the turn an open ask sits on: given a session id, the id of the turn that asks (the reader's turn id, which
    /// the lite page takes as `#s=<session>&m=<turn id>` and scrolls to and outlines), or nil when the session has no open ask. Until
    /// the asks data is wired in (the agent rows' open-ask records carry it, reader glance feed `ask.uid`), nothing is known and
    /// every session opens at its newest turn. Assign this to change that; nothing else needs to know.
    var openAskTurnID: (String) -> String? = { _ in nil }

    /// A Cmd-click on a session link in a column: leave Watch and show the normal reader on that session. The app sets it (it owns the
    /// view); until it does a Cmd-click opens the session in a column like a plain click.
    var onOpenInReader: ((String) -> Void)?

    /// True while Watch is on. Columns only have web views then: the views of a Watch that just ended may draw once more and must
    /// not make them again.
    var active = false

    private let hub: WebHub
    private let defaults: UserDefaults
    static let countKey = "conn.watch.columns"

    init(hub: WebHub, defaults: UserDefaults) {
        self.hub = hub
        self.defaults = defaults
        let saved = defaults.object(forKey: WatchModel.countKey) as? Int ?? WatchLayout.defaultCount
        layout = WatchLayout(count: saved)
    }

    var count: Int { layout.count }

    // MARK: what the views read

    /// The web view of a column, made now if the column has none yet (a column filled when Watch turned on). A column that is no
    /// longer in the layout (a view still drawing its last frame as it goes away) gets none: it must not bring its web view back.
    func box(for column: WatchColumn) -> WebBox? {
        if let b = boxes[column.id] { return b }
        guard active, layout.slots.contains(where: { $0?.id == column.id }) else { return nil }
        return makeBox(column, message: nil)
    }

    private func makeBox(_ column: WatchColumn, message: String?) -> WebBox {
        let b = hub.makeLiteBox(startFragment: WatchAddress.fragment(session: column.session, message: message))
        let id = column.id
        b.onUse = { [weak self] in self?.used(columnID: id) }
        b.onSessionLink = { [weak self] session, inReader in self?.sessionLinkClicked(columnID: id, session: session, inReader: inReader) }
        boxes[column.id] = b
        return b
    }

    func columnIndex(id: Int) -> Int? { layout.slots.firstIndex { $0?.id == id } }

    // MARK: the placement rule at work

    /// Show a session: the column rule. A session already shown keeps its column (and, with an open ask, scrolls to the asking reply
    /// there); otherwise it takes a free column, otherwise the least recently used one, in place. Other columns are not touched.
    /// Every outcome flashes the column once, so the person sees where it went. Nil when the id is not one the page could open.
    ///
    /// `from` is the index of the column a session link was clicked in (see `sessionLinkClicked`): that column counts as used and is
    /// never the one replaced.
    @discardableResult
    func open(session: String, from clicked: Int? = nil) -> WatchPlacement? {
        guard WatchAddress.validSession(session) else { return nil }
        let ask = openAskTurnID(session)
        let placement = layout.open(session, from: clicked)
        let column = layout.slots[placement.column]!
        switch placement {
        case .alreadyOpen:
            // Only the address changes: the page follows it in place, so the column keeps its place in every other respect.
            if let ask = ask { boxes[column.id]?.showConversation(column.session, message: ask, reload: false) }
        case .freeSlot:
            _ = makeBox(column, message: ask)
        case .replaced:
            // The same column and web view, loaded again on the new session, so the old conversation does not stay in memory.
            if let b = boxes[column.id] { b.showConversation(column.session, message: ask, reload: true) } else { _ = makeBox(column, message: ask) }
        }
        flashes[column.id, default: 0] += 1
        objectWillChange.send()
        return placement
    }

    /// A session link in a column was clicked (the column's page did not navigate; see `WebBox.sessionLinkWatch`). A plain click opens
    /// the session by the column rule, as every other way of choosing one does, except that the clicked column is never the one
    /// replaced. A Cmd-click leaves Watch for the normal reader on that session (`onOpenInReader`). Returns where the session went, or
    /// nil for a Cmd-click, a column that is gone, or a session the page could not open.
    @discardableResult
    func sessionLinkClicked(columnID: Int, session: String, inReader: Bool) -> WatchPlacement? {
        guard active, let index = columnIndex(id: columnID) else { return nil }
        if inReader, let toReader = onOpenInReader { used(columnID: columnID); toReader(session); return nil }
        return open(session: session, from: index)
    }

    /// The person used the column (the page reported a click, scroll, key or focus).
    func used(columnID: Int) {
        guard let i = columnIndex(id: columnID) else { return }
        layout.touch(i)
    }

    func close(column index: Int) {
        guard let id = layout.slots.indices.contains(index) ? layout.slots[index]?.id : nil else { return }
        layout.close(index)
        dropBox(id)
        objectWillChange.send()
    }

    @discardableResult
    func setCount(_ n: Int) -> Bool {
        let before = layout.count
        layout.setCount(n)
        defaults.set(layout.count, forKey: WatchModel.countKey)
        let alive = Set(layout.slots.compactMap { $0?.id })
        for id in boxes.keys where !alive.contains(id) { dropBox(id) }
        objectWillChange.send()
        return layout.count > before
    }

    /// Fill the free columns when Watch turns on, or when there are more columns: the first candidate is the one on screen.
    func fill(with candidates: [String]) {
        layout.fill(with: candidates.filter(WatchAddress.validSession))
        objectWillChange.send()
    }

    private func dropBox(_ id: Int) {
        boxes.removeValue(forKey: id)?.release()
    }

    /// Watch ended: every column's web view goes (the sessions stay, so Watch opens on the same ones next time).
    func unload() {
        for b in boxes.values { b.release() }
        boxes = [:]
        objectWillChange.send()
    }

    func reloadAll() { boxes.values.forEach { $0.reload() } }
}
