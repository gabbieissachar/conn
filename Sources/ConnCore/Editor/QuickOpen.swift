// Go to File (Cmd+P): the list of files below the opened folder and the match by typed letters. No UI.
import Foundation

public enum QuickOpen {
    /// Folders never worth searching, even when hidden files show in the tree.
    public static let skippedFolders: Set<String> = [".git", ".build", ".DS_Store", "node_modules", ".svn", ".hg"]

    /// Every file below `root`, as paths below it, in no particular order. Folders that are links are not followed.
    /// Stops at `limit` files, or when `keepGoing` says no. Safe to call off the main thread.
    public static func scan(root: URL, limit: Int = 50_000, keepGoing: () -> Bool = { true }) -> [String] {
        var out: [String] = []
        let base = PathCopy.physical(root)
        let prefix = base.path.hasSuffix("/") ? base.path.count : base.path.count + 1
        guard let walker = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsPackageDescendants]) else { return [] }
        for case let url as URL in walker {
            if out.count >= limit || !keepGoing() { break }
            let name = url.lastPathComponent
            let v = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if v?.isDirectory == true {
                if skippedFolders.contains(name) { walker.skipDescendants() }
                continue
            }
            if v?.isSymbolicLink == true {   // a link to a folder is not a file, and is not followed
                var d: ObjCBool = false
                if FileManager.default.fileExists(atPath: url.path, isDirectory: &d), d.boolValue { continue }
            }
            if skippedFolders.contains(name) { continue }
            let p = url.path
            guard p.count > prefix else { continue }
            out.append(String(p.dropFirst(prefix)))
        }
        return out
    }

    /// How well `query` matches `path`, nil when its letters are not all there in order. Higher is better. Letters in the file
    /// name count for more than letters in the folders above it, runs of letters and word starts count extra, short paths win ties.
    public static func score(query: String, path: String) -> Int? {
        let q = Array(query.lowercased().filter { !$0.isWhitespace })
        if q.isEmpty { return 0 }
        let chars = Array(path)
        let lower = chars.map { Character($0.lowercased()) }
        let nameStart = (chars.lastIndex(of: "/") ?? -1) + 1
        var qi = 0, score = 0, run = 0
        for (i, c) in lower.enumerated() where qi < q.count && c == q[qi] {
            var s = 1
            if i >= nameStart { s += 4 }
            let prev: Character? = i > 0 ? chars[i - 1] : nil
            if prev == nil || "/._- ".contains(prev!) || (chars[i].isUppercase && (prev?.isLowercase ?? false)) { s += 6 }
            if qi > 0 && i > 0 && lower[i - 1] == q[qi - 1] { run += 1; s += 3 * min(run, 4) } else { run = 0 }
            score += s
            qi += 1
        }
        guard qi == q.count else { return nil }
        let name = String(chars[nameStart...]).lowercased()
        if name == String(q) { score += 60 } else if name.hasPrefix(String(q)) { score += 30 } else if name.contains(String(q)) { score += 15 }
        return score * 4 - min(chars.count, 150) / 10
    }

    /// The best `limit` paths for `query`, best first. An empty query gives the shortest paths.
    public static func rank(query: String, in paths: [String], limit: Int = 50) -> [String] {
        let scored: [(String, Int)] = paths.compactMap { p in score(query: query, path: p).map { (p, query.isEmpty ? -p.count : $0) } }
        return scored.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }.prefix(limit).map(\.0)
    }
}
