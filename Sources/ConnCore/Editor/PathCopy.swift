// Copy Path and Copy Relative Path: the strings behind the Editor's menu items, keys, tab menu and footer. Pure, so tests cover them.
import Foundation

public enum PathCopy {
    /// The real path of `url` with every link resolved, as the kernel and FSEvents name it (/private/var, not /var).
    /// `URL.resolvingSymlinksInPath` leaves /var and /tmp as they are, so it cannot be used where the two must agree.
    public static func physical(_ url: URL) -> URL {
        var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(url.path, &buf) != nil else { return url.standardizedFileURL }
        return URL(fileURLWithPath: String(cString: buf), isDirectory: url.hasDirectoryPath)
    }

    /// The path of `file` below `folder` ("Sources/App/Main.swift"), or nil when `file` is not inside `folder`. "." for the folder itself.
    /// Compares path components after resolving symlinks on both sides, never string prefixes: /a/b is not inside /a/bc.
    public static func relative(of file: URL, to folder: URL) -> String? {
        let f = file.resolvingSymlinksInPath().standardizedFileURL.pathComponents
        let r = folder.resolvingSymlinksInPath().standardizedFileURL.pathComponents
        guard f.count >= r.count, Array(f.prefix(r.count)) == r else { return nil }
        let rest = f.dropFirst(r.count)
        return rest.isEmpty ? "." : rest.joined(separator: "/")
    }

    public enum Copied: Equatable, Sendable {
        /// The text for the clipboard and the title of the confirmation.
        case path(String)
        case relative(String)
        /// A relative copy of a file outside the folder: the full path is copied, and the confirmation says so.
        case fullBecauseOutside(String)
        /// Nothing to copy (an unsaved document).
        case none

        public var text: String? {
            switch self { case .path(let s), .relative(let s), .fullBecauseOutside(let s): return s; case .none: return nil }
        }
        public var title: String {
            switch self {
            case .path: return "Copied path"
            case .relative: return "Copied relative path"
            case .fullBecauseOutside: return "Copied path (outside the folder)"
            case .none: return "Nothing to copy: save the file first"
            }
        }
    }

    /// What a copy puts on the clipboard for `file`, with `folder` the opened folder (nil when none is open).
    public static func copy(_ file: URL?, relative wantsRelative: Bool, folder: URL?) -> Copied {
        guard let file = file else { return .none }
        if !wantsRelative { return .path(file.path) }
        if let folder = folder, let rel = relative(of: file, to: folder) { return .relative(rel) }
        return .fullBecauseOutside(file.path)
    }
}
