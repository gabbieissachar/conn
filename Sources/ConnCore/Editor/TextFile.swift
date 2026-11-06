// The plain editor's document model: open a text or markdown file, edit it, save it without losing a newer version.
// UTF-8 only. A file with NUL bytes is not text. One over the size cap opens read-only, first megabyte only (`open`); the strict
// initializer still refuses it.
import Foundation
import Combine

public enum TextFileError: Error, Equatable, CustomStringConvertible {
    case notText(String)
    case tooLarge(bytes: Int, limit: Int)
    case changedOnDisk
    case noPath
    case readOnly
    case io(String)

    public var description: String {
        switch self {
        case .notText(let n): return "\(n) is not a UTF-8 text file"
        case .tooLarge(let b, let l): return "File is \(b / 1024) KB; the editor opens files up to \(l / 1024) KB"
        case .changedOnDisk: return "The file changed on disk after it was opened"
        case .noPath: return "This document has no file yet"
        case .readOnly: return "This file is shown read-only"
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
    /// How much of a file over the size limit is shown.
    public static let headLimit = 1 << 20

    @Published public var text: String {
        didSet { if text != oldValue { revision += 1; if isPreview && isDirty { isPreview = false } } }
    }
    /// `text` for an editable document; `large` is the first megabyte of a file over the limit, read-only; `binary` has no text at all.
    @Published public private(set) var kind: FileKind = .text
    /// The size of the file on disk when it was opened (for `large` and `binary`, which show a note, not the file).
    public private(set) var totalBytes = 0
    /// A preview tab: replaced by the next file opened as a preview, and pinned by the first edit (the editor pins it by a double click too).
    @Published public var isPreview = false
    /// The file was deleted or moved by another program after it was opened. The text stays; saving writes it back.
    @Published public private(set) var deletedOnDisk = false
    @Published public private(set) var url: URL?
    @Published public private(set) var savedText: String
    @Published public private(set) var lastError: String?
    @Published public private(set) var changedOnDisk = false
    public private(set) var revision = 0
    private var stamp: DiskStamp?
    /// The file reads and writes go to: `url` with symlinks resolved, so saving a symlink edits its target and the link stays a link.
    private var ioURL: URL?
    private var hasBOM = false
    private static let bom: [UInt8] = [0xEF, 0xBB, 0xBF]

    public var isReadOnly: Bool { kind != .text }
    public var isDirty: Bool { kind == .text && text != savedText }
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

    /// Opens any file the way the Explorer does: text for editing; a text file over the limit as its first megabyte, read-only;
    /// a file that is not text as a placeholder with no text. Only a file that cannot be read at all throws.
    public static func open(_ url: URL) throws -> TextFile {
        let (kind, size) = FileKind.classify(url)
        let doc = TextFile()
        switch kind {
        case .text:
            do { try doc.load(url) } catch TextFileError.notText { doc.makePlaceholder(url, size: size) }
            catch TextFileError.tooLarge { try doc.loadHead(url, size: size) }
        case .large:
            try doc.loadHead(url, size: size)
        case .binary:
            doc.makePlaceholder(url, size: size)
        }
        return doc
    }

    private func makePlaceholder(_ url: URL, size: Int) {
        self.url = url; ioURL = url.resolvingSymlinksInPath()
        kind = .binary; totalBytes = size
        text = ""; savedText = ""
    }

    private func loadHead(_ url: URL, size: Int) throws {
        let real = url.resolvingSymlinksInPath()
        let data: Data
        do {
            let h = try FileHandle(forReadingFrom: real)
            defer { try? h.close() }
            data = try h.read(upToCount: Self.headLimit) ?? Data()
        } catch { throw TextFileError.io("Could not read \(url.lastPathComponent): \(error.localizedDescription)") }
        guard let s = Self.utf8Prefix(data) else { makePlaceholder(url, size: size); return }
        self.url = url; ioURL = real
        kind = .large; totalBytes = size
        savedText = s; text = s
    }

    /// `data` as text, dropping a byte order mark and a character cut in half at the end. nil when it is not UTF-8 text.
    static func utf8Prefix(_ data: Data) -> String? {
        var d = data.starts(with: bom) ? data.dropFirst(3) : data[...]
        guard !d.contains(0) else { return nil }
        for _ in 0..<4 {
            if let s = String(data: d, encoding: .utf8) { return s }
            guard !d.isEmpty else { break }
            d = d.dropLast()
        }
        return nil
    }

    public func load(_ url: URL) throws {
        let real = url.resolvingSymlinksInPath()
        var data: Data
        do { data = try Data(contentsOf: real) } catch { throw TextFileError.io("Could not read \(url.lastPathComponent): \(error.localizedDescription)") }
        guard data.count <= Self.sizeLimit else { throw TextFileError.tooLarge(bytes: data.count, limit: Self.sizeLimit) }
        // A UTF-8 byte order mark is kept out of the text and written back on save, so it is not lost.
        let bom = data.starts(with: Self.bom)
        if bom { data = data.dropFirst(3) }
        guard !data.contains(0), let s = String(data: data, encoding: .utf8) else { throw TextFileError.notText(url.lastPathComponent) }
        self.url = url
        self.ioURL = real
        self.hasBOM = bom
        self.kind = .text
        self.savedText = s
        self.text = s
        self.stamp = DiskStamp.read(real)
        self.changedOnDisk = false
        self.deletedOnDisk = false
        self.lastError = nil
    }

    /// Writes the text. Refuses when the file changed on disk since it was read, unless `overwrite` is set.
    public func save(overwrite: Bool = false) throws {
        guard let url = url else { throw TextFileError.noPath }
        guard kind == .text else { throw TextFileError.readOnly }
        let target = ioURL ?? url
        if !overwrite, let known = stamp, let now = DiskStamp.read(target), now != known {
            changedOnDisk = true
            throw TextFileError.changedOnDisk
        }
        var data = Data(hasBOM ? Self.bom : [])
        data.append(Data(text.utf8))
        // An atomic write replaces the file (a new inode), which would split a hard link from its twin; a file with
        // other links is rewritten in place instead. Everything else is written atomically, so a crash cannot truncate it.
        let links = (try? FileManager.default.attributesOfItem(atPath: target.path)[.referenceCount] as? NSNumber)?.intValue ?? 1
        do { try data.write(to: target, options: links > 1 ? [] : .atomic) } catch { throw TextFileError.io("Could not save \(url.lastPathComponent): \(error.localizedDescription)") }
        savedText = text
        stamp = DiskStamp.read(target)
        changedOnDisk = false
        deletedOnDisk = false
        lastError = nil
    }

    public func saveAs(_ newURL: URL) throws {
        guard kind == .text else { throw TextFileError.readOnly }
        url = newURL
        ioURL = newURL.resolvingSymlinksInPath()
        stamp = nil
        try save(overwrite: true)
    }

    /// Cheap poll for the "changed on disk" and "deleted" banners.
    public func checkDisk() {
        guard kind == .text, let url = ioURL ?? url, let known = stamp else { return }
        guard let now = DiskStamp.read(url) else { if !deletedOnDisk { deletedOnDisk = true }; return }
        if deletedOnDisk { deletedOnDisk = false }
        let changed = now != known
        if changed != changedOnDisk { changedOnDisk = changed }
    }

    public func reloadFromDisk() throws {
        guard let url = url else { throw TextFileError.noPath }
        try load(url)
    }

    public func recordError(_ e: Error) { lastError = "\(e)" }
}
