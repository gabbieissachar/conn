// What kind of file a click on the Explorer's tree opens: text the editor can edit, text too big to load whole, or something
// that is not text at all. The decision is cheap (one stat and one 8 KB read), so it runs when a file is clicked, not when the tree loads.
import Foundation

public enum FileKind: String, Equatable, Sendable {
    /// UTF-8 text up to `TextFile.sizeLimit`: opens whole and can be edited.
    case text
    /// Text over the size limit: opens read-only, first `TextFile.headLimit` bytes.
    case large
    /// Not text: a known binary extension, or a NUL byte in the first 8 KB. Opens as a placeholder.
    case binary

    /// Extensions that are never text. Checked first, so a 40 MB video is never read at all.
    public static let binaryExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "tif", "tiff", "bmp", "webp", "heic", "heif", "icns", "ico", "psd", "ai", "sketch", "fig", "raw",
        "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "dmg", "pkg", "iso", "jar", "war",
        "mp3", "m4a", "wav", "aif", "aiff", "flac", "mp4", "m4v", "mov", "avi", "mkv", "webm",
        "sqlite", "sqlite3", "db", "realm", "o", "a", "dylib", "so", "class", "exe", "dll", "bin", "dat", "wasm",
        "ttf", "otf", "woff", "woff2", "car", "nib",
    ]

    /// How much of the start of a file is read to look for a NUL byte.
    public static let headBytes = 8192

    /// The kind of the file at `url` and its size in bytes. A path that cannot be read is `text` with size 0, so opening it
    /// reports the real error instead of a placeholder.
    public static func classify(_ url: URL) -> (kind: FileKind, size: Int) {
        let real = url.resolvingSymlinksInPath()
        let size = (try? FileManager.default.attributesOfItem(atPath: real.path)[.size] as? NSNumber)?.intValue ?? 0
        if binaryExtensions.contains(real.pathExtension.lowercased()) { return (.binary, size) }
        if let h = try? FileHandle(forReadingFrom: real) {
            defer { try? h.close() }
            if let head = try? h.read(upToCount: headBytes), head.contains(0) { return (.binary, size) }
        }
        return (size > TextFile.sizeLimit ? .large : .text, size)
    }
}
