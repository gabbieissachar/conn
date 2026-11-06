import Testing
import Foundation
import ConnCore

/// The config file the Herdr client mode starts its client with. Every test runs in a fresh fake home, never the real one.
@Suite("Herdr client config") struct HerdrClientConfigTests {
    /// A fresh fake home with a Herdr config folder (holding a config.toml) and a temporary folder inside it.
    struct Home {
        let path: String
        let temp: String
        let herdrConfig: String
        init() throws {
            let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-client-config-\(UUID().uuidString)")
            path = base.appendingPathComponent("home").path
            temp = base.appendingPathComponent("tmp").path
            herdrConfig = path + "/.config/herdr/config.toml"
            let fm = FileManager.default
            try fm.createDirectory(atPath: path + "/.config/herdr", withIntermediateDirectories: true)
            try fm.createDirectory(atPath: temp, withIntermediateDirectories: true)
            try "[keys]\nprefix = \"ctrl+a\"\n\n[ui]\nsidebar_width = 30\nsidebar_start_collapsed = false\n".write(toFile: herdrConfig, atomically: true, encoding: .utf8)
        }
        func validate(_ p: String) throws -> URL { try HerdrClientConfig.validate(p, home: path, temporaryDirectory: temp) }
        func resolve(hide: Bool, custom: String? = nil) throws -> URL? {
            try HerdrClientConfig.resolve(hideSidebar: hide, custom: custom, home: path, temporaryDirectory: temp, sourceConfig: URL(fileURLWithPath: herdrConfig))
        }
    }

    @Test func theGeneratedFileIsThePersonsConfigWithTheSidebarHidden() throws {
        let h = try Home()
        let url = try #require(try h.resolve(hide: true))
        let text = try String(contentsOf: url, encoding: .utf8)
        let settings = text.split(separator: "\n").filter { !$0.hasPrefix("#") && !$0.isEmpty }.map(String.init)
        // Their prefix key and their own [ui] setting survive; their old value of a sidebar key does not.
        #expect(settings == ["[keys]", "prefix = \"ctrl+a\"", "[ui]", "sidebar_start_collapsed = true", "sidebar_collapsed_mode = \"hidden\"", "sidebar_width = 30"])
        // It is Conn's own file, in Conn's folder, never in Herdr's.
        #expect(url.path.hasSuffix("/Library/Application Support/Conn/herdr-client/hidden-sidebar.toml"))
        #expect(!url.path.contains("/.config/herdr"))
    }

    @Test func theUsersHerdrConfigIsNeverTouched() throws {
        let h = try Home()
        let before = try String(contentsOfFile: h.herdrConfig, encoding: .utf8)
        _ = try h.resolve(hide: true)
        _ = try h.resolve(hide: true)
        #expect(try String(contentsOfFile: h.herdrConfig, encoding: .utf8) == before)
        let entries = try FileManager.default.contentsOfDirectory(atPath: h.path + "/.config/herdr")
        #expect(entries == ["config.toml"])
    }

    @Test func withNoHerdrConfigTheGeneratedFileHoldsOnlyTheSidebarKeys() throws {
        let h = try Home()
        try FileManager.default.removeItem(atPath: h.herdrConfig)
        let url = try #require(try h.resolve(hide: true))
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.split(separator: "\n").filter { !$0.hasPrefix("#") && !$0.isEmpty }.map(String.init)
                == ["[ui]", "sidebar_start_collapsed = true", "sidebar_collapsed_mode = \"hidden\""])
    }

    @Test func aConfigWhoseUiTableIsWrittenInAnUnsafeFormIsReportedNotRewritten() throws {
        let h = try Home()
        try "ui.sidebar_width = 30\n".write(toFile: h.herdrConfig, atomically: true, encoding: .utf8)
        #expect(throws: HerdrClientConfig.Failure.cannotMerge(h.herdrConfig)) { try h.resolve(hide: true) }
        #expect(!FileManager.default.fileExists(atPath: HerdrClientConfig.supportDirectory(home: h.path).appendingPathComponent("hidden-sidebar.toml").path))
        let big = String(repeating: "#", count: HerdrClientConfig.maxBytes + 1)
        try big.write(toFile: h.herdrConfig, atomically: true, encoding: .utf8)
        #expect(throws: HerdrClientConfig.Failure.tooLarge(h.herdrConfig)) { try h.resolve(hide: true) }
    }

    @Test func theSourceConfigIsFoundWhereHerdrReadsIt() {
        #expect(HerdrClientConfig.defaultSourceConfig(environment: [:], home: "/Users/a").path == "/Users/a/.config/herdr/config.toml")
        #expect(HerdrClientConfig.defaultSourceConfig(environment: ["XDG_CONFIG_HOME": "/x"], home: "/Users/a").path == "/x/herdr/config.toml")
        #expect(HerdrClientConfig.defaultSourceConfig(environment: ["HERDR_CONFIG_PATH": "/y/c.toml", "XDG_CONFIG_HOME": "/x"], home: "/Users/a").path == "/y/c.toml")
        #expect(HerdrClientConfig.defaultSourceConfig(environment: ["HERDR_CONFIG_PATH": "relative.toml"], home: "/Users/a").path == "/Users/a/.config/herdr/config.toml")
    }

    @Test func mergingSetsTheTwoKeysUnderUiAndKeepsEveryOtherLine() {
        func body(_ s: String?) -> [String]? {
            HerdrClientConfig.hiddenSidebarContents(merging: s).map { $0.components(separatedBy: "\n").filter { !$0.hasPrefix("# ") && !$0.isEmpty } }
        }
        let keys = ["sidebar_start_collapsed = true", "sidebar_collapsed_mode = \"hidden\""]
        #expect(body(nil) == ["[ui]"] + keys)
        #expect(body("  \n") == ["[ui]"] + keys)
        // No [ui] table: it is added at the end, after whatever table the file ended in.
        #expect(body("[theme]\nname = \"x\"") == ["[theme]", "name = \"x\"", "[ui]"] + keys)
        // A [ui] table in the middle: the keys go right under its header, the person's own values for them are dropped,
        // and the tables around it are untouched.
        #expect(body("[a]\nx = 1\n[ui]\nsidebar_collapsed_mode = \"compact\"\n  sidebar_start_collapsed=false # old\nsidebar_width = 30\n[b]\nsidebar_collapsed_mode = \"keep\"\n")
                == ["[a]", "x = 1", "[ui]"] + keys + ["sidebar_width = 30", "[b]", "sidebar_collapsed_mode = \"keep\""])
        // A header with spacing and a comment, CRLF line ends, a sub-table and an array table named like it.
        #expect(body("[[ui]]\r\nk = 1\r\n[ ui ] # sidebar\r\nz = 2\r\n[ui.sidebar]\r\nq = 3\r\n") == ["[[ui]]", "k = 1", "[ ui ] # sidebar"] + keys + ["z = 2", "[ui.sidebar]", "q = 3"])
        #expect(body("[[ui]]\nk = 1\n") == ["[[ui]]", "k = 1", "[ui]"] + keys)
        // Forms a line edit cannot touch safely.
        #expect(body("ui.sidebar_width = 30\n") == nil)
        #expect(body("\"ui\".x = 1\n") == nil)
        #expect(body("ui = { sidebar_width = 30 }\n") == nil)
        #expect(body("[ui]\na = 1\n[x]\n[ui]\nb = 2\n") == nil)
        // The same key name outside the root before a header does not matter once a table has started.
        #expect(body("[x]\nui.y = 1\n") == ["[x]", "ui.y = 1", "[ui]"] + keys)
    }

    @Test func withTheSidebarLeftOnAndNoCustomPathTheClientReadsHerdrsOwnConfig() throws {
        let h = try Home()
        #expect(try h.resolve(hide: false) == nil)
        // Nothing was written either.
        #expect(!FileManager.default.fileExists(atPath: HerdrClientConfig.supportDirectory(home: h.path).path))
    }

    @Test func aStaleOrEditedGeneratedFileIsRewrittenAndAnUnchangedOneIsLeftAlone() throws {
        let h = try Home()
        let url = try #require(try h.resolve(hide: true))
        try "[ui]\nsidebar_start_collapsed = false\n".write(to: url, atomically: true, encoding: .utf8)
        _ = try h.resolve(hide: true)
        #expect(try String(contentsOf: url, encoding: .utf8).contains("sidebar_start_collapsed = true\n"))
        #expect(!(try String(contentsOf: url, encoding: .utf8).contains("sidebar_start_collapsed = false")))
        let m1 = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
        _ = try h.resolve(hide: true)
        #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date == m1)
    }

    @Test func aCustomPathWinsAndIsCheckedEvenWhenTheSidebarToggleIsOff() throws {
        let h = try Home()
        let custom = h.temp + "/mine.toml"
        try "[ui]\nsidebar_start_collapsed = true\n".write(toFile: custom, atomically: true, encoding: .utf8)
        let url = try #require(try h.resolve(hide: false, custom: custom))
        #expect(url.lastPathComponent == "mine.toml")
        #expect(throws: HerdrClientConfig.Failure.self) { try h.resolve(hide: false, custom: h.herdrConfig) }
    }

    @Test func aPathInHerdrsOwnConfigFolderIsRefused() throws {
        let h = try Home()
        #expect(throws: HerdrClientConfig.Failure.insideHerdrConfig(h.herdrConfig)) { try h.validate(h.herdrConfig) }
        // A path that only looks like it is elsewhere.
        let sneaky = h.temp + "/../home/.config/herdr/config.toml"
        #expect(throws: HerdrClientConfig.Failure.self) { try h.validate(sneaky) }
    }

    @Test func aLinkInAnAllowedFolderThatPointsAtHerdrsConfigIsRefused() throws {
        let h = try Home()
        let link = h.temp + "/link.toml"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: h.herdrConfig)
        #expect(throws: HerdrClientConfig.Failure.insideHerdrConfig(link)) { try h.validate(link) }
        // The same for a link that leaves the allowed folders for somewhere that is not Herdr's.
        let elsewhere = h.path + "/notes.toml"
        try "x".write(toFile: elsewhere, atomically: true, encoding: .utf8)
        let link2 = h.temp + "/link2.toml"
        try FileManager.default.createSymbolicLink(atPath: link2, withDestinationPath: elsewhere)
        #expect(throws: HerdrClientConfig.Failure.outsideAllowedFolders(link2)) { try h.validate(link2) }
    }

    @Test func aConnFolderThatIsALinkIntoHerdrsConfigFolderWritesNothing() throws {
        let h = try Home()
        let conn = HerdrClientConfig.supportDirectory(home: h.path).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: conn.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: conn.path, withDestinationPath: h.path + "/.config/herdr")
        #expect(throws: HerdrClientConfig.Failure.self) { try h.resolve(hide: true) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: h.path + "/.config/herdr") == ["config.toml"])
    }

    @Test func pathsOutsideConnsFolderAndTheTemporaryFolderAreRefused() throws {
        let h = try Home()
        let other = h.path + "/Documents/c.toml"
        try FileManager.default.createDirectory(atPath: h.path + "/Documents", withIntermediateDirectories: true)
        try "x".write(toFile: other, atomically: true, encoding: .utf8)
        #expect(throws: HerdrClientConfig.Failure.outsideAllowedFolders(other)) { try h.validate(other) }
    }

    @Test func malformedPathsAndFilesAreRefused() throws {
        let h = try Home()
        #expect(throws: HerdrClientConfig.Failure.notAbsolute("relative.toml")) { try h.validate("relative.toml") }
        #expect(throws: HerdrClientConfig.Failure.notAbsolute("~/x.toml")) { try h.validate("~/x.toml") }
        #expect(throws: HerdrClientConfig.Failure.unprintable) { try h.validate(h.temp + "/a\nb.toml") }
        #expect(throws: HerdrClientConfig.Failure.notFound(h.temp + "/missing.toml")) { try h.validate(h.temp + "/missing.toml") }
        #expect(throws: HerdrClientConfig.Failure.notAFile(h.temp)) { try h.validate(h.temp) }
        let big = h.temp + "/big.toml"
        try String(repeating: "#", count: HerdrClientConfig.maxBytes + 1).write(toFile: big, atomically: true, encoding: .utf8)
        #expect(throws: HerdrClientConfig.Failure.tooLarge(big)) { try h.validate(big) }
        let binary = h.temp + "/bin.toml"
        try Data([0xff, 0xfe, 0x00, 0x01]).write(to: URL(fileURLWithPath: binary))
        #expect(throws: HerdrClientConfig.Failure.notText(binary)) { try h.validate(binary) }
    }
}
