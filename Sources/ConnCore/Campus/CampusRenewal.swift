// The silent Campus session refresh (decision J7=a). Campus's `campus_session` cookie is an HttpOnly Google ID token that lives 3600 seconds; a page
// reload does not renew it. About five minutes before it ends, Conn loads Campus's own sign-in path in a hidden web view that shares its cookie store: if
// Google and Campus finish the sign-in on their own, the session carries on; if any page wants a click, an account choice or a password, Conn stops at once
// and the CAMPUS section says "sign in again".
//
// This file is the part with no web view in it, so it is tested over a stand-in Campus: reading a token's expiry, deciding when to try, deciding what an
// attempt came to, the log of attempts, and the keeper that runs the loop. The web view itself is `CampusSilentRenewal` (Conn target, behind `CampusRenewing`).
// Nothing here logs, prints, stores or copies a token or a cookie value: the expiry (a date) is all that is kept.
import Foundation

/// What a hidden sign-in attempt came to.
public enum CampusRenewalOutcome: String, Codable, Equatable, Sendable {
    /// Back on Campus, signed in, with a later expiry.
    case renewed
    /// A page that needs the person (Google waiting for input, Campus's own login page), or Campus without a later expiry: only a sign-in can go on from here.
    case needsSignIn = "needs-sign-in"
    /// Nothing settled within the time limit.
    case timeout = "time-out"
    /// The load failed.
    case error
    /// Campus's sign-in path answered a 403 (the network refused the connection: off the company private network). Not a page that needs the person, so not "sign in again".
    case blocked

    /// The words Settings uses.
    public var label: String {
        switch self {
        case .renewed: return "renewed"
        case .needsSignIn: return "needs sign-in"
        case .timeout: return "timed out"
        case .error: return "failed"
        case .blocked: return "blocked by the network"
        }
    }
}

/// Where a hidden attempt stood still.
public enum CampusRenewalPage: String, Equatable, Sendable {
    /// A page of Campus's own origin that is not its login (the app).
    case campus
    /// Campus's own login page, which waits for a click on "Sign in".
    case login
    /// Another site (Google's account chooser or password page, say).
    case elsewhere
}

/// The pure rules.
public enum CampusRenewalRules {
    /// A page: the host decides first, then the path (`/campus/login...` and `/login...` are Campus's sign-in).
    public static func page(for url: URL, campusHost: String) -> CampusRenewalPage {
        guard let host = url.host?.lowercased(), host == campusHost.lowercased() else { return .elsewhere }
        let parts = url.path.lowercased().split(separator: "/").map(String.init)
        if let i = parts.firstIndex(of: "login"), i <= 1 { return .login }
        return .campus
    }

    /// What the attempt came to. `settled` is the page the hidden view stood still on (nil: it never settled).
    /// Success needs all of: it failed to load nowhere, it did not run out of time, it stood on Campus (not its login page, not another site) and the session
    /// now ends later than it did.
    public static func outcome(settled: CampusRenewalPage?, timedOut: Bool, failed: Bool, blocked: Bool = false, oldExpiry: Date?, newExpiry: Date?) -> CampusRenewalOutcome {
        if blocked { return .blocked }
        if failed { return .error }
        if timedOut { return .timeout }
        switch settled {
        case .none: return .error
        case .some(.elsewhere), .some(.login): return .needsSignIn
        case .some(.campus):
            guard let new = newExpiry else { return .needsSignIn }
            if let old = oldExpiry, new <= old { return .needsSignIn }
            return .renewed
        }
    }
}

/// A token's expiry. The token is read in memory by the one caller that has it and dropped; nothing here keeps or prints it.
public enum CampusSessionToken {
    /// The `exp` of a JWT's payload (seconds since 1970), or nil when the text is not a JWT with one.
    public static func expiry(of token: String) -> Date? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let payload = decode(String(parts[1])),
              let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let exp = (object["exp"] as? NSNumber)?.doubleValue, exp > 0, exp.isFinite else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    private static func decode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}

/// One attempt, as it is logged. No token and no cookie value: dates and a word.
public struct CampusRenewalAttempt: Equatable, Codable, Sendable {
    public var at: Date
    public var oldExpiry: Date?
    public var newExpiry: Date?
    public var outcome: CampusRenewalOutcome
    public init(at: Date, oldExpiry: Date?, newExpiry: Date?, outcome: CampusRenewalOutcome) { self.at = at; self.oldExpiry = oldExpiry; self.newExpiry = newExpiry; self.outcome = outcome }
}

/// When to try. A value: the keeper asks it.
public struct CampusRenewalPlanner: Equatable, Sendable {
    /// Seconds before the expiry the first attempt is made.
    public var lead: TimeInterval = 300
    /// Seconds before another try after a time-out or a failed load.
    public var retryAfter: TimeInterval = 60
    /// Time-outs, blocked answers and failed loads allowed for one expiry; a needs-sign-in answer is never tried again for the same expiry.
    public var maxAttempts = 3
    public init(lead: TimeInterval = 300, retryAfter: TimeInterval = 60, maxAttempts: Int = 3) { self.lead = lead; self.retryAfter = retryAfter; self.maxAttempts = maxAttempts }

    public enum Plan: Equatable, Sendable {
        /// Nothing to do: no session, a needs-sign-in answer is waiting for the person, or the tries are used up.
        case idle
        case wait(until: Date)
        case attemptNow
    }

    /// `history`: the attempts already made for this very expiry, oldest first.
    public func next(now: Date, expiry: Date?, history: [CampusRenewalAttempt]) -> Plan {
        guard let expiry = expiry else { return .idle }
        if history.contains(where: { $0.outcome == .needsSignIn }) || history.count >= maxAttempts { return .idle }
        var due = expiry.addingTimeInterval(-lead)
        if let last = history.last { due = max(due, last.at.addingTimeInterval(retryAfter)) }
        return now >= due ? .attemptNow : .wait(until: due)
    }
}

/// A small file of the attempts, one JSON line each, newest last: dates and outcomes only. Trimmed (by writing a new file over the old one) once it passes a size.
public final class CampusRenewalLog: @unchecked Sendable {
    public let file: URL
    public static let keep = 200
    private let lock = NSLock()
    public init(file: URL) { self.file = file }

    private static var encoder: JSONEncoder { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; e.outputFormatting = [.sortedKeys]; return e }
    private static var decoder: JSONDecoder { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }

    public func append(_ a: CampusRenewalAttempt) {
        lock.lock(); defer { lock.unlock() }
        guard let line = try? Self.encoder.encode(a) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var all = readLocked()
        all.append(a)
        if all.count > Self.keep * 2 {
            // Past twice the cap: write the newest ones as a new file in the old one's place.
            let text = all.suffix(Self.keep).compactMap { try? Self.encoder.encode($0) }.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n") + "\n"
            try? Data(text.utf8).write(to: file, options: .atomic)
            return
        }
        if let h = try? FileHandle(forWritingTo: file) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: line + Data("\n".utf8))
        } else {
            try? (line + Data("\n".utf8)).write(to: file, options: .atomic)
        }
    }

    public func recent(_ limit: Int = 20) -> [CampusRenewalAttempt] {
        lock.lock(); defer { lock.unlock() }
        return Array(readLocked().suffix(limit))
    }

    private func readLocked() -> [CampusRenewalAttempt] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return String(decoding: data, as: UTF8.self).split(separator: "\n").compactMap { try? Self.decoder.decode(CampusRenewalAttempt.self, from: Data($0.utf8)) }
    }
}

/// How the hidden attempt ended, as the web side reports it (the decision is `CampusRenewalRules.outcome`).
public struct CampusRenewalResult: Equatable, Sendable {
    public var settled: CampusRenewalPage?
    public var timedOut: Bool
    public var failed: Bool
    /// The sign-in path answered 403: the network refused the connection (a 403 page is never read as "sign in again").
    public var blocked: Bool
    public init(settled: CampusRenewalPage? = nil, timedOut: Bool = false, failed: Bool = false, blocked: Bool = false) { self.settled = settled; self.timedOut = timedOut; self.failed = failed; self.blocked = blocked }
}

/// The web side of the refresh: the session's expiry as the cookie store has it, and one hidden attempt. An implementation never clicks, types, injects script
/// into, or answers a page or a prompt, and gives up at once on any page that waits for the person.
@MainActor
public protocol CampusRenewing: AnyObject {
    /// When the session ends, from the cookie store (the token's `exp`, else the cookie's own expiry); nil when there is no session cookie.
    func sessionExpiry() async -> Date?
    /// Load Campus's sign-in path hidden and report where it stood still. Gives up after `timeout` seconds.
    func attemptRenewal(timeout: TimeInterval) async -> CampusRenewalResult
}

/// Keeps the session alive: reads the expiry, tries once `lead` seconds before it ends, records each try, and says when only a sign-in will do.
@MainActor
public final class CampusSessionKeeper: ObservableObject {
    /// When the session ends (nil: no session cookie).
    @Published public private(set) var expiry: Date?
    /// The last attempt made (this run, else the last one in the log).
    @Published public private(set) var lastAttempt: CampusRenewalAttempt?
    /// A hidden attempt is under way.
    @Published public private(set) var attempting = false
    /// The last attempt for the current expiry said only a sign-in can go on, and the session has not changed since. Clears by itself when a new sign-in moves the expiry.
    @Published public private(set) var needsSignIn = false

    public var planner: CampusRenewalPlanner
    /// Seconds one hidden attempt may take.
    public var attemptTimeout: TimeInterval = 25
    /// How often the cookie store is read when nothing else wakes the loop.
    public var pollInterval: TimeInterval = 20
    /// While true no attempt starts (a sign-in sheet is on screen and the person is signing in by hand).
    public var paused = false

    private let renewer: CampusRenewing
    /// The attempts' log (nil: none is kept).
    public let log: CampusRenewalLog?
    private let now: () -> Date
    private var attempts: [CampusRenewalAttempt] = []
    private var task: Task<Void, Never>?
    private var nudged = false
    public private(set) var attemptCount = 0

    public init(renewer: CampusRenewing, log: CampusRenewalLog?, planner: CampusRenewalPlanner = CampusRenewalPlanner(), now: @escaping () -> Date = Date.init) {
        self.renewer = renewer; self.log = log; self.planner = planner; self.now = now
        lastAttempt = log?.recent(1).last
    }

    public func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.loop() }
    }

    public func stop() { task?.cancel(); task = nil }

    /// Read the cookie store again now (a sign-in just finished, a window came back).
    public func nudge() { nudged = true }

    private func loop() async {
        while !Task.isCancelled {
            nudged = false
            let wait = await tick()
            var slept: TimeInterval = 0
            while slept < wait, !nudged, !Task.isCancelled { try? await Task.sleep(nanoseconds: 50_000_000); slept += 0.05 }
        }
    }

    /// One look: read the expiry, try when it is due. Returns how long to wait before the next look.
    @discardableResult
    public func tick() async -> TimeInterval {
        let exp = await renewer.sessionExpiry()
        if exp != expiry { expiry = exp }
        refreshNeedsSignIn()
        if paused { return min(pollInterval, 1) }
        switch planner.next(now: now(), expiry: expiry, history: attemptsForCurrentExpiry()) {
        case .idle: return pollInterval
        case .wait(let until): return max(0.05, min(pollInterval, until.timeIntervalSince(now())))
        case .attemptNow:
            await attempt()
            return 0.05
        }
    }

    private func attemptsForCurrentExpiry() -> [CampusRenewalAttempt] { attempts.filter { $0.oldExpiry == expiry } }

    private func refreshNeedsSignIn() {
        let v = attemptsForCurrentExpiry().last?.outcome == .needsSignIn
        if v != needsSignIn { needsSignIn = v }
    }

    /// One hidden attempt, now. Records it in the log and in memory.
    public func attempt() async {
        guard !attempting else { return }
        attempting = true
        attemptCount += 1
        let old = await renewer.sessionExpiry()
        let result = await renewer.attemptRenewal(timeout: attemptTimeout)
        let new = await renewer.sessionExpiry()
        let outcome = CampusRenewalRules.outcome(settled: result.settled, timedOut: result.timedOut, failed: result.failed, blocked: result.blocked, oldExpiry: old, newExpiry: new)
        let a = CampusRenewalAttempt(at: now(), oldExpiry: old, newExpiry: new, outcome: outcome)
        attempts.append(a)
        if attempts.count > 50 { attempts.removeFirst(attempts.count - 50) }
        log?.append(a)
        lastAttempt = a
        if new != expiry { expiry = new }
        attempting = false
        refreshNeedsSignIn()
    }
}


/// Which cookies belong to Campus's sign-in when Conn moves the session to a new website data store (the store it leaves may also hold other pages' cookies).
/// Only a cookie's domain is looked at, never its name or value.
public enum CampusCookieScope {
    /// Campus's own host or a parent domain of it (written with or without the leading dot).
    public static func isCampus(domain: String, campusHost: String) -> Bool {
        let d = domain.lowercased().drop { $0 == "." }
        let host = campusHost.lowercased()
        return !d.isEmpty && (host == d || host.hasSuffix("." + d))
    }
    /// Campus's own host, and no parent domain: what Conn takes out of a shared store once Campus has moved (a parent domain's cookies serve other sites too).
    public static func isExactly(domain: String, campusHost: String) -> Bool {
        let d = domain.lowercased().drop { $0 == "." }
        return !d.isEmpty && d == campusHost.lowercased()
    }
    /// Google's own domains, whose sign-in the silent refresh rides on.
    public static func isGoogle(domain: String) -> Bool {
        let d = domain.lowercased().drop { $0 == "." }
        return d == "google.com" || d.hasSuffix(".google.com")
    }
    /// Carried over from a shared store: Campus's and Google's.
    public static func carriesSignIn(domain: String, campusHost: String) -> Bool { isCampus(domain: domain, campusHost: campusHost) || isGoogle(domain: domain) }
}
