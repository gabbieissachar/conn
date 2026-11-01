// The plain editor's document model: open a text or markdown file, edit it, save it without losing a newer version.
// UTF-8 only. A file with NUL bytes is not text, and one over the size cap is refused rather than loaded into a view.
import Foundation
import Combine

public enum TextFileError: Error, Equatable, CustomStringConvertible {
    case notText(String)
    case tooLarge(bytes: Int, limit: Int)
    case changedOnDisk
    case noPath
    case io(String)

    public var description: String {
        switch self {
        case .notText(let n): return "\(n) is not a UTF-8 text file"
        case .tooLarge(let b, let l): return "File is \(b / 1024) KB; the editor opens files up to \(l / 1024) KB"
        case .changedOnDisk: return "The file changed on disk after it was opened"
        case .noPath: return "This document has no file yet"
        case .io(let s): return s
        }
    }
}

/// What the file looked like when it was read; compared before an overwrite.
public struct DiskStamp: Equatable, Sendable {
    public var modified: Date
    public var size: Int
    public static func read(_ url: URL) -> DiskStamp? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              let m = a[.modificationDate] as? Date, let s = a[.size] as? NSNumber else { return nil }
        return DiskStamp(modified: m, size: s.intValue)
    }
}

public final class TextFile: ObservableObject {
    public static let sizeLimit = 5 << 20

    @Published public var text: String { didSet { if text != oldValue { revision += 1 } } }
    @Published public private(set) var url: URL?
    @Published public private(set) var savedText: String
    @Published public private(set) var lastError: String?
    @Published public private(set) var changedOnDisk = false
    public private(set) var revision = 0
    private var stamp: DiskStamp?

    public var isDirty: Bool { text != savedText }
    public var title: String { url?.lastPathComponent ?? "Untitled" }
    public var isMarkdown: Bool { ["md", "markdown", "mdown"].contains(url?.pathExtension.lowercased() ?? "") }

    public init(text: String = "") {
        self.text = text
        self.savedText = text
    }

    public convenience init(opening url: URL) throws {
        self.init()
        try load(url)
    }

    public func load(_ url: URL) throws {
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw TextFileError.io("Could not read \(url.lastPathComponent): \(error.localizedDescription)") }
        guard data.count <= Self.sizeLimit else { throw TextFileError.tooLarge(bytes: data.count, limit: Self.sizeLimit) }
        guard !data.contains(0), let s = String(data: data, encoding: .utf8) else { throw TextFileError.notText(url.lastPathComponent) }
        self.url = url
        self.text = s
        self.savedText = s
        self.stamp = DiskStamp.read(url)
        self.changedOnDisk = false
        self.lastError = nil
    }

    /// Writes the text. Refuses when the file changed on disk since it was read, unless `overwrite` is set.
    public func save(overwrite: Bool = false) throws {
        guard let url = url else { throw TextFileError.noPath }
        if !overwrite, let known = stamp, let now = DiskStamp.read(url), now != known {
            changedOnDisk = true
            throw TextFileError.changedOnDisk
        }
        do { try Data(text.utf8).write(to: url, options: .atomic) } catch { throw TextFileError.io("Could not save \(url.lastPathComponent): \(error.localizedDescription)") }
        savedText = text
        stamp = DiskStamp.read(url)
        changedOnDisk = false
        lastError = nil
    }

    public func saveAs(_ newURL: URL) throws {
        url = newURL
        stamp = nil
        try save(overwrite: true)
    }

    /// Cheap poll for the "changed on disk" banner.
    public func checkDisk() {
        guard let url = url, let known = stamp, let now = DiskStamp.read(url) else { return }
        let changed = now != known
        if changed != changedOnDisk { changedOnDisk = changed }
    }

    public func reloadFromDisk() throws {
        guard let url = url else { throw TextFileError.noPath }
        try load(url)
    }

    public func recordError(_ e: Error) { lastError = "\(e)" }
}
