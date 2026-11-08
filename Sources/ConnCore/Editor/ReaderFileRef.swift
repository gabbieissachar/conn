// A click on a file in the reader's page (the Reader column, a Watch column): the page draws a link in a reply as `a.file-ref[data-path="<absolute path>"]` and a
// button in its Documents view as `button.file-ref[data-path="<absolute path>"]`. Conn takes the click and opens the file in the Editor view, the way `conn <path>`
// does. The path comes from a web page, so it is checked here before anything opens: absolute, there, and a regular file (a folder, a device or a socket is not
// opened from a reader click). Pure apart from one `stat`, so tests cover every shape.
import Foundation

public enum ReaderFileRef {
    public enum Verdict: Equatable, Sendable {
        /// Open this file in the Editor.
        case open(URL)
        /// Do not open anything; `reason` is the plain sentence for the notice.
        case refused(name: String, reason: String)
    }

    /// The longest path taken (PATH_MAX is 1024 on macOS; the page may send more, and it is refused rather than cut).
    public static let maxPathBytes = 1024

    /// `path` is the `data-path` attribute as the page gave it. `lookup` is `stat` (following a link to its target) and is a parameter only so a test needn't touch the disk.
    public static func check(_ path: String, lookup: (String) -> Kind = ReaderFileRef.kindAt) -> Verdict {
        let shown = displayName(path)
        guard !path.isEmpty, !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) else { return .refused(name: shown, reason: "the page gave no usable path") }
        guard path.hasPrefix("/") else { return .refused(name: shown, reason: "the page gave a path that is not absolute") }
        guard path.utf8.count <= maxPathBytes else { return .refused(name: shown, reason: "the path is too long") }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        switch lookup(url.path) {
        case .regularFile: return .open(url)
        case .missing: return .refused(name: url.lastPathComponent, reason: "it does not exist")
        case .directory: return .refused(name: url.lastPathComponent, reason: "it is a folder, not a file")
        case .other: return .refused(name: url.lastPathComponent, reason: "it is not a regular file")
        }
    }

    public enum Kind: Equatable, Sendable { case regularFile, directory, missing, other }

    /// What is at `path`, a link followed to its target.
    public static func kindAt(_ path: String) -> Kind {
        var st = stat()
        guard stat(path, &st) == 0 else { return .missing }
        switch st.st_mode & S_IFMT {
        case S_IFREG: return .regularFile
        case S_IFDIR: return .directory
        default: return .other
        }
    }

    /// The last component of a path the page gave, for a notice (the whole thing is never shown: it is page-supplied text).
    static func displayName(_ path: String) -> String {
        let last = (path as NSString).lastPathComponent
        let clean = String(last.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7F }.prefix(60).map(Character.init))
        return clean.isEmpty ? "that file" : clean
    }

    /// The notice for a refusal: "Conn did not open “name”" and the reason.
    public static func notice(name: String, reason: String) -> (title: String, detail: String) {
        ("Conn did not open “\(name)”", reason.prefix(1).uppercased() + reason.dropFirst())
    }
}
