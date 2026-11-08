import Testing
import Foundation
@testable import ConnCore

@Suite("Reader file links") struct ReaderFileRefTests {
    @Test func aRegularFileOpensAndAFileWithSpacesToo() throws {
        let root = try scratchFolder(["plans/Q4 plan.md", "a.md"])
        let a = root.appendingPathComponent("a.md").path
        #expect(ReaderFileRef.check(a) == .open(URL(fileURLWithPath: a).standardizedFileURL))
        let spaced = root.appendingPathComponent("plans/Q4 plan.md").path
        #expect(ReaderFileRef.check(spaced) == .open(URL(fileURLWithPath: spaced).standardizedFileURL))
    }

    @Test func aLinkToAFileOpensItsTargetsContentButAFolderLinkDoesNot() throws {
        let root = try scratchFolder(["real/a.md"])
        let linkToFile = root.appendingPathComponent("alias.md"), linkToDir = root.appendingPathComponent("dir-alias")
        try FileManager.default.createSymbolicLink(at: linkToFile, withDestinationURL: root.appendingPathComponent("real/a.md"))
        try FileManager.default.createSymbolicLink(at: linkToDir, withDestinationURL: root.appendingPathComponent("real"))
        if case .open = ReaderFileRef.check(linkToFile.path) {} else { Issue.record("a link to a file should open") }
        #expect(ReaderFileRef.check(linkToDir.path) == .refused(name: "dir-alias", reason: "it is a folder, not a file"))
    }

    @Test func aPathThatIsNotAbsoluteIsRefusedWhateverTheCurrentFolderHolds() throws {
        let root = try scratchFolder(["a.md"])
        for bad in ["a.md", "./a.md", "../a.md", "~/a.md", "file:///tmp/a.md", "https://example.com/a.md"] {
            guard case .refused(_, let reason) = ReaderFileRef.check(bad, lookup: { _ in .regularFile }) else { Issue.record("\(bad) should be refused"); continue }
            #expect(reason == "the page gave a path that is not absolute", "\(bad)")
        }
        _ = root
    }

    @Test func aMissingPathAFolderAndAnythingElseAreRefusedByName() throws {
        let root = try scratchFolder(["dir/x.md"])
        #expect(ReaderFileRef.check(root.appendingPathComponent("gone.md").path) == .refused(name: "gone.md", reason: "it does not exist"))
        #expect(ReaderFileRef.check(root.appendingPathComponent("dir").path) == .refused(name: "dir", reason: "it is a folder, not a file"))
        #expect(ReaderFileRef.check("/dev/null") == .refused(name: "null", reason: "it is not a regular file"))
    }

    @Test func emptyOversizeAndControlCharacterPathsAreRefusedBeforeAnyLookup() {
        var looked = 0
        let spy: (String) -> ReaderFileRef.Kind = { _ in looked += 1; return .regularFile }
        let long = "/" + String(repeating: "a", count: ReaderFileRef.maxPathBytes)
        for bad in ["", "/tmp/a\n.md", "/tmp/a\u{0}.md", "/tmp/a\u{7F}.md", long] {
            if case .open = ReaderFileRef.check(bad, lookup: spy) { Issue.record("should be refused") }
        }
        #expect(looked == 0)
    }

    @Test func dotDotSegmentsAreResolvedBeforeTheCheckAndTheOpenedURLIsTheResolvedOne() throws {
        let root = try scratchFolder(["a/b/c.md"])
        let wiggly = root.path + "/a/b/../b/./c.md"
        let want = root.appendingPathComponent("a/b/c.md").standardizedFileURL
        #expect(ReaderFileRef.check(wiggly) == .open(want))
    }

    @Test func theNoticeNamesTheFileAndCapitalisesTheReason() {
        let n = ReaderFileRef.notice(name: "plan.md", reason: "it does not exist")
        #expect(n.title == "Conn did not open “plan.md”" && n.detail == "It does not exist")
    }

    @Test func aNoticeNeverCarriesPageTextBeyondTheLastComponentWithoutControlCharacters() {
        guard case .refused(let name, _) = ReaderFileRef.check("relative/very\tbad\nname.md") else { Issue.record("should be refused"); return }
        #expect(name == "verybadname.md")
    }
}
