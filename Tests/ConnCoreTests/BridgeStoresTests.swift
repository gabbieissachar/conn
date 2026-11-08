// The agent bridge's files and settings (S2): the session registry as `fm-session` lays it out, the ownership list, and the audit.
import Testing
import Foundation
import ConnCore

func bridgeTempDir(_ tag: String) -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("conn-bridge-\(tag)-\(UUID().uuidString.prefix(8))", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

@Suite("Bridge: the session registry") struct BridgeRegistryTests {
    private func meta(_ r: BridgeRegistry) -> [String: String] {
        var m: [String: String] = [:]
        for l in ((try? String(contentsOf: r.metaFile, encoding: .utf8)) ?? "").split(separator: "\n") { if let eq = l.firstIndex(of: "=") { m[String(l[..<eq])] = String(l[l.index(after: eq)...]) } }
        return m
    }

    @Test func defaultFolderFollowsFMSessionsDirThenXDGThenHome() {
        #expect(BridgeRegistry.defaultDirectory(env: ["FM_SESSIONS_DIR": "/tmp/lab"], home: "/h").path == "/tmp/lab")
        #expect(BridgeRegistry.defaultDirectory(env: ["XDG_STATE_HOME": "/x"], home: "/h").path == "/x/firstmate/sessions")
        #expect(BridgeRegistry.defaultDirectory(env: [:], home: "/h").path == "/h/.local/state/firstmate/sessions")
        #expect(BridgeRegistry.defaultDirectory(env: ["FM_SESSIONS_DIR": ""], home: "/h").path == "/h/.local/state/firstmate/sessions")
    }

    @Test func registeringWritesTheRecordFmWhoReadsAndTheFolders() throws {
        let r = BridgeRegistry(directory: bridgeTempDir("reg"))
        try r.register(pid: getpid())
        let m = meta(r)
        #expect(m["schema"] == "fm-session.v1" && m["name"] == "campus" && m["harness"] == "conn" && m["pid"] == "\(getpid())" && m["session_id"] == "conn-\(getpid())" && m["registered_at"]?.hasSuffix("Z") == true)
        var isDir: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: r.handled.path, isDirectory: &isDir) && isDir.boolValue && FileManager.default.fileExists(atPath: r.replies.path))
        let perms = (try? FileManager.default.attributesOfItem(atPath: r.directory.path)[.posixPermissions] as? Int) ?? 0
        #expect(perms & 0o077 == 0)
        #expect(r.registeredPID == getpid())
        r.unregister(pid: getpid())
        #expect(!FileManager.default.fileExists(atPath: r.metaFile.path) && FileManager.default.fileExists(atPath: r.inbox.path))      // the inbox stays
    }

    @Test func aSecondRunningProcessCannotTakeTheName() throws {
        let r = BridgeRegistry(directory: bridgeTempDir("held"))
        try r.register(pid: getppid())                       // the parent process: running, and not us
        #expect(throws: BridgeRegistry.RegisterError.heldByAnother(pid: getppid())) { try r.register(pid: getpid()) }
        r.unregister(pid: getpid())                          // not ours: nothing is removed
        #expect(r.registeredPID == getppid())
    }

    @Test func aRecordOfAProcessThatIsGoneIsReplacedAndClearedAtLaunch() throws {
        let r = BridgeRegistry(directory: bridgeTempDir("stale"))
        try r.register(pid: 2_000_000_000)                   // no such process
        try r.register(pid: getpid())                        // taking over a dead holder's name is allowed
        #expect(r.registeredPID == getpid())
        let r2 = BridgeRegistry(directory: bridgeTempDir("stale2"))
        try r2.register(pid: 2_000_000_000)
        r2.clearStale(pid: getpid())
        #expect(r2.registeredPID == nil)
        try r2.register(pid: getppid())
        r2.clearStale(pid: getpid())                          // a live holder is never cleared
        #expect(r2.registeredPID == getppid())
    }

    @Test func pendingRecordsComeInSequenceOrderAndRepliesAreWholeFiles() throws {
        let r = BridgeRegistry(directory: bridgeTempDir("pending"))
        try r.register()
        for n in ["010.msg", "002.msg", "001.msg"] { try Data(n.utf8).write(to: r.inbox.appendingPathComponent(n)) }
        try Data("x".utf8).write(to: r.inbox.appendingPathComponent("notes.txt"))
        #expect(r.pending().map(\.name) == ["001.msg", "002.msg", "010.msg"])
        try r.writeReply(id: "req-1", body: "status: done\nreply: hi")
        let text = try String(contentsOf: r.replies.appendingPathComponent("req-1"), encoding: .utf8)
        #expect(text.hasPrefix("schema=fm-session-reply.v1\nrequest_id=req-1\nat=") && text.hasSuffix("--\nstatus: done\nreply: hi\n"))
        #expect(r.replyExists("req-1") && !r.replyExists("req-2"))
        #expect((try? FileManager.default.contentsOfDirectory(atPath: r.replies.path))?.filter { $0.hasPrefix(".staging") }.isEmpty == true)
        #expect(throws: BridgeRegistry.RegisterError.self) { try r.writeReply(id: "../x", body: "no") }
        r.acknowledge(fileName: "001.msg")
        #expect(r.pending().map(\.name) == ["002.msg", "010.msg"] && FileManager.default.fileExists(atPath: r.handled.appendingPathComponent("001.msg").path))
    }

    /// What `fm-ask wait` reads: everything after the first `--` line of the reply file is the reply. A reply whose own text contains `--` lines is not cut.
    @Test func theReplyBodyIsEverythingAfterTheFirstDashLine() throws {
        let r = BridgeRegistry(directory: bridgeTempDir("body"))
        try r.register()
        let body = BridgeReply(.done, thread: "ses_a", reply: "first\n--\nsecond").render()
        try r.writeReply(id: "req-3", body: body)
        let raw = try String(contentsOf: r.replies.appendingPathComponent("req-3"), encoding: .utf8)
        let afterFirst = raw.components(separatedBy: "\n--\n").dropFirst().joined(separator: "\n--\n")
        #expect(afterFirst == body + "\n" && afterFirst.contains("first\n--\nsecond"))
    }
}

@Suite("Bridge: the threads agents may use") @MainActor struct BridgeOwnershipTests {
    private func fresh() -> UserDefaults { let n = "conn.tests.bridge.\(UUID().uuidString)"; let d = UserDefaults(suiteName: n)!; d.removePersistentDomain(forName: n); return d }
    private let a = CampusAddress(kind: "private", folder: "default", id: "ses_fakeNew01")
    private let b = CampusAddress(kind: "team", folder: "growth-ops", id: "ses_fakeKpi06")

    @Test func ownedAndSharedThreadsSurviveARelaunchAsAddressesAndModes() {
        let d = fresh()
        let o = BridgeOwnership(defaults: d)
        o.addOwned(a); o.setShared(b, .read)
        let again = BridgeOwnership(defaults: d)
        #expect(again.mode(of: "ses_fakeNew01") == .owned && again.mode(of: "ses_fakeKpi06") == .read && again.mode(of: "ses_other000") == nil)
        #expect((d.array(forKey: o.key) as? [String])?.sorted() == ["owned|private/default/ses_fakeNew01", "read|team/growth-ops/ses_fakeKpi06"])
        #expect(again.share(for: "ses_fakeKpi06")?.address == b)
    }

    @Test func theSharingModesAndWhatTheyAllow() {
        #expect(BridgeShare.owned.maySend && BridgeShare.readWrite.maySend && !BridgeShare.read.maySend && BridgeShare.read.mayRead)
        let o = BridgeOwnership(defaults: fresh())
        o.setShared(b, .read); o.setShared(b, .readWrite)
        #expect(o.mode(of: b.id) == .readWrite)
        o.setShared(b, nil)
        #expect(o.mode(of: b.id) == nil)
        o.addOwned(a); o.setShared(a, nil); o.setShared(a, .read)
        #expect(o.mode(of: a.id) == .owned)                 // a thread the bridge started has no off: delete it in Campus
    }

    @Test func junkInSettingsIsIgnored() {
        let d = fresh()
        d.set(["owned|private/default/ses_fakeNew01", "bogus|private/default/ses_x1234", "read|nonsense", "no bar here", "readwrite|team/../ses_abcd"], forKey: "conn.campus.bridge.threads")
        let o = BridgeOwnership(defaults: d)
        #expect(o.shares.count == 1 && o.mode(of: "ses_fakeNew01") == .owned)
    }
}

@Suite("Bridge: the audit") struct BridgeAuditTests {
    @Test func linesAreAppendedNeverRewrittenAndHoldNoText() throws {
        let file = bridgeTempDir("audit").appendingPathComponent("campus-bridge/audit.jsonl")
        let log = BridgeAuditLog(file: file)
        let now = Date()
        let secret = "the confidential message text"
        func e(_ id: String, at: Date) -> BridgeAuditEntry { BridgeAuditEntry(at: at, sender: "leader-esim", kind: "leader", requestID: id, thread: "ses_a1b2c3", action: "new", bytes: secret.utf8.count, sha256: BridgeContent.sha256(secret), outcome: "done") }
        log.append(e("r1", at: now.addingTimeInterval(-100)))
        let before = try Data(contentsOf: file)
        log.append(e("r2", at: now.addingTimeInterval(-50)))
        let after = try Data(contentsOf: file)
        #expect(after.starts(with: before) && after.count > before.count)           // the first line is untouched
        #expect(!String(decoding: after, as: UTF8.self).contains("confidential") && String(decoding: after, as: UTF8.self).contains(BridgeContent.sha256(secret)))
        #expect(log.read(now: now).map(\.requestID) == ["r1", "r2"])
        #expect(log.read(since: 75, now: now).map(\.requestID) == ["r2"])
        let perms = (try? FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int) ?? 0
        #expect(perms & 0o077 == 0)
        // A damaged line is skipped, not fatal.
        let h = try FileHandle(forWritingTo: file); try h.seekToEnd(); try h.write(contentsOf: Data("not json\n".utf8)); try h.close()
        #expect(log.read(now: now).count == 2)
    }
}
