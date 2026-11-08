// Conn's own Campus stars: the Campus conversations the person keeps in the Reader column's starred row, beside the reader's stars.
//
// What is kept: addresses and order, nothing else. One address is `<space kind>/<space folder>/<conversation id>` (the same three parts a Campus link
// carries), in the order the person arranged. No title, no text, no time: a chip's label is read from the live feed (memory) and falls back to a plain
// word when the feed does not have the conversation. The list lives in Conn's own settings (UserDefaults), not in the reader's `stars.json` and not on any
// other disk file: the reader never sees it, and no Campus text reaches a disk copy (decision H1 = conn-native; a Campus source in the reader's store
// is a later, separate slice with its own privacy calls).
import Foundation
import Combine

/// Where one Campus conversation lives: enough to ask Campus for it when it is not in the list the feed reads (a starred conversation older than the
/// 50 most recent of its space).
public struct CampusAddress: Equatable, Hashable, Sendable {
    public var kind: String
    public var folder: String
    public var id: String
    public init(kind: String, folder: String, id: String) { self.kind = kind; self.folder = folder; self.id = id }

    public init(_ c: CampusConversation) { self.init(kind: c.spaceKind, folder: c.folder, id: c.id) }

    public var spaceID: String { kind + "/" + folder }

    /// `kind/folder/id`: the form that is written to settings.
    public var text: String { kind + "/" + folder + "/" + id }

    /// nil when a part is not a plain Campus one (the same checks a request path gets).
    public static func parse(_ s: String) -> CampusAddress? {
        let p = s.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard p.count == 3, ["private", "team"].contains(p[0]), CampusSpace.validFolder(p[1]), CampusSpace.validConversationID(p[2]) else { return nil }
        return CampusAddress(kind: p[0], folder: p[1], id: p[2])
    }
}

/// The ordered star list (a value; `CampusStarStore` keeps it).
public struct CampusStarList: Equatable, Sendable {
    /// More than this many stars would make the row a second sidebar; also bounds the extra reads a refresh makes for stars the list does not carry.
    public static let limit = 24

    public private(set) var entries: [CampusAddress]
    public init(_ entries: [CampusAddress] = []) {
        var seen = Set<String>(), out: [CampusAddress] = []
        for e in entries where seen.insert(e.id).inserted && out.count < Self.limit { out.append(e) }
        self.entries = out
    }

    public var ids: [String] { entries.map(\.id) }
    public func contains(_ id: String) -> Bool { entries.contains { $0.id == id } }
    public func address(of id: String) -> CampusAddress? { entries.first { $0.id == id } }

    /// Add at the end. False when it is already there or the list is full.
    @discardableResult
    public mutating func add(_ a: CampusAddress) -> Bool {
        guard !contains(a.id), entries.count < Self.limit else { return false }
        entries.append(a)
        return true
    }

    @discardableResult
    public mutating func remove(_ id: String) -> Bool {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return false }
        entries.remove(at: i)
        return true
    }

    /// `id` takes the place of `target` (the rule the reader's chips use: before it when it came from the right, after it when it came from the left).
    public mutating func move(_ id: String, onto target: String) {
        guard id != target, let from = entries.firstIndex(where: { $0.id == id }), let to = entries.firstIndex(where: { $0.id == target }) else { return }
        let e = entries.remove(at: from)
        entries.insert(e, at: to)
    }

    /// What is written: one string per star, in order. Nothing else.
    public var stored: [String] { entries.map(\.text) }

    /// Read what was written. A string that is not an address is dropped; a conversation listed twice counts once.
    public static func parse(_ stored: [String]) -> CampusStarList { CampusStarList(stored.compactMap(CampusAddress.parse)) }
}

/// The list in a `UserDefaults` domain (the app's own, or the test domain in test mode, like the reader's chip order).
@MainActor
public final class CampusStarStore: ObservableObject {
    @Published public private(set) var list: CampusStarList
    private let defaults: UserDefaults
    public let key: String

    public init(defaults: UserDefaults, key: String = "conn.campusStars") {
        self.defaults = defaults; self.key = key
        list = CampusStarList.parse(defaults.array(forKey: key) as? [String] ?? [])
    }

    public var entries: [CampusAddress] { list.entries }
    public func isStarred(_ id: String) -> Bool { list.contains(id) }

    private func save() { defaults.set(list.stored, forKey: key) }

    /// Star it, or take the star off. Returns true when it is starred afterwards (false also when the list is full and the star was refused).
    @discardableResult
    public func toggle(_ a: CampusAddress) -> Bool {
        var next = list
        if next.contains(a.id) { next.remove(a.id) } else if !next.add(a) { return false }
        list = next; save()
        return next.contains(a.id)
    }

    public func unstar(_ id: String) { var next = list; if next.remove(id) { list = next; save() } }

    public func move(_ id: String, onto target: String) {
        var next = list; next.move(id, onto: target)
        if next != list { list = next; save() }
    }

    public func clear() { list = CampusStarList(); save() }
}
