// The Explorer's tree: what is in a folder, in what order, and which rows are showing. No UI. Folders are read lazily, one
// folder when it is first needed, so opening a huge project reads only what is on screen.
import Foundation

public struct FolderEntry: Equatable, Sendable {
    public var name: String
    public var isDirectory: Bool
    public var isSymlink: Bool
    /// A link to this folder or to one of its parents: shown as a folder, never opened, so the tree cannot recurse forever.
    public var isLoop: Bool
    public var size: Int

    public init(name: String, isDirectory: Bool, isSymlink: Bool = false, isLoop: Bool = false, size: Int = 0) {
        self.name = name; self.isDirectory = isDirectory; self.isSymlink = isSymlink; self.isLoop = isLoop; self.size = size
    }
    /// Size is not part of the identity: a file that grows does not change the tree.
    public static func == (a: FolderEntry, b: FolderEntry) -> Bool {
        a.name == b.name && a.isDirectory == b.isDirectory && a.isSymlink == b.isSymlink && a.isLoop == b.isLoop
    }
}

public struct FolderListing: Equatable, Sendable {
    /// Visible entries, folders first, capped at the cap.
    public var entries: [FolderEntry] = []
    /// How many visible entries the cap left out.
    public var overflow = 0
    /// The folder could not be read (permission, or it is gone).
    public var unreadable = false
    public init(entries: [FolderEntry] = [], overflow: Int = 0, unreadable: Bool = false) {
        self.entries = entries; self.overflow = overflow; self.unreadable = unreadable
    }
}

public enum FolderRules {
    /// Hidden from the tree unless "show hidden files" is on. Other dotfiles show.
    public static let hiddenByDefault: Set<String> = [".git", ".build", ".DS_Store"]
    /// A folder with more entries than this shows the first ones and a note ("N more").
    public static let entryCap = 5000

    /// Folders first, then names in the order Finder uses for numbers ("file2" before "file10"), ignoring case.
    public static func before(_ a: FolderEntry, _ b: FolderEntry) -> Bool {
        if a.isDirectory != b.isDirectory { return a.isDirectory }
        let c = a.name.compare(b.name, options: [.numeric, .caseInsensitive])
        return c == .orderedSame ? a.name < b.name : c == .orderedAscending
    }

    /// Reads one folder. Safe to call off the main thread.
    public static func list(_ dir: URL, showHidden: Bool, cap: Int = entryCap) -> FolderListing {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]
        // A link to a folder lists through its target: contentsOfDirectory(at:) refuses the link's own URL.
        guard let urls = try? FileManager.default.contentsOfDirectory(at: dir.resolvingSymlinksInPath(), includingPropertiesForKeys: keys, options: []) else {
            return FolderListing(unreadable: true)
        }
        let dirReal = dir.resolvingSymlinksInPath().path
        var entries: [FolderEntry] = []
        entries.reserveCapacity(urls.count)
        for u in urls {
            let name = u.lastPathComponent
            if !showHidden && hiddenByDefault.contains(name) { continue }
            let v = try? u.resourceValues(forKeys: Set(keys))
            let link = v?.isSymbolicLink ?? false
            var isDir = v?.isDirectory ?? false
            var loop = false
            if link {
                var d: ObjCBool = false
                isDir = FileManager.default.fileExists(atPath: u.path, isDirectory: &d) && d.boolValue
                if isDir {
                    let target = u.resolvingSymlinksInPath().path
                    loop = dirReal == target || dirReal.hasPrefix(target == "/" ? "/" : target + "/")
                }
            }
            entries.append(FolderEntry(name: name, isDirectory: isDir, isSymlink: link, isLoop: loop, size: v?.fileSize ?? 0))
        }
        entries.sort(by: before)
        var listing = FolderListing(entries: entries)
        if entries.count > cap { listing.entries = Array(entries.prefix(cap)); listing.overflow = entries.count - cap }
        return listing
    }
}

/// One line of the Explorer.
public struct FolderRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case file, folder, note }
    /// The path below the opened folder, of the file or of the last folder in a compact chain. A note's id is its folder's plus a marker.
    public var id: String
    /// What the row says: the name, or "Tests/StorefrontCoreTests" for a chain of single-child folders.
    public var label: String
    public var depth: Int
    public var kind: Kind
    public var isExpanded = false
    public var isSymlink = false
    public var isLoop = false
    public var size = 0
    /// Every folder a compact row stands for, outermost first (just the folder itself otherwise).
    public var chain: [String] = []

    public var canExpand: Bool { kind == .folder && !isLoop }
    public var isNote: Bool { kind == .note }
    /// The last name in the path, which is what picks the icon.
    public var name: String { (id as NSString).lastPathComponent }
}

public final class FolderTree {
    /// The opened folder, symlinks resolved.
    public let root: URL
    /// Hidden files and folders (see `FolderRules.hiddenByDefault`) show when this is on.
    public var showHidden: Bool { didSet { if showHidden != oldValue { listings.removeAll() } } }
    /// A folder whose only child is a folder shares one row with it (".github/workflows").
    public var compact: Bool
    public var entryCap: Int { didSet { if entryCap != oldValue { listings.removeAll() } } }
    /// Expanded folders, as paths below the root (a compact row is expanded by its last folder's path).
    public private(set) var expanded: Set<String>
    private var listings: [String: FolderListing] = [:]

    public init(root: URL, showHidden: Bool = false, compact: Bool = true, expanded: Set<String> = [], entryCap: Int = FolderRules.entryCap) {
        self.root = root.resolvingSymlinksInPath().standardizedFileURL
        self.showHidden = showHidden
        self.compact = compact
        self.expanded = expanded
        self.entryCap = entryCap
    }

    public func url(forRelative rel: String) -> URL { rel.isEmpty ? root : root.appendingPathComponent(rel) }

    /// The path of `url` below the root: "" for the root itself, nil outside it.
    public func relativePath(of url: URL) -> String? {
        guard let r = PathCopy.relative(of: url, to: root) else { return nil }
        return r == "." ? "" : r
    }

    private func listing(_ rel: String) -> FolderListing {
        if let l = listings[rel] { return l }
        let l = FolderRules.list(url(forRelative: rel), showHidden: showHidden, cap: entryCap)
        listings[rel] = l
        return l
    }

    /// False when the opened folder itself cannot be read.
    public var isReadable: Bool { !listing("").unreadable }

    // MARK: Rows

    public func rows() -> [FolderRow] {
        var out: [FolderRow] = []
        appendChildren(of: "", depth: 0, into: &out)
        return out
    }

    private func appendChildren(of dir: String, depth: Int, into out: inout [FolderRow]) {
        let l = listing(dir)
        for e in l.entries {
            let rel = dir.isEmpty ? e.name : dir + "/" + e.name
            guard e.isDirectory else {
                out.append(FolderRow(id: rel, label: e.name, depth: depth, kind: .file, isSymlink: e.isSymlink, size: e.size))
                continue
            }
            var leaf = rel, label = e.name, chain = [rel]
            if compact && !e.isSymlink {
                while true {
                    let sub = listing(leaf)
                    guard !sub.unreadable, sub.overflow == 0, sub.entries.count == 1, let only = sub.entries.first, only.isDirectory, !only.isSymlink else { break }
                    leaf += "/" + only.name; label += "/" + only.name; chain.append(leaf)
                }
            }
            let open = expanded.contains(leaf) && !e.isLoop
            out.append(FolderRow(id: leaf, label: label, depth: depth, kind: .folder, isExpanded: open, isSymlink: e.isSymlink, isLoop: e.isLoop, chain: chain))
            if open { appendChildren(of: leaf, depth: depth + 1, into: &out) }
        }
        if l.unreadable {
            out.append(FolderRow(id: dir + "\u{0}note", label: "Cannot read this folder", depth: depth, kind: .note))
        } else if l.overflow > 0 {
            out.append(FolderRow(id: dir + "\u{0}note", label: "\(l.overflow) more items not shown", depth: depth, kind: .note))
        }
    }

    // MARK: Expanding

    public func setExpanded(_ id: String, _ on: Bool) { if on { expanded.insert(id) } else { expanded.remove(id) } }
    public func toggle(_ id: String) { setExpanded(id, !expanded.contains(id)) }
    public func collapseAll() { expanded.removeAll() }

    /// Expands every folder above `rel` so its row shows. A file in a hidden folder gets no row; `rows()` is what says so.
    public func reveal(relative rel: String) {
        let parts = rel.split(separator: "/").map(String.init)
        guard parts.count > 1 else { return }
        var path = ""
        for p in parts.dropLast() { path += (path.isEmpty ? "" : "/") + p; expanded.insert(path) }
    }

    // MARK: Changes on disk

    /// The folders read so far, which are the ones a change can matter to.
    public var loadedDirectories: [String] { Array(listings.keys) }

    /// Reads `dirs` of the tree at `root` again. Pure, so it can run off the main thread; the result goes to `apply`.
    public static func relist(_ dirs: [String], root: URL, showHidden: Bool, cap: Int = FolderRules.entryCap) -> [String: FolderListing] {
        var out: [String: FolderListing] = [:]
        for d in dirs { out[d] = FolderRules.list(d.isEmpty ? root : root.appendingPathComponent(d), showHidden: showHidden, cap: cap) }
        return out
    }

    /// Takes new listings from `relist`. True when the rows may have changed. Folders that are gone are forgotten, along with their expansion.
    @discardableResult
    public func apply(_ fresh: [String: FolderListing]) -> Bool {
        var changed = false
        for (dir, l) in fresh {
            guard listings[dir] != nil else { continue }
            if listings[dir] != l { listings[dir] = l; changed = true }
        }
        let gone = expanded.filter { rel in
            var d: ObjCBool = false
            return !(FileManager.default.fileExists(atPath: url(forRelative: rel).path, isDirectory: &d) && d.boolValue)
        }
        if !gone.isEmpty { expanded.subtract(gone); changed = true }
        if changed { for dir in listings.keys where gone.contains(where: { dir == $0 || dir.hasPrefix($0 + "/") }) { listings[dir] = nil } }
        return changed
    }

    /// Reads every folder read so far again, on this thread. For tests and the polling fallback's first step.
    @discardableResult
    public func refresh() -> Bool { apply(Self.relist(loadedDirectories, root: root, showHidden: showHidden, cap: entryCap)) }
}
