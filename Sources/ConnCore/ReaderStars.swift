// The starred sessions of the transcript reader, as Conn shows them in the Reader pane's header row.
//
// The stars belong to the reader. It keeps them in one small owner-only file (pmos `pinstore.js`):
//   { "version": 1, "rev": 3, "stars": [{ "conv": "<conversation id>", "starred": <epoch seconds> }] }
// beside `pins.json`, in `~/.config/pmos-transcript-reader/stars.json` unless PMOS_READER_STARS names another file.
// Conn only ever reads it. What Conn keeps for itself is the order the chips are shown in (`StarOrderStore`): the reader
// has no order beyond "when it was starred".
import Foundation

public struct ReaderStar: Equatable, Sendable {
    public var conv: String
    public var starred: Double
    public init(conv: String, starred: Double) { self.conv = conv; self.starred = starred }
}

public enum ReaderStars {
    /// The same shape the reader accepts for a conversation id (`CONV_RE` in pinstore.js).
    public static func validConv(_ s: String) -> Bool {
        s.range(of: "^[0-9A-Za-z_-]{1,64}$", options: .regularExpression) != nil
    }

    /// The file a launch reads: `CONN_READER_STARS`, else the reader's default. `env` is a parameter so a test can name its own.
    public static func defaultFile(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> URL {
        if let f = env["CONN_READER_STARS"] ?? env["PMOS_READER_STARS"], !f.isEmpty { return URL(fileURLWithPath: f) }
        return URL(fileURLWithPath: home + "/.config/pmos-transcript-reader/stars.json")
    }

    /// The stars in the file's order (the order they were starred in), or nil when the bytes are not a stars file.
    /// The reader treats a file it cannot read as empty; Conn treats it as "no news" instead, so a half-written or
    /// hand-edited file never blanks the row (the reader writes whole files by rename, so this is only a safety).
    /// An entry that is not a valid star is dropped, and a conversation listed twice counts once.
    public static func parse(_ data: Data) -> [ReaderStar]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              root["rev"] is Int, let list = root["stars"] as? [Any] else { return nil }
        var seen = Set<String>()
        var out: [ReaderStar] = []
        for item in list {
            guard let o = item as? [String: Any], let conv = o["conv"] as? String, validConv(conv),
                  let at = (o["starred"] as? NSNumber)?.doubleValue, at.isFinite, seen.insert(conv).inserted else { continue }
            out.append(ReaderStar(conv: conv, starred: at))
        }
        return out
    }

    /// Read the file. A missing file is "nothing starred" (the reader has not starred anything yet); an unreadable one is nil.
    public static func read(_ file: URL) -> [ReaderStar]? {
        guard let data = try? Data(contentsOf: file) else {
            return FileManager.default.fileExists(atPath: file.path) ? nil : []
        }
        return parse(data)
    }
}

/// How the chips are ordered.
public enum StarOrder {
    /// The order to show: the conversations Conn has an order for first, in that order, then the stars Conn has not seen
    /// before, in the order they were starred. A conversation in `saved` that is no longer starred is skipped but not
    /// forgotten (`saved` is not changed), so a star removed and added back in the reader returns to its place.
    public static func arrange(stars: [String], saved: [String]) -> [String] {
        let have = Set(stars)
        var seen = Set<String>()
        var out: [String] = []
        for id in saved where have.contains(id) && seen.insert(id).inserted { out.append(id) }
        for id in stars where seen.insert(id).inserted { out.append(id) }
        return out
    }

    /// `id` taken out and put back where `target` is: before it when it came from the right, after it when it came from
    /// the left (what a drop on a chip means in a row: the dragged chip takes that chip's place). The order is returned
    /// unchanged for an id or target that is not in it, or when they are the same.
    public static func moved(_ order: [String], _ id: String, onto target: String) -> [String] {
        guard id != target, let from = order.firstIndex(of: id), let to = order.firstIndex(of: target) else { return order }
        var out = order
        out.remove(at: from)
        out.insert(id, at: to)
        return out
    }
}

/// The remembered order, in a `UserDefaults` domain (the app's own, or the test domain in test mode, like the pane zoom).
public struct StarOrderStore {
    public let defaults: UserDefaults
    public let key: String
    public init(defaults: UserDefaults, key: String = "conn.readerStarOrder") { self.defaults = defaults; self.key = key }

    public var order: [String] {
        get { (defaults.array(forKey: key) as? [String] ?? []).filter(ReaderStars.validConv) }
        nonmutating set { defaults.set(newValue, forKey: key) }
    }
}

/// What a star is called on its chip.
public enum StarLabels {
    /// `{ "<session id>": { "label": "...", ... } }`, the reader's own record of the panes it has seen a session in
    /// (`out/pane-labels.json`, written by its page build). Anything else gives an empty table.
    public static func parse(_ data: Data) -> [String: String] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (id, v) in root {
            if let o = v as? [String: Any], let label = (o["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty { out[id] = label }
        }
        return out
    }

    /// The reader's file for a launch: `CONN_READER_LABELS`, else the one in the captain's pmos checkout next to the
    /// reader Conn loads (README "Organizer and reader").
    public static func defaultFile(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> URL {
        if let f = env["CONN_READER_LABELS"], !f.isEmpty { return URL(fileURLWithPath: f) }
        return URL(fileURLWithPath: home + "/workspace/conn/setup/transcript-reader/out/pane-labels.json")
    }

    /// The name for a star: the Herdr agent running that session now (its name is what the rest of Conn calls it), else
    /// the label the reader recorded for it, else the first eight characters of the id (so two chips are still told apart).
    public static func resolve(conv: String, agentNames: [String: String], recorded: [String: String]) -> String {
        if let n = agentNames[conv], !n.isEmpty { return n }
        if let n = recorded[conv], !n.isEmpty { return n }
        return String(conv.prefix(8))
    }
}

/// Which chip is on screen. The reader rewrites its address to `#s=<first eight characters of the session id>` after it
/// loads, so a star matches when either id is a prefix of the other.
public enum StarSelection {
    public static func sessionPrefix(inFragment fragment: String?) -> String? {
        guard let f = fragment, let r = f.range(of: "^s=([0-9A-Za-z-]+)", options: .regularExpression) else { return nil }
        return String(f[r].dropFirst(2))
    }

    public static func matches(conv: String, shown: String?) -> Bool {
        guard let s = shown, !s.isEmpty else { return false }
        return conv.hasPrefix(s) || s.hasPrefix(conv)
    }

    /// The first star on screen, if any.
    public static func selected(convs: [String], shown: String?) -> String? { convs.first { matches(conv: $0, shown: shown) } }
}
