import Testing
import Foundation
@testable import ConnCore

@Suite("Open requests") struct OpenRequestTests {
    @Test func aFolderAndFilesAreSortedAndTheFirstFolderWins() throws {
        let root = try scratchFolder(["one/a.swift", "two/b.swift", "c.md", "d.txt"])
        let one = root.appendingPathComponent("one"), two = root.appendingPathComponent("two")
        let r = OpenRequest(urls: [root.appendingPathComponent("c.md"), one, two, root.appendingPathComponent("d.txt"), root.appendingPathComponent("c.md")])
        #expect(r.folder?.path == one.resolvingSymlinksInPath().path)
        #expect(r.files.map(\.lastPathComponent) == ["c.md", "d.txt"])   // in order, each once
        #expect(r.ignoredFolders == 1 && r.skipped.isEmpty && !r.isEmpty)
    }

    @Test func filesAloneKeepTheOpenFolder() throws {
        let root = try scratchFolder(["a.txt"])
        let r = OpenRequest(urls: [root.appendingPathComponent("a.txt")])
        #expect(r.folder == nil && r.files.count == 1 && r.ignoredFolders == 0)
    }

    @Test func missingPathsAndPackagesAreSkippedNotOpened() throws {
        let root = try scratchFolder(["Thing.app/Contents/Info.plist", "ok.txt"])
        let gone = root.appendingPathComponent("gone.txt")
        let r = OpenRequest(urls: [gone, root.appendingPathComponent("Thing.app"), root.appendingPathComponent("ok.txt"), URL(string: "https://example.com/x")!])
        #expect(r.skipped.map(\.lastPathComponent) == ["gone.txt", "Thing.app"])
        #expect(r.files.map(\.lastPathComponent) == ["ok.txt"] && r.folder == nil)
        #expect(OpenRequest(urls: []).isEmpty)
    }

    @Test func aSymlinkedFolderOpensAsItsRealPathAndTheSameFolderTwiceCountsOnce() throws {
        let root = try scratchFolder(["real/a.txt"])
        let link = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root.appendingPathComponent("real"))
        let r = OpenRequest(urls: [link, root.appendingPathComponent("real")])
        #expect(r.folder?.path == root.appendingPathComponent("real").resolvingSymlinksInPath().path)
        #expect(r.ignoredFolders == 0)
    }

    @Test func spacesAndNonAsciiNamesWork() throws {
        let root = try scratchFolder(["Mes Projets/Résumé final.md", "日本語/メモ.txt"])
        let r = OpenRequest(urls: [root.appendingPathComponent("Mes Projets"), root.appendingPathComponent("日本語/メモ.txt")])
        #expect(r.folder?.lastPathComponent == "Mes Projets" && r.files.map(\.lastPathComponent) == ["メモ.txt"])
    }

    @Test func aFileInsideTheFolderIsFoundByTheTreeAfterwards() throws {
        let root = try scratchFolder(["Sources/App/Main.swift"])
        let r = OpenRequest(urls: [root, root.appendingPathComponent("Sources/App/Main.swift")])
        let tree = FolderTree(root: try #require(r.folder))
        #expect(tree.relativePath(of: try #require(r.files.first)) == "Sources/App/Main.swift")
    }
}

@Suite("conn command: install") struct CommandInstallTests {
    private func setup() throws -> (link: URL, script: URL, dir: URL) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("conn-install-\(UUID().uuidString)")
        let script = dir.appendingPathComponent("Conn.app/Contents/Resources/bin/conn")
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: script)
        return (dir.appendingPathComponent("home/.local/bin/conn"), script, dir)
    }

    @Test func installCreatesTheFolderAndALinkThatIsThenRecognised() throws {
        let (link, script, _) = try setup()
        #expect(CommandInstall.state(link: link, script: script) == .notInstalled)
        try CommandInstall.install(link: link, script: script)
        #expect(CommandInstall.state(link: link, script: script) == .installed)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: link.path) == script.path)
        try CommandInstall.install(link: link, script: script)   // again: nothing to do
        #expect(CommandInstall.state(link: link, script: script) == .installed)
    }

    @Test func aFileOrFolderOrOtherLinkIsNeverOverwritten() throws {
        let (link, script, dir) = try setup()
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("my own tool".utf8).write(to: link)
        #expect(CommandInstall.state(link: link, script: script) == .occupied("a file"))
        #expect(throws: CommandInstall.InstallError.self) { try CommandInstall.install(link: link, script: script) }
        #expect(throws: CommandInstall.InstallError.self) { try CommandInstall.uninstall(link: link, script: script) }
        #expect(try String(contentsOf: link, encoding: .utf8) == "my own tool")

        let other = dir.appendingPathComponent("home/.local/bin/other")
        try FileManager.default.createSymbolicLink(at: other, withDestinationURL: URL(fileURLWithPath: "/usr/bin/true"))
        #expect(CommandInstall.state(link: other, script: script) == .occupied("a link to /usr/bin/true"))
        #expect(throws: CommandInstall.InstallError.self) { try CommandInstall.install(link: other, script: script) }
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: other.path) == "/usr/bin/true")

        let folder = dir.appendingPathComponent("home/.local/bin/folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        #expect(CommandInstall.state(link: folder, script: script) == .occupied("a folder"))
    }

    @Test func aLinkToAMovedOrDeletedConnIsStaleAndReplaced() throws {
        let (link, script, dir) = try setup()
        let old = dir.appendingPathComponent("Old/Conn.app/Contents/Resources/bin/conn")   // never created: a dead link of ours
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: old)
        #expect(CommandInstall.state(link: link, script: script) == .stale(pointsTo: old.path))
        try CommandInstall.install(link: link, script: script)
        #expect(CommandInstall.state(link: link, script: script) == .installed)
    }

    @Test func uninstallRemovesOnlyOurLink() throws {
        let (link, script, _) = try setup()
        #expect(try CommandInstall.uninstall(link: link, script: script) == false)
        try CommandInstall.install(link: link, script: script)
        #expect(try CommandInstall.uninstall(link: link, script: script))
        #expect(CommandInstall.state(link: link, script: script) == .notInstalled)
        #expect(FileManager.default.fileExists(atPath: script.path))   // the script in the app is untouched
    }

    @Test func theLocalBinFolderIsFoundOnThePathOrInAShellFile() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("conn-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let bin = home.appendingPathComponent(".local/bin")
        #expect(!CommandInstall.likelyOnPath(directory: bin, environmentPath: "/usr/bin:/bin", home: home))
        #expect(CommandInstall.likelyOnPath(directory: bin, environmentPath: "/usr/bin:\(bin.path)", home: home))
        try Data("export PATH=\"$HOME/.local/bin:$PATH\"\n".utf8).write(to: home.appendingPathComponent(".zshrc"))
        #expect(CommandInstall.likelyOnPath(directory: bin, environmentPath: nil, home: home))
    }
}

/// The script itself, run against a stand-in `open` that records its arguments: no Conn is started and nothing comes forward.
@Suite("conn command: the script") struct ConnScriptTests {
    struct Rig {
        let root: URL, link: URL, stubDir: URL, app: URL
        func run(_ args: [String], cwd: URL? = nil, env: [String: String] = [:]) throws -> (status: Int32, out: String, err: String, opened: [String]?) {
            let record = root.appendingPathComponent("opened-\(UUID().uuidString).txt")   // a fresh file per run: nothing is deleted
            let p = Process()
            p.executableURL = link
            p.arguments = args
            p.currentDirectoryURL = cwd ?? root
            var e: [String: String] = ["PATH": "\(stubDir.path):/usr/bin:/bin", "STUB_RECORD": record.path, "HOME": root.path]
            e.merge(env) { $1 }
            p.environment = e
            let o = Pipe(), er = Pipe()
            p.standardOutput = o; p.standardError = er
            try p.run(); p.waitUntilExit()
            let out = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let err = String(data: er.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let opened = (try? String(contentsOf: record, encoding: .utf8)).map { $0.split(separator: "\n", omittingEmptySubsequences: false).dropLast().map(String.init) }
            return (p.terminationStatus, out, err, opened)
        }
    }

    static var script: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/bin/conn")
    }

    /// A fake Conn.app holding a copy of the real script, a link to it in a bin folder, and a stub `open`.
    private func rig() throws -> Rig {
        let root = URL(fileURLWithPath: realPath(FileManager.default.temporaryDirectory)).appendingPathComponent("conn-script-\(UUID().uuidString)")
        let fm = FileManager.default
        let app = root.appendingPathComponent("Apps/Conn.app")
        let inApp = app.appendingPathComponent("Contents/Resources/bin/conn")
        try fm.createDirectory(at: inApp.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try fm.copyItem(at: Self.script, to: inApp)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: inApp.path)
        let link = root.appendingPathComponent("home/.local/bin/conn")
        try fm.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: link, withDestinationURL: inApp)
        let stubDir = root.appendingPathComponent("stub")
        try fm.createDirectory(at: stubDir, withIntermediateDirectories: true)
        let stub = stubDir.appendingPathComponent("open")
        try Data("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$STUB_RECORD\"\n".utf8).write(to: stub)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
        return Rig(root: root, link: link, stubDir: stubDir, app: app)
    }

    @Test func noArgumentOpensTheCurrentFolderThroughTheBundleTheScriptIsIn() throws {
        let r = try rig()
        let work = r.root.appendingPathComponent("work/project")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let res = try r.run([], cwd: work)
        #expect(res.status == 0, "\(res.err)")
        #expect(res.opened == ["-a", r.app.path, work.path])
    }

    @Test func dotAndRelativeNamesBecomeAbsolutePhysicalPaths() throws {
        let r = try rig()
        let project = r.root.appendingPathComponent("work/project")
        try FileManager.default.createDirectory(at: project.appendingPathComponent("src"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: project.appendingPathComponent("src/main.swift"))
        try Data("x".utf8).write(to: project.appendingPathComponent("README.md"))
        let alias = r.root.appendingPathComponent("work/alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: project)
        let res = try r.run([".", "src/main.swift", "../project/README.md", "src/../src"], cwd: alias)
        #expect(res.status == 0, "\(res.err)")
        #expect(res.opened == ["-a", r.app.path, project.path, project.path + "/src/main.swift", project.path + "/README.md", project.path + "/src"])
    }

    @Test func spacesQuotesAndNonAsciiNamesStayOneArgumentEach() throws {
        let r = try rig()
        let dir = r.root.appendingPathComponent("My Projects/café 'x'")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: dir.appendingPathComponent("Résumé; $HOME.md"))
        let res = try r.run([dir.path, "Résumé; $HOME.md"], cwd: dir)
        #expect(res.status == 0, "\(res.err)")
        #expect(res.opened == ["-a", r.app.path, dir.path, dir.path + "/Résumé; $HOME.md"])
    }

    @Test func aFileDirectlyUnderRootGetsNoDoubleSlash() throws {
        let r = try rig()
        let res = try r.run(["/etc/hosts"], cwd: r.root)
        // /etc is a link to /private/etc on macOS: the physical folder is used, and there is never a "//".
        #expect(res.status == 0 && res.opened?.last == "/private/etc/hosts" && !(res.opened?.last?.contains("//") ?? true))
        let slash = try r.run(["/"], cwd: r.root)
        #expect(slash.opened?.last == "/")
    }

    @Test func aMissingPathStopsEverythingAndLaunchesNothing() throws {
        let r = try rig()
        try Data("x".utf8).write(to: r.root.appendingPathComponent("here.txt"))
        let res = try r.run(["here.txt", "nope.txt"])
        #expect(res.status == 1)
        #expect(res.err.contains("conn: no such file or directory: nope.txt"))
        #expect(res.opened == nil)
    }

    @Test func anUnknownOptionIsRefusedAndDoubleDashEndsOptions() throws {
        let r = try rig()
        let bad = try r.run(["--wait", "."])
        #expect(bad.status == 2 && bad.err.contains("unknown option: --wait") && bad.opened == nil)
        try Data("x".utf8).write(to: r.root.appendingPathComponent("-odd.txt"))
        let ok = try r.run(["--", "-odd.txt"])
        #expect(ok.status == 0 && ok.opened == ["-a", r.app.path, r.root.path + "/-odd.txt"])
        let help = try r.run(["--help"])
        #expect(help.status == 0 && help.out.contains("usage: conn") && help.opened == nil)
    }

    @Test func aLinkToAnAppThatIsGoneSaysSoInsteadOfLaunchingAnything() throws {
        let r = try rig()
        // The bundle lost its executable folder (a half-deleted app): the script says so and launches nothing.
        try FileManager.default.moveItem(at: r.app.appendingPathComponent("Contents/MacOS"), to: r.root.appendingPathComponent("MacOS-moved"))
        let res = try r.run(["."])
        #expect(res.status == 1 && res.err.contains("cannot find Conn.app") && res.opened == nil)
        // A copy of the script that is not inside any app has no bundle to open.
        let loose = r.root.appendingPathComponent("loose-conn")
        try FileManager.default.copyItem(at: r.app.appendingPathComponent("Contents/Resources/bin/conn"), to: loose)
        let p = Process(); p.executableURL = loose; p.arguments = ["."]
        p.environment = ["PATH": "\(r.stubDir.path):/usr/bin:/bin"]
        let e = Pipe(); p.standardError = e
        try p.run(); p.waitUntilExit()
        #expect(p.terminationStatus == 1)
    }

    @Test func connAppAndOpenFlagsCanBeSetForATestLaunch() throws {
        let r = try rig()
        let other = r.root.appendingPathComponent("Other.app")
        try FileManager.default.createDirectory(at: other.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        let res = try r.run(["."], env: ["CONN_APP": other.path, "CONN_OPEN_FLAGS": "-g -j"])
        #expect(res.status == 0 && res.opened == ["-g", "-j", "-a", other.path, r.root.path])
    }
}
