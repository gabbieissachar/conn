// The open asks on the agent rows: where they come from and how often Conn looks.
//
// The transcript reader answers `GET /api/transcript-reader/open-asks` (ConnCore/OpenAsks.swift has the shape). The route needs
// the reader's per-start token, which only the reader page itself holds, so a live Conn asks from inside its Reader web view
// (WebBox.fetchOpenAsks); a test launch reads a file or another address instead. Conn asks every 5 seconds, the same beat as the
// footprint line, only while the window is on screen and the app is in use; coming back to the app asks at once. One question is
// in flight at a time and it is cut off after 4 seconds, so a slow reader never queues work. The reader does the parsing on its
// side, so the poll is one small answer, not a page.
//
// If the reader is down or has no such endpoint (an older reader answers 404), the rows show no asks and nothing else
// changes. One failed answer is forgiven (the rows keep what they had for one more beat), so a reader restart or a slow
// answer does not make the rows jump twice.
//
// The captain's choice to see asks older than 24 hours lives here too (it is not remembered across launches: the list is
// meant to start on what is fresh).
//
// So does the read state: an ask the captain clicked (or marked) is read, hidden from the list and not counted until it is marked
// unread again ("show N read" brings the read ones back, muted). It is Conn's own record, kept in the app's preferences by
// `OpenAsk.readKey` (the pane and the asking turn), so a new ask on the same pane shows as unread.
import SwiftUI
import ConnCore

@MainActor
final class OpenAskStore: ObservableObject {
    @Published private(set) var asks: OpenAsks = .none
    /// "show N older" is on: asks over 24 hours are listed too.
    @Published var showOlder = false
    /// "show N read" is on: asks already read are listed too, muted.
    @Published var showRead = false
    /// The asks marked read (see `OpenAsk.readKey`); persisted when `defaults` was given.
    @Published private(set) var read: AskReadState
    private let defaults: UserDefaults?
    private let readKey: String
    /// When the asks were last judged against the clock. A beat moves it on even when the asks did not change, so the 24 hour
    /// fold and the ages follow the clock.
    @Published private(set) var now = Date()

    /// One question to the reader: the feed, or nil for no good answer. nil source: nothing to ask (no polling).
    typealias Source = @MainActor @Sendable () async -> OpenAsksFeed?
    private let source: Source?
    private var state: OpenAsksState
    private var timer: Timer?
    private var inFlight = false
    private(set) var polls = 0
    private(set) var lastAnswerGood: Bool?

    /// `herdrSession` is the Herdr session name Conn is attached to: an ask for another one is not ours.
    init(source: Source?, herdrSession: String? = nil, rebaseToNow: Bool = false, defaults: UserDefaults? = nil, readKey: String = "conn.asks.read") {
        self.source = source
        self.defaults = defaults
        self.readKey = readKey
        var saved = AskReadState(marked: (defaults?.dictionary(forKey: readKey) as? [String: Double]) ?? [:])
        saved.prune(now: Date())
        read = saved
        state = OpenAsksState(rebaseToNow: rebaseToNow, herdrSession: herdrSession)
    }

    /// Ask an address (an `http` one, or a `file:` one): what a test launch and `CONN_OPEN_ASKS_URL` use.
    convenience init(url: URL?, herdrSession: String? = nil, rebaseToNow: Bool = false, defaults: UserDefaults? = nil, readKey: String = "conn.asks.read") {
        self.init(source: url.map { u in { await OpenAsksSource.fetch(u) } }, herdrSession: herdrSession, rebaseToNow: rebaseToNow, defaults: defaults, readKey: readKey)
    }

    /// Ask now and then every `interval` seconds. `active` says whether anyone is looking (window visible, app in use).
    func start(interval: TimeInterval = 5, active: @escaping @MainActor () -> Bool) {
        timer?.invalidate()
        guard source != nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { if let self = self, active() { self.refresh() } }
        }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// A check holds the polling still while it feeds the store answers by hand (`apply`): a poll that lands in between would put the fixture's asks back and make the step depend on the clock.
    var pollingPaused = false

    func refresh() {
        guard let source = source, !inFlight, !pollingPaused else { return }
        inFlight = true
        polls += 1
        Task { [weak self] in
            let feed = await Self.withTimeout(4, source)
            guard let self = self else { return }
            self.inFlight = false
            self.apply(feed)
        }
    }

    /// The source's answer, or nil if it has not come in `seconds` (a page that is reloading may never answer its script).
    private static func withTimeout(_ seconds: Double, _ source: @escaping Source) async -> OpenAsksFeed? {
        await withTaskGroup(of: OpenAsksFeed?.self) { group in
            group.addTask { await source() }
            group.addTask { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Take one answer (nil for no good answer). Also the entry point for a check.
    func apply(_ feed: OpenAsksFeed?, at date: Date = Date()) {
        lastAnswerGood = feed != nil
        state.apply(feed, at: date)
        now = state.now
        if state.asks != asks { asks = state.asks }
    }

    /// The asks that pass the 24 hour fold, read or not: what a conversation is looked up by (the reader's id for a pane's conversation).
    func listed(now: Date? = nil) -> [String: OpenAsk] { asks.visible(showOlder: showOlder, now: now ?? self.now) }

    /// The unread asks the sidebar counts and orders by.
    func visible(now: Date? = nil) -> [String: OpenAsk] { listed(now: now).filter { !read.isRead($0.value) } }

    /// The asks the rows show: the unread ones, and the read ones too while "show N read" is on.
    func shown(now: Date? = nil) -> [String: OpenAsk] { showRead ? listed(now: now) : visible(now: now) }

    func isRead(_ ask: OpenAsk) -> Bool { read.isRead(ask) }

    /// A click on the ask, or "Mark as Read": gone from the list (unless "show read" is on) and not counted.
    func markRead(_ ask: OpenAsk, at date: Date = Date()) { var r = read; r.markRead(ask, at: date); setRead(r) }
    func markUnread(_ ask: OpenAsk) { var r = read; r.markUnread(ask); setRead(r) }
    /// For a check: forget every read mark.
    func clearRead() { var r = read; r.clear(); setRead(r) }

    private func setRead(_ r: AskReadState) {
        guard r != read else { return }
        read = r
        defaults?.set(r.marked, forKey: readKey)
    }

    /// Asks over 24 hours old that are still unread and live (behind "show N older").
    func olderCount(among agents: [Agent]) -> Int { asks.olderCount(among: agents, now: now, read: read) }
    /// Read asks that are live and not folded as older (behind "show N read").
    func readCount(among agents: [Agent]) -> Int { asks.readCount(among: agents, showOlder: showOlder, now: now, read: read) }
}
