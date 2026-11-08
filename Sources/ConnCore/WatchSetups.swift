// What Watch remembers about its columns: the last setup for each column count, and presets the person saves by name.
//
// A setup is the number of columns and which session sits in which column, left to right (a free column is nothing). That is all it
// is: session ids and their order, never a title or any text, so what goes into Conn's settings is only a list of ids. A Campus
// conversation in a column is its `campus:<id>` key (`CampusColumn`), the same kind of value.
//
// This file is the rules as plain values (so unit tests cover them without a window); `WatchModel` (the app) owns the settings
// key and the notices. The rules (the captain's, 2026-11-09):
//   - the last setup is remembered per column count: choosing 2, 3 or 4 columns opens that count's last setup, and a count never
//     used fills as it always did;
//   - a setup that is gone (a session that no longer exists) leaves its column free for the normal fill rule;
//   - presets are named setups: save the current one, load one (it sets the count and every column), rename, delete.
import Foundation

public struct WatchSetup: Equatable, Codable, Sendable {
    /// One entry per column position, left to right; nil is a free column. The count of columns is the count of entries.
    public var columns: [String?]
    public init(columns: [String?]) { self.columns = columns }

    public var count: Int { columns.count }
    public var sessions: [String] { columns.compactMap { $0 } }
    public var isEmpty: Bool { sessions.isEmpty }

    /// A value that may be kept as a column's session: a reader session id (the shape the lite page accepts) or a Campus
    /// conversation key. Anything else is dropped when a setup is read back, so a hand-edited settings file cannot put odd text in.
    public static func validSession(_ s: String) -> Bool {
        if WatchAddress.validSession(s) { return true }
        guard let id = CampusColumn.id(of: s) else { return false }
        return id.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) != nil
    }

    /// Whether a remembered session no longer exists, as far as Conn can tell: an id the lite page could not open, or a Campus
    /// conversation the Campus feed no longer lists. Conn cannot know which reader conversations the reader lists, so a well-formed
    /// reader id is taken to exist (the reader then shows its own fallback, as it does for any column). `campusKnown` is false while
    /// Campus is signed out or has not answered yet: nothing there is judged gone then, so a signed-out Campus never empties a setup.
    public static func isGone(_ session: String, campusKnown: Bool, campusHas: (String) -> Bool) -> Bool {
        if let id = CampusColumn.id(of: session) { return campusKnown && !campusHas(id) }
        return !WatchAddress.validSession(session)
    }

    /// The setup as it may be kept: nil when the number of columns is not one Watch has, otherwise with every entry that is not a
    /// valid session left free and a session that appears twice kept in its first column only.
    public func sanitized() -> WatchSetup? {
        guard WatchLayout.allowedCounts.contains(columns.count) else { return nil }
        var seen: [String] = []
        let cleaned = columns.map { c -> String? in
            guard let c = c, WatchSetup.validSession(c), !seen.contains(where: { WatchLayout.same($0, c) }) else { return nil }
            seen.append(c)
            return c
        }
        return WatchSetup(columns: cleaned)
    }
}

public struct WatchPreset: Equatable, Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var setup: WatchSetup
}

public struct WatchSetups: Equatable, Codable, Sendable {
    public static let maxPresets = 30
    public static let maxNameLength = 40

    private var version = 1
    /// The last setup per column count, keyed "2", "3", "4" (a JSON object keeps its keys as text).
    private var lastByCount: [String: WatchSetup] = [:]
    public private(set) var presets: [WatchPreset] = []

    public init() {}

    // MARK: the last setup of each count

    public func last(forCount n: Int) -> WatchSetup? { lastByCount[String(n)] }

    /// Keep this setup as the last one of its column count. Returns whether anything changed.
    @discardableResult
    public mutating func remember(_ setup: WatchSetup) -> Bool {
        guard let s = setup.sanitized(), lastByCount[String(s.count)] != s else { return false }
        lastByCount[String(s.count)] = s
        return true
    }

    // MARK: presets

    /// A name as it is kept: whitespace and line breaks collapsed to single spaces, cut at 40 characters; nil when nothing is left.
    public static func cleanName(_ raw: String) -> String? {
        let words = raw.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        let cut = String(words.prefix(maxNameLength)).trimmingCharacters(in: .whitespaces)
        return cut.isEmpty ? nil : cut
    }

    public func preset(id: String) -> WatchPreset? { presets.first { $0.id == id } }

    private func index(named name: String, except id: String? = nil) -> Int? {
        presets.firstIndex { $0.id != id && $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }

    public enum SaveResult: Equatable, Sendable {
        case saved(WatchPreset)
        /// A preset of that name (any capitals) existed: it keeps its place and id and now holds this setup.
        case replaced(WatchPreset)
        case refused(Refusal)
    }
    public enum Refusal: Equatable, Sendable {
        case emptyName, nothingToSave, tooMany, unknownPreset, nameTaken
        public var message: String {
            switch self {
            case .emptyName: return "A preset needs a name"
            case .nothingToSave: return "There is no conversation in the columns to save"
            case .tooMany: return "There are \(WatchSetups.maxPresets) presets already: delete one first"
            case .unknownPreset: return "That preset is not there any more"
            case .nameTaken: return "Another preset has that name"
            }
        }
    }

    /// Save a setup under a name. A setup with no session in it is not worth keeping and is refused.
    @discardableResult
    public mutating func savePreset(name: String, setup: WatchSetup, makeID: () -> String = { UUID().uuidString }) -> SaveResult {
        guard let name = WatchSetups.cleanName(name) else { return .refused(.emptyName) }
        guard let s = setup.sanitized(), !s.isEmpty else { return .refused(.nothingToSave) }
        if let i = index(named: name) {
            presets[i].setup = s
            presets[i].name = name
            return .replaced(presets[i])
        }
        guard presets.count < WatchSetups.maxPresets else { return .refused(.tooMany) }
        let p = WatchPreset(id: makeID(), name: name, setup: s)
        presets.append(p)
        return .saved(p)
    }

    /// Give a preset another name. A name another preset has is refused (changing only the capitals of its own name is fine).
    @discardableResult
    public mutating func renamePreset(id: String, to raw: String) -> Refusal? {
        guard let name = WatchSetups.cleanName(raw) else { return .emptyName }
        guard let i = presets.firstIndex(where: { $0.id == id }) else { return .unknownPreset }
        if index(named: name, except: id) != nil { return .nameTaken }
        presets[i].name = name
        return nil
    }

    @discardableResult
    public mutating func deletePreset(id: String) -> Bool {
        guard let i = presets.firstIndex(where: { $0.id == id }) else { return false }
        presets.remove(at: i)
        return true
    }

    // MARK: settings

    public func encoded() -> Data? {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return try? e.encode(self)
    }

    /// What the settings hold, read defensively: bytes that are not a setups file give an empty value, an entry that is not valid
    /// is dropped (a setup with a number of columns Watch does not have, a setup kept under the wrong count, a preset with no usable
    /// name or a name already taken), and a session that is not a valid session is left out of its setup.
    public static func decode(_ data: Data?) -> WatchSetups {
        guard let data = data, let raw = try? JSONDecoder().decode(WatchSetups.self, from: data) else { return WatchSetups() }
        var out = WatchSetups()
        for (key, setup) in raw.lastByCount {
            if let s = setup.sanitized(), String(s.count) == key { out.lastByCount[key] = s }
        }
        var ids = Set<String>()
        for p in raw.presets where out.presets.count < maxPresets {
            guard let name = cleanName(p.name), !p.id.isEmpty, p.id.count <= 64, ids.insert(p.id).inserted,
                  out.index(named: name) == nil, let s = p.setup.sanitized() else { continue }
            out.presets.append(WatchPreset(id: p.id, name: name, setup: s))
        }
        return out
    }
}
