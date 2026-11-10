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
    /// The last setup of each column count and the saved presets (ConnCore `WatchSetups`): session ids and order only, kept in Conn's own
    /// settings (`setupsKey`). The layout above is written into it as it changes, so a launch opens on the setup it was left in.
    private(set) var setups: WatchSetups
    /// The columns whose content is hidden (blurred) and the cue a finished turn left on them (ConnCore `WatchAttention`), by session id, kept in Conn's own settings
    /// (`hiddenKey`): session ids and a pending cue only, no text.
    private(set) var attention: WatchAttention
    /// Each column's web view, by the column's id. Made when a column is first shown and let go of when it is closed or Watch ends.
    private(set) var boxes: [Int: WebBox] = [:]
    /// How many times each column was asked to draw attention to itself (the view flashes an outline when it changes).
    @Published private(set) var flashes: [Int: Int] = [:]
    /// How many times a Campus column (by its session key) was asked to land on its newest reply, which its own view does (a reader column's web view is landed from here).
    @Published private(set) var lands: [String: Int] = [:]
    /// What the app knows of a session now: the agent's state for a reader session, the conversation's for a Campus one; nil when there is no signal (no agent, Campus
    /// signed out). The app sets it. Hidden columns watch it for the end of a turn.
    var stateOf: (String) -> AgentState? = { _ in nil }
    /// The clock the cue's settling reads (a check moves it).
    var now: () -> Date = { Date() }
    private var settleWork: DispatchWorkItem?
    /// Columns being landed on their newest reply: their blur stays until the page has moved.
    private var landing: Set<Int> = []

    /// THE ONE SWITCH for the turn an open ask sits on: given a session id, the id of the turn that asks (the reader's turn id, which
    /// the lite page takes as `#s=<session>&m=<turn id>` and scrolls to and outlines), or nil when the session has no open ask. Until
    /// the asks data is wired in (the agent rows' open-ask records carry it, reader glance feed `ask.uid`), nothing is known and
    /// every session opens at its newest turn. Assign this to change that; nothing else needs to know.
    var openAskTurnID: (String) -> String? = { _ in nil }

    /// A Cmd-click on a session link in a column: leave Watch and show the normal reader on that session. The app sets it (it owns the
    /// view); until it does a Cmd-click opens the session in a column like a plain click.
    var onOpenInReader: ((String, String?) -> Void)?

    /// A link to a Campus conversation was clicked in a Herdr column (kind, folder, id, Cmd held, the column's index). The app decides: the column rule, or the
    /// normal view for a Cmd-click.
    var onOpenCampusLink: ((String, String, String, Bool, Int) -> Void)?

    /// True while Watch is on. Columns only have web views then: the views of a Watch that just ended may draw once more and must
    /// not make them again.
    var active = false

    /// Says whether a session no longer exists, so a remembered column that holds it is left free for the normal fill rule instead of
    /// showing nothing. The app sets it (a Campus conversation the feed no longer lists; an id the lite page could not open).
    var isGone: (String) -> Bool = { WatchSetup.isGone($0, campusKnown: false, campusHas: { _ in true }) }

    private let hub: WebHub
    private let defaults: UserDefaults
    static let countKey = "conn.watch.columns"
    static let setupsKey = "conn.watch.setups"
    static let hiddenKey = "conn.watch.hidden"

    init(hub: WebHub, defaults: UserDefaults) {
        self.hub = hub
        self.defaults = defaults
        let saved = defaults.object(forKey: WatchModel.countKey) as? Int ?? WatchLayout.defaultCount
        setups = WatchSetups.decode(defaults.data(forKey: WatchModel.setupsKey))
        attention = WatchAttention.decode(defaults.data(forKey: WatchModel.hiddenKey))
        // A launch opens on the last setup of the count it was left on. Which sessions still exist is asked when Watch turns on.
        if let last = setups.last(forCount: WatchLayout.clamped(saved)), !last.isEmpty { layout = WatchLayout(restoring: last) } else { layout = WatchLayout(count: saved) }
    }

    /// Write what the columns hold now as the last setup of their count, and keep it (a no-op when nothing changed).
    private func layoutChanged() {
        defaults.set(layout.count, forKey: WatchModel.countKey)
        if setups.remember(layout.setup) { persistSetups() }
        // A session that is no longer in a column is no longer hidden; every page takes the hidden state of the session it shows now.
        if attention.keep(only: Set(layout.sessions)) { persistAttention() }
        syncHidden()
    }

    private func persistAttention() {
        if let d = attention.encoded() { defaults.set(d, forKey: WatchModel.hiddenKey) }
    }

    private func syncHidden() {
        for c in layout.slots.compactMap({ $0 }) where !landing.contains(c.id) { boxes[c.id]?.setContentHidden(attention.isHidden(c.session)) }
    }

    private func persistSetups() {
        if let d = setups.encoded() { defaults.set(d, forKey: WatchModel.setupsKey) }
    }

    var count: Int { layout.count }

    // MARK: what the views read

    /// The web view of a column, made now if the column has none yet (a column filled when Watch turned on). A column that is no
    /// longer in the layout (a view still drawing its last frame as it goes away) gets none: it must not bring its web view back.
    func box(for column: WatchColumn) -> WebBox? {
        if CampusColumn.isCampus(column.session) { return nil }       // a Campus column draws the transcript itself: it has no web view
        if let b = boxes[column.id] { return b }
        guard active, layout.slots.contains(where: { $0?.id == column.id }) else { return nil }
        return makeBox(column, message: nil)
    }

    private func makeBox(_ column: WatchColumn, message: String?) -> WebBox {
        let b = hub.makeLiteBox(startFragment: WatchAddress.fragment(session: column.session, message: message))
        b.setContentHidden(attention.isHidden(column.session))
        let id = column.id
        b.onUse = { [weak self] in self?.used(columnID: id) }
        b.onSessionLink = { [weak self] session, message, inReader in self?.sessionLinkClicked(columnID: id, session: session, message: message, inReader: inReader) }
        b.onCampusLink = { [weak self] kind, folder, cid, command in
            guard let self = self, self.active, let i = self.columnIndex(id: id) else { return }
            self.used(columnID: id)
            self.onOpenCampusLink?(kind, folder, cid, command, i)
        }
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
    /// never the one replaced. `message` is a reply the caller wants the column to land on (a link that names one): it wins over the
    /// asking turn, and a session that already has a column scrolls to it there too.
    @discardableResult
    func open(session: String, from clicked: Int? = nil, message: String? = nil) -> WatchPlacement? {
        guard WatchAddress.validSession(session) else { return nil }
        let ask = message.flatMap { WatchAddress.validTurn($0) ? $0 : nil } ?? openAskTurnID(session)
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
        layoutChanged()
        objectWillChange.send()
        return placement
    }

    /// Show a Campus conversation in a column, by the same rule as a reader session: one that already has a column keeps it (and the column flashes), else a
    /// free column, else the least recently used one other than the column a link was clicked in. A Campus column has no web view, so a column that
    /// changes to or from one gains or loses its view here.
    @discardableResult
    func openCampus(_ id: String, from clicked: Int? = nil) -> WatchPlacement {
        let placement = layout.open(CampusColumn.key(id), from: clicked)
        let column = layout.slots[placement.column]!
        if case .replaced = placement { dropBox(column.id) }
        flashes[column.id, default: 0] += 1
        layoutChanged()
        objectWillChange.send()
        return placement
    }

    /// A session link in a column was clicked (the column's page did not navigate; see `WebBox.sessionLinkWatch`). A plain click opens
    /// the session by the column rule, as every other way of choosing one does, except that the clicked column is never the one
    /// replaced. A link that names a reply (`message`) lands the column on that exact reply. A Cmd-click leaves Watch for the normal reader on
    /// that session and reply (`onOpenInReader`). Returns where the session went, or nil for a Cmd-click, a column that is gone, or a session
    /// the page could not open.
    @discardableResult
    func sessionLinkClicked(columnID: Int, session: String, message: String? = nil, inReader: Bool) -> WatchPlacement? {
        guard active, let index = columnIndex(id: columnID) else { return nil }
        if inReader, let toReader = onOpenInReader { used(columnID: columnID); toReader(session, message); return nil }
        return open(session: session, from: index, message: message)
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
        layoutChanged()
        objectWillChange.send()
    }

    /// What `setCount` did.
    struct CountChange {
        /// The count went up.
        var grew = false
        /// The new count's own last setup was put back (otherwise the columns were added or closed as before).
        var restored = false
        /// Sessions of that setup that no longer exist: their columns are free.
        var gone: [String] = []
    }

    /// Choose how many columns there are (2 to 4). The setup being left is kept as that count's last one; the new count opens on its
    /// own last setup when it has one (a session that no longer exists leaves its column free), and otherwise as it always did: more
    /// columns add free ones on the right, fewer keep the most recently used sessions.
    @discardableResult
    func setCount(_ n: Int) -> CountChange {
        let target = WatchLayout.clamped(n)
        let before = layout.count
        var change = CountChange()
        if target != before {
            if setups.remember(layout.setup) { persistSetups() }
            if let last = setups.last(forCount: target), !last.isEmpty {
                change.gone = layout.apply(last, isGone: isGone)
                change.restored = true
            } else {
                layout.setCount(target)
            }
        }
        dropDeadBoxes()
        layoutChanged()
        objectWillChange.send()
        change.grew = layout.count > before
        return change
    }

    /// Make the columns exactly this setup (a preset): the count and every column. Returns the sessions that no longer exist.
    @discardableResult
    func apply(_ setup: WatchSetup) -> [String] {
        let gone = layout.apply(setup, isGone: isGone)
        dropDeadBoxes()
        layoutChanged()
        objectWillChange.send()
        return gone
    }

    /// Free the columns whose session no longer exists (a remembered setup read when Watch turns on). Returns those sessions.
    @discardableResult
    func pruneGone() -> [String] {
        var gone: [String] = []
        for i in layout.slots.indices {
            if let c = layout.slots[i], isGone(c.session) { gone.append(c.session); layout.close(i); dropBox(c.id) }
        }
        if !gone.isEmpty { layoutChanged(); objectWillChange.send() }
        return gone
    }

    private func dropDeadBoxes() {
        let alive = Set(layout.slots.compactMap { $0?.id })
        for id in boxes.keys where !alive.contains(id) { dropBox(id) }
    }

    // MARK: focus: hiding a column's content, and the cue

    func isHidden(_ column: WatchColumn) -> Bool { attention.isHidden(column.session) }
    func cue(_ column: WatchColumn) -> WatchCue? { attention.cue(for: column.session) }
    func cueTime(_ column: WatchColumn) -> Date? { attention.cueTime(for: column.session) }
    var hiddenCount: Int { layout.slots.compactMap { $0 }.filter { attention.isHidden($0.session) }.count }

    /// Hide the content of a column (blur it, so it does not pull the eye), or show it again by the same control. Showing a column that holds a cue lands it on the
    /// reply the finished turn ended with. Returns whether the column is hidden now (nil: no such column).
    @discardableResult
    func toggleHidden(column index: Int) -> Bool? {
        guard layout.slots.indices.contains(index), let column = layout.slots[index] else { return nil }
        if attention.isHidden(column.session) {
            let cue = attention.show(column.session)
            persistAttention()
            reveal(column, landing: cue != nil)
            armSettle()
            objectWillChange.send()
            return false
        }
        attention.hide(column.session, state: stateOf(column.session))
        persistAttention()
        if !CampusColumn.isCampus(column.session) { boxes[column.id]?.setContentHidden(true) }
        armSettle()
        objectWillChange.send()
        return true
    }

    /// This column is the only one on screen: it is shown and every other column holds a hidden state (and there is another column to hide).
    func isFocused(column index: Int) -> Bool {
        guard layout.slots.indices.contains(index), let me = layout.slots[index] else { return false }
        let others = layout.slots.enumerated().filter { $0.offset != index }.compactMap { $0.element }
        return !others.isEmpty && !attention.isHidden(me.session) && others.allSatisfy { attention.isHidden($0.session) }
    }

    /// Put this column on its own: hide every other column (the same hide as the eye button, so each keeps its cue rules and is kept across a quit) and show this one. Pressed again while
    /// it is the only one on screen, it shows the others again (a cue a hidden column holds lands it on that turn's last reply, as showing it by hand does). Returns whether this column
    /// is on its own now; nil when there is nothing to hide (a single column, or no such column).
    @discardableResult
    func focusColumn(_ index: Int) -> Bool? {
        guard layout.slots.indices.contains(index), let me = layout.slots[index] else { return nil }
        let others = layout.slots.enumerated().filter { $0.offset != index && $0.element != nil }.map(\.offset)
        guard !others.isEmpty else { return nil }
        if isFocused(column: index) {
            for i in others where layout.slots[i].map({ attention.isHidden($0.session) }) ?? false { toggleHidden(column: i) }
            return false
        }
        for i in others where !(layout.slots[i].map({ attention.isHidden($0.session) }) ?? true) { toggleHidden(column: i) }
        if attention.isHidden(me.session) { toggleHidden(column: index) }
        return true
    }

    private func reveal(_ column: WatchColumn, landing land: Bool) {
        if CampusColumn.isCampus(column.session) { if land { lands[column.session, default: 0] += 1 }; return }
        guard let b = boxes[column.id] else { return }      // Watch is off: the page is made hidden or shown by what the session holds when Watch turns on
        guard land else { b.setContentHidden(false); return }
        let id = column.id
        landing.insert(id)
        b.landOnLastReply(session: column.session) { [weak self, weak b] in
            self?.landing.remove(id)
            b?.setContentHidden(self?.attention.isHidden(column.session) ?? false)
        }
    }

    /// Look at the hidden sessions' states (the app calls this when the agents' or Campus's states may have changed): a turn that has ended raises the cue.
    func observeStates() {
        guard !attention.isEmpty else { return }
        let t = now()
        var raised: [String] = []
        for s in attention.holds.keys.sorted() where attention.observe(s, state: stateOf(s), now: t) { raised.append(s) }
        cuesRaised(raised)
        armSettle()
    }

    private func cuesRaised(_ sessions: [String]) {
        guard !sessions.isEmpty else { return }
        for s in sessions { if let i = layout.index(of: s), let c = layout.slots[i] { flashes[c.id, default: 0] += 1 } }
        persistAttention()
        objectWillChange.send()
    }

    /// A session that stopped working is looked at again once it has stayed stopped long enough to count as the end of its turn.
    private func armSettle() {
        settleWork?.cancel(); settleWork = nil
        guard let due = attention.nextSettle else { return }
        let w = DispatchWorkItem { [weak self] in self?.observeStates() }
        settleWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.05, due.timeIntervalSince(now()) + 0.05), execute: w)
    }

    // MARK: presets

    func savePreset(name: String) -> WatchSetups.SaveResult {
        let r = setups.savePreset(name: name, setup: layout.setup)
        if case .refused = r { return r }
        persistSetups(); objectWillChange.send()
        return r
    }

    func renamePreset(id: String, to name: String) -> WatchSetups.Refusal? {
        let r = setups.renamePreset(id: id, to: name)
        if r == nil { persistSetups(); objectWillChange.send() }
        return r
    }

    @discardableResult
    func deletePreset(id: String) -> Bool {
        guard setups.deletePreset(id: id) else { return false }
        persistSetups(); objectWillChange.send()
        return true
    }

    /// Forget every remembered setup and preset and empty the columns (the count stays as it is): a check's clean start.
    func forgetEverything() {
        setups = WatchSetups()
        defaults.removeObject(forKey: WatchModel.setupsKey)
        emptyColumns()
    }

    /// Close every column (the presets and the other counts' setups stay).
    func emptyColumns() {
        for i in layout.slots.indices { layout.close(i) }
        dropDeadBoxes()
        layoutChanged()
        objectWillChange.send()
    }

    /// Fill the free columns when Watch turns on, or when there are more columns: the first candidate is the one on screen.
    func fill(with candidates: [String]) {
        layout.fill(with: candidates.filter { WatchAddress.validSession($0) || CampusColumn.isCampus($0) })
        layoutChanged()
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
