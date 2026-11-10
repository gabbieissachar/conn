// The Reader pane's row of starred sessions: where the stars come from, how a change reaches the row, and the order.
//
// The stars are the reader's. Conn reads its `stars.json` (ConnCore/ReaderStars.swift) and never writes it: starring and
// unstarring stay in the reader's own picker. A star added or removed there reaches the row within a couple of seconds,
// because the file is looked at every 2 s (one `stat`; the file is parsed only when its size or time changed).
// What Conn keeps is the order of the chips (UserDefaults), dragged by the captain.
import SwiftUI
import ConnCore

@MainActor
final class StarredSessions: ObservableObject {
    /// The conversations to show, in the order to show them.
    @Published private(set) var order: [String] = []
    /// The reader's own names for sessions it has seen in a pane (`pane-labels.json`), for stars no agent runs now.
    @Published private(set) var recorded: [String: String] = [:]
    /// Which session ids are one conversation (the reader's glance feed): a column or a star may hold an older id of a conversation than the one Herdr names now.
    private(set) var chains = ReaderChains()

    let starsFile: URL
    let labelsFile: URL
    let glanceFile: URL?
    private var glanceSignature: String?
    private let store: StarOrderStore
    private var stars: [String] = []
    private var starsSignature: String?
    private var labelsSignature: String?
    private var timer: Timer?

    init(starsFile: URL, labelsFile: URL, glanceFile: URL? = nil, store: StarOrderStore) {
        self.starsFile = starsFile; self.labelsFile = labelsFile; self.glanceFile = glanceFile; self.store = store
        refresh()
    }

    /// Look at the files now and then every `interval` seconds.
    func start(interval: TimeInterval = 2) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.refresh() } }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// A file's change marker: size and modification time (the reader replaces the file by rename, so the time moves on a write).
    private static func signature(_ url: URL) -> String {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return "absent" }
        return "\((a[.size] as? NSNumber)?.intValue ?? -1)@\((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
    }

    /// Read what changed. An unreadable stars file leaves the row as it is.
    func refresh() {
        let s = Self.signature(starsFile)
        if s != starsSignature {
            if let list = ReaderStars.read(starsFile) {
                starsSignature = s
                stars = list.map(\.conv)
                let next = StarOrder.arrange(stars: stars, saved: store.order)
                if next != order { order = next }
            }
        }
        if let g = glanceFile {
            let gs = Self.signature(g)
            if gs != glanceSignature {
                glanceSignature = gs
                let next = (try? Data(contentsOf: g)).map(ReaderChains.parse) ?? ReaderChains()
                if next != chains { chains = next; objectWillChange.send() }
            }
        }
        let l = Self.signature(labelsFile)
        if l != labelsSignature {
            labelsSignature = l
            let table = (try? Data(contentsOf: labelsFile)).map(StarLabels.parse) ?? [:]
            if table != recorded { recorded = table }
        }
    }

    /// A drag: `id` takes the place of `target`. The new order is kept at once, so it is there after a relaunch.
    func move(_ id: String, onto target: String) {
        let next = StarOrder.moved(order, id, onto: target)
        guard next != order else { return }
        order = next
        store.order = next
    }

    /// Forget the arranged order (test hook): the chips go back to the order the reader starred them in.
    func resetOrder() {
        store.order = []
        let next = StarOrder.arrange(stars: stars, saved: [])
        if next != order { order = next }
    }

    func label(for conv: String, agentNames: [String: String]) -> String {
        StarLabels.resolve(conv: conv, agentNames: agentNames, recorded: recorded)
    }
}
