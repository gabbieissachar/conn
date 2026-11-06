import Testing
import Foundation
@testable import ConnCore

/// A fresh invented folder under the temp directory. Nothing in these tests touches a real project.
func scratchFolder(_ files: [String], folders: [String] = []) throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("conn-explorer-\(UUID().uuidString)", isDirectory: true)
    let fm = FileManager.default
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    for f in folders { try fm.createDirectory(at: root.appendingPathComponent(f), withIntermediateDirectories: true) }
    for f in files {
        let u = root.appendingPathComponent(f)
        try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("invented text of \(f)\n".utf8).write(to: u)
    }
    return root
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock(); private var n = 0
    func bump() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

func realPath(_ url: URL) -> String {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    return realpath(url.path, &buf) != nil ? String(cString: buf) : url.path
}

@Suite("Explorer tree") struct FolderTreeTests {
    @Test func foldersComeFirstThenNamesInFinderOrderIgnoringCase() throws {
        let root = try scratchFolder(["file10.txt", "File2.txt", "file1.txt", "alpha/inner.txt", "Zeta/inner.txt", "beta.md"])
        let rows = FolderTree(root: root).rows()
        #expect(rows.map(\.label) == ["alpha", "Zeta", "beta.md", "file1.txt", "File2.txt", "file10.txt"])
        #expect(rows.map(\.kind) == [.folder, .folder, .file, .file, .file, .file])
    }

    @Test func gitBuildAndDSStoreAreHiddenUntilAskedFor() throws {
        let root = try scratchFolder([".git/HEAD", ".build/x", ".DS_Store", ".github/workflows/ci.yml", ".env.example", "main.swift"])
        let tree = FolderTree(root: root, compact: false)
        #expect(tree.rows().map(\.label) == [".github", ".env.example", "main.swift"])
        tree.showHidden = true
        #expect(tree.rows().map(\.label) == [".build", ".git", ".github", ".DS_Store", ".env.example", "main.swift"])
    }

    @Test func aChainOfSingleChildFoldersSharesOneRow() throws {
        let root = try scratchFolder(["Tests/StorefrontCoreTests/Deep/File.swift", "Sources/a.swift", "Sources/b.swift"])
        let tree = FolderTree(root: root)
        var rows = tree.rows()
        #expect(rows.map(\.label) == ["Sources", "Tests/StorefrontCoreTests/Deep"])
        #expect(rows[1].id == "Tests/StorefrontCoreTests/Deep")
        #expect(rows[1].chain == ["Tests", "Tests/StorefrontCoreTests", "Tests/StorefrontCoreTests/Deep"])
        tree.setExpanded("Tests/StorefrontCoreTests/Deep", true)
        rows = tree.rows()
        #expect(rows.map(\.label) == ["Sources", "Tests/StorefrontCoreTests/Deep", "File.swift"])
        #expect(rows[2].depth == 1)
        // A second child ends the chain at that folder.
        try Data("x".utf8).write(to: root.appendingPathComponent("Tests/other.txt"))
        tree.refresh()
        #expect(tree.rows().map(\.label) == ["Sources", "Tests", ])
        let none = FolderTree(root: root, compact: false)
        #expect(none.rows().map(\.label) == ["Sources", "Tests"])
    }

    @Test func expandingShowsChildrenAndCollapsingHidesThem() throws {
        let root = try scratchFolder(["src/a.swift", "src/b.swift", "src/lib/c.swift", "top.md"])
        let tree = FolderTree(root: root)
        #expect(tree.rows().map(\.label) == ["src", "top.md"])
        tree.toggle("src")
        #expect(tree.rows().map(\.label) == ["src", "lib", "a.swift", "b.swift", "top.md"])
        #expect(tree.rows().map(\.depth) == [0, 1, 1, 1, 0])
        tree.toggle("src")
        #expect(tree.rows().map(\.label) == ["src", "top.md"])
        tree.setExpanded("src", true); tree.collapseAll()
        #expect(tree.expanded.isEmpty)
    }

    @Test func revealExpandsEveryFolderAboveAFile() throws {
        let root = try scratchFolder(["a/b/c/file.swift", "a/other.txt"])
        let tree = FolderTree(root: root)
        tree.reveal(relative: "a/b/c/file.swift")
        let ids = tree.rows().map(\.id)
        #expect(ids.contains("a/b/c/file.swift"))
        #expect(tree.relativePath(of: root.appendingPathComponent("a/b/c/file.swift")) == "a/b/c/file.swift")
        #expect(tree.relativePath(of: root) == "")
        #expect(tree.relativePath(of: FileManager.default.temporaryDirectory) == nil)
    }

    @Test func aLinkToAParentFolderIsShownButNeverOpened() throws {
        let root = try scratchFolder(["real/file.txt", "other/x.txt"])
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("real/up"), withDestinationURL: root)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("real/self"), withDestinationURL: root.appendingPathComponent("real"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link-to-other"), withDestinationURL: root.appendingPathComponent("other"))
        let tree = FolderTree(root: root, compact: false)
        tree.setExpanded("real", true); tree.setExpanded("real/up", true); tree.setExpanded("real/self", true); tree.setExpanded("link-to-other", true)
        let rows = tree.rows()
        let up = try #require(rows.first { $0.id == "real/up" }), me = try #require(rows.first { $0.id == "real/self" })
        #expect(up.isLoop && up.kind == .folder && !up.canExpand && !up.isExpanded)
        #expect(me.isLoop && !me.isExpanded)
        let ok = try #require(rows.first { $0.id == "link-to-other" })
        #expect(ok.isSymlink && !ok.isLoop && ok.isExpanded)
        #expect(rows.contains { $0.id == "link-to-other/x.txt" })
    }

    @Test func anUnreadableFolderShowsANoteInsteadOfFailing() throws {
        let root = try scratchFolder(["locked/secret.txt", "open/a.txt"])
        let locked = root.appendingPathComponent("locked")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }
        let tree = FolderTree(root: root, compact: false)
        tree.setExpanded("locked", true)
        let rows = tree.rows()
        let note = try #require(rows.first { $0.isNote })
        #expect(note.label == "Cannot read this folder" && note.depth == 1)
        #expect(tree.isReadable)
        #expect(!FolderTree(root: locked).isReadable)
    }

    @Test func aHugeFolderShowsTheFirstEntriesAndANote() throws {
        let root = try scratchFolder((1...12).map { "many/file\($0).txt" })
        let tree = FolderTree(root: root, entryCap: 5)
        tree.setExpanded("many", true)
        let rows = tree.rows()
        #expect(rows.filter { $0.kind == .file }.map(\.label) == ["file1.txt", "file2.txt", "file3.txt", "file4.txt", "file5.txt"])
        #expect(rows.last?.isNote == true && rows.last?.label == "7 more items not shown")
    }

    @Test func changesOnDiskReachTheRowsAndAGoneFolderIsForgotten() throws {
        let root = try scratchFolder(["dir/a.txt", "dir/sub/x.txt", "keep.md"])
        let tree = FolderTree(root: root, compact: false)
        tree.setExpanded("dir", true); tree.setExpanded("dir/sub", true)
        #expect(tree.rows().map(\.id) == ["dir", "dir/sub", "dir/sub/x.txt", "dir/a.txt", "keep.md"])
        #expect(!tree.refresh())   // nothing changed
        try Data("n".utf8).write(to: root.appendingPathComponent("dir/new.txt"))
        #expect(tree.refresh())
        #expect(tree.rows().map(\.id).contains("dir/new.txt"))
        // The same through a background read applied afterwards.
        try Data("n".utf8).write(to: root.appendingPathComponent("dir/newer.txt"))
        let fresh = FolderTree.relist(tree.loadedDirectories, root: tree.root, showHidden: false)
        #expect(tree.apply(fresh))
        #expect(tree.rows().map(\.id).contains("dir/newer.txt"))
        // A folder moved away takes its expansion with it.
        try FileManager.default.moveItem(at: root.appendingPathComponent("dir/sub"), to: FileManager.default.temporaryDirectory.appendingPathComponent("moved-\(UUID().uuidString)"))
        #expect(tree.refresh())
        #expect(!tree.expanded.contains("dir/sub"))
        #expect(!tree.rows().map(\.id).contains("dir/sub"))
    }

    @Test func fileSizesAreReportedForTheTooltip() throws {
        let root = try scratchFolder(["a.txt"])
        try Data(repeating: 65, count: 1234).write(to: root.appendingPathComponent("b.txt"))
        let rows = FolderTree(root: root).rows()
        #expect(rows.first { $0.id == "b.txt" }?.size == 1234)
    }

    @Test func theWatcherCallsBackWhenAnotherProgramAddsAFile() throws {
        let root = try scratchFolder(["a.txt"])
        let calls = Counter()
        let w = FolderWatcher(root: root, queue: DispatchQueue(label: "watcher-test")) { calls.bump() }
        w.start()
        defer { w.stop() }
        var n = 0
        while n < 40 && calls.value == 0 {
            try Data("x".utf8).write(to: root.appendingPathComponent("added\(n).txt")); n += 1
            Thread.sleep(forTimeInterval: 0.25)
        }
        #expect(calls.value > 0, "no change reported (polling=\(w.isPolling))")
    }

    @Test func gitAndBuildChurnIsNoise() {
        #expect(FolderWatcher.isNoise("/p/.git/index"))
        #expect(FolderWatcher.isNoise("/p/.build/debug/x"))
        #expect(FolderWatcher.isNoise("/p/.git"))
        #expect(!FolderWatcher.isNoise("/p/.github/workflows/ci.yml"))
        #expect(!FolderWatcher.isNoise("/p/Sources/a.swift"))
    }
}

@Suite("File kinds and read-only views") struct FileKindTests {
    private func write(_ name: String, _ data: Data) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("conn-kind-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let u = dir.appendingPathComponent(name)
        try data.write(to: u)
        return u
    }

    @Test func textLargeAndBinaryAreToldApart() throws {
        let text = try write("notes.md", Data("# hello\n".utf8))
        #expect(FileKind.classify(text).kind == .text && FileKind.classify(text).size == 8)
        let big = try write("trace.jsonl", Data(repeating: 0x78, count: TextFile.sizeLimit + 1))
        #expect(FileKind.classify(big).kind == .large)
        let nul = try write("data.txt", Data([0x61, 0x00, 0x62]))
        #expect(FileKind.classify(nul).kind == .binary)
        let png = try write("logo.PNG", Data("not really a picture, but the name says it is".utf8))
        #expect(FileKind.classify(png).kind == .binary)
        let bigBinary = try write("blob.txt", Data([0x00]) + Data(repeating: 0x78, count: TextFile.sizeLimit + 1))
        #expect(FileKind.classify(bigBinary).kind == .binary)
        let empty = try write("empty.txt", Data())
        #expect(FileKind.classify(empty).kind == .text)
        #expect(FileKind.classify(text.deletingLastPathComponent().appendingPathComponent("missing.txt")) == (.text, 0))
    }

    @Test func aTextFileOpensEditableAndABinaryOpensAsAPlaceholder() throws {
        let text = try TextFile.open(try write("a.txt", Data("hi".utf8)))
        #expect(text.kind == .text && !text.isReadOnly && text.text == "hi")
        let png = try TextFile.open(try write("a.png", Data([1, 2, 3])))
        #expect(png.kind == .binary && png.isReadOnly && png.text.isEmpty && png.totalBytes == 3 && !png.isDirty)
        #expect(png.title == "a.png")
        #expect(throws: TextFileError.readOnly) { try png.save() }
        // Latin-1 text is not UTF-8: a placeholder, not an alert.
        let latin = try TextFile.open(try write("l.txt", Data([0x63, 0x61, 0x66, 0xE9])))
        #expect(latin.kind == .binary)
    }

    @Test func aLargeFileShowsItsFirstMegabyteCutOnACharacterBoundary() throws {
        // "€" is three bytes, and 1 MiB is not a multiple of three, so the cut falls inside a character.
        let euro = Data("€".utf8)
        var data = Data(); data.reserveCapacity(TextFile.sizeLimit + 3_000)
        while data.count <= TextFile.sizeLimit + 1 { data.append(euro) }
        let doc = try TextFile.open(try write("big.txt", data))
        #expect(doc.kind == .large && doc.isReadOnly && !doc.isDirty)
        #expect(doc.totalBytes == data.count)
        #expect(doc.text.count == (TextFile.headLimit - 1) / 3)
        #expect(doc.text.allSatisfy { $0 == "€" })
        #expect(throws: TextFileError.readOnly) { try doc.save() }
        #expect(throws: TextFileError.readOnly) { try doc.saveAs(FileManager.default.temporaryDirectory.appendingPathComponent("never.txt")) }
        doc.text += "typed"   // the view is not editable, but the model must still never be dirty or saveable
        #expect(!doc.isDirty)
    }

    @Test func theFirstEditPinsAPreviewTab() throws {
        let doc = try TextFile.open(try write("p.txt", Data("a".utf8)))
        doc.isPreview = true
        #expect(doc.isPreview)
        doc.text = "a"            // no change, still a preview
        #expect(doc.isPreview)
        doc.text = "ab"
        #expect(!doc.isPreview && doc.isDirty)
    }

    @Test func aFileDeletedByAnotherProgramIsNoticedAndSavingRestoresIt() throws {
        let url = try write("gone.txt", Data("keep me".utf8))
        let doc = try TextFile.open(url)
        doc.checkDisk()
        #expect(!doc.deletedOnDisk)
        let away = FileManager.default.temporaryDirectory.appendingPathComponent("away-\(UUID().uuidString)")
        try FileManager.default.moveItem(at: url, to: away)
        doc.checkDisk()
        #expect(doc.deletedOnDisk && doc.text == "keep me")
        try doc.save()
        #expect(!doc.deletedOnDisk)
        #expect(try String(contentsOf: url, encoding: .utf8) == "keep me")
    }
}

@Suite("Copy path") struct PathCopyTests {
    @Test func relativePathsCompareComponentsNotStrings() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("conn-copy-\(UUID().uuidString)")
        let b = base.appendingPathComponent("b"), bc = base.appendingPathComponent("bc")
        try FileManager.default.createDirectory(at: b.appendingPathComponent("Sources/App"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bc, withIntermediateDirectories: true)
        let file = b.appendingPathComponent("Sources/App/Main.swift")
        try Data("x".utf8).write(to: file)
        try Data("y".utf8).write(to: bc.appendingPathComponent("z.txt"))
        #expect(PathCopy.relative(of: file, to: b) == "Sources/App/Main.swift")
        #expect(PathCopy.relative(of: bc.appendingPathComponent("z.txt"), to: b) == nil)   // /a/b is not /a/bc
        #expect(PathCopy.relative(of: b, to: b) == ".")
        #expect(PathCopy.relative(of: b, to: file) == nil)
        // Through a symlinked folder, on either side.
        let link = base.appendingPathComponent("link-to-b")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: b)
        #expect(PathCopy.relative(of: file, to: link) == "Sources/App/Main.swift")
        #expect(PathCopy.relative(of: link.appendingPathComponent("Sources/App/Main.swift"), to: b) == "Sources/App/Main.swift")
    }

    @Test func spacesAndNonAsciiNamesSurvive() throws {
        let root = URL(fileURLWithPath: "/tmp/Mes Projets/café")
        let f = root.appendingPathComponent("Résumé final.md")
        #expect(PathCopy.relative(of: f, to: root) == "Résumé final.md")
    }

    @Test func whatEachCopyPutOnTheClipboard() {
        let folder = URL(fileURLWithPath: "/work/storefront")
        let inside = URL(fileURLWithPath: "/work/storefront/Sources/Pay.swift")
        let outside = URL(fileURLWithPath: "/elsewhere/notes.md")
        #expect(PathCopy.copy(inside, relative: false, folder: folder) == .path("/work/storefront/Sources/Pay.swift"))
        #expect(PathCopy.copy(inside, relative: true, folder: folder) == .relative("Sources/Pay.swift"))
        #expect(PathCopy.copy(outside, relative: true, folder: folder) == .fullBecauseOutside("/elsewhere/notes.md"))
        #expect(PathCopy.copy(inside, relative: true, folder: nil) == .fullBecauseOutside("/work/storefront/Sources/Pay.swift"))
        #expect(PathCopy.copy(nil, relative: false, folder: folder) == .none)
        #expect(PathCopy.Copied.none.text == nil)
        #expect(PathCopy.copy(outside, relative: true, folder: folder).title == "Copied path (outside the folder)")
        #expect(PathCopy.copy(inside, relative: false, folder: folder).title == "Copied path")
    }
}

@Suite("Go to file") struct QuickOpenTests {
    @Test func theScanSkipsGitBuildNodeModulesAndLinkedFolders() throws {
        let root = try scratchFolder(["Sources/App/Pay.swift", "README.md", ".git/HEAD", ".build/x.o", "node_modules/pkg/index.js", "docs/a/b/deep.md", ".github/ci.yml", "real/f.txt"])
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("linked"), withDestinationURL: root.appendingPathComponent("real"))
        let found = Set(QuickOpen.scan(root: root))
        #expect(found == ["Sources/App/Pay.swift", "README.md", "docs/a/b/deep.md", ".github/ci.yml", "real/f.txt"])
        #expect(QuickOpen.scan(root: root, limit: 2).count == 2)
    }

    @Test func fileNameMatchesBeatFolderMatchesAndLettersMustBeInOrder() {
        let paths = ["Sources/Payments/Receipt.swift", "Sources/App/PaymentSheetViewModel.swift", "docs/pay-notes.md", "Tests/PaySpec.swift", "Package.swift"]
        #expect(QuickOpen.score(query: "zzz", path: "Package.swift") == nil)
        #expect(QuickOpen.score(query: "wsp", path: "Package.swift") == nil)   // letters out of order
        let ranked = QuickOpen.rank(query: "pay", in: paths)
        #expect(ranked.first == "Tests/PaySpec.swift" || ranked.first == "docs/pay-notes.md")
        #expect(ranked.last == "Sources/Payments/Receipt.swift" || ranked.last == "Package.swift" || ranked.contains("Package.swift"))
        #expect(QuickOpen.rank(query: "psvm", in: paths).first == "Sources/App/PaymentSheetViewModel.swift")   // word starts
        #expect(QuickOpen.rank(query: "", in: paths, limit: 2).count == 2)
        #expect(QuickOpen.rank(query: "ReCeIpT", in: paths) == ["Sources/Payments/Receipt.swift"])
    }
}

@Suite("Explorer layout rules") struct ExplorerLayoutTests {
    @Test func theReaderStepsAsideWhenTheEditorWouldBeUnder520() {
        // 1500 wide, sidebar 251, Explorer 250 + 1, Reader 480 + 1: the editor would be 517.
        #expect(ExplorerLayout.readerStepsAside(windowWidth: 1500, sidebarVisible: true, explorerVisible: true, explorerWidth: 250, readerWidth: 480))
        #expect(!ExplorerLayout.readerStepsAside(windowWidth: 1600, sidebarVisible: true, explorerVisible: true, explorerWidth: 250, readerWidth: 480))
        #expect(!ExplorerLayout.readerStepsAside(windowWidth: 1000, sidebarVisible: true, explorerVisible: false, explorerWidth: 250, readerWidth: 480))
        #expect(!ExplorerLayout.readerStepsAside(windowWidth: 1300, sidebarVisible: false, explorerVisible: true, explorerWidth: 250, readerWidth: 480))
        #expect(ExplorerLayout.readerStepsAside(windowWidth: 1300, sidebarVisible: true, explorerVisible: true, explorerWidth: 250, readerWidth: 480))
    }
    @Test func widthsAreClamped() {
        #expect(ExplorerLayout.clamped(10) == 160 && ExplorerLayout.clamped(900) == 480 && ExplorerLayout.clamped(300) == 300)
    }
    @Test func aPreviewTabIsReplacedByTheNextPreview() {
        #expect(PreviewSlot.place(previewFlags: []) == .append)
        #expect(PreviewSlot.place(previewFlags: [false, false]) == .append)
        #expect(PreviewSlot.place(previewFlags: [false, true, false]) == .replace(1))
    }
    @Test func recentFoldersKeepTheNewestFirstWithoutRepeats() {
        #expect(RecentFolders.adding("/b", to: ["/a", "/b", "/c"]) == ["/b", "/a", "/c"])
        #expect(RecentFolders.adding("/n", to: (0..<10).map { "/\($0)" }).count == 10)
        #expect(RecentFolders.existing(["/nonexistent-\(UUID().uuidString)", NSTemporaryDirectory()]) == [NSTemporaryDirectory()])
    }
}
