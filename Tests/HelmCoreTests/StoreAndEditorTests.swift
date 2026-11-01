import Testing
import Foundation
@testable import HelmCore
import FakeHerdrKit

@Suite("Store") struct StoreTests {
    @Test func storeFollowsEventsAndReconnectsAfterAServerRestart() throws {
        let dir = shortSocketDir()
        let (server, endpoint) = try makeServer(agents: 4, dir: dir)
        let store = HerdrStore(client: HerdrClient(endpoint: endpoint), queue: testQueue)
        store.backoffInitial = 0.1; store.backoffMax = 0.4; store.pingInterval = 0.3
        store.start()
        defer { store.stop() }
        #expect(waitUntil { store.link == .live && store.snapshot.agents.count == 4 })
        // A status change on the server reaches the snapshot through an event.
        let pane = store.snapshot.agents[0].id
        _ = try HerdrClient(endpoint: endpoint).rawCall(method: "fake.set_state", params: ["pane_id": pane, "state": "blocked"])
        #expect(waitUntil { store.snapshot.agent(pane)?.state == .blocked })
        // Server restart: the store notices, retries, and comes back with an outage time.
        server.stop()
        #expect(waitUntil { if case .reconnecting = store.link { return true } else { return false } })
        let (server2, _) = try makeServer(agents: 5, dir: dir)
        defer { server2.stop() }
        #expect(waitUntil(8) { store.link == .live && store.snapshot.agents.count == 5 })
        #expect(store.reconnectCount >= 1)
        #expect((store.lastOutageSeconds ?? -1) >= 0)
    }

    @Test func aWedgedServerIsDetectedByTheHealthPing() throws {
        let (server, endpoint) = try makeServer(agents: 2)
        defer { server.stop() }
        let client = HerdrClient(endpoint: endpoint)
        client.timeout = 0.3
        let store = HerdrStore(client: client, queue: testQueue)
        store.backoffInitial = 0.1; store.backoffMax = 0.2; store.pingInterval = 0.2
        store.start()
        defer { store.stop() }
        #expect(waitUntil { store.link == .live })
        _ = try HerdrClient(endpoint: endpoint).rawCall(method: "fake.stall", params: ["on": true])
        #expect(waitUntil(6) { if case .reconnecting = store.link { return true } else { return false } })
        _ = try? HerdrClient(endpoint: endpoint).rawCall(method: "fake.stall", params: ["on": false])
    }
}

@Suite("Editor document") struct TextFileTests {
    private func tempFile(_ name: String, _ content: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("helm-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        try Data(content.utf8).write(to: url)
        return url
    }

    @Test func opensEditsAndSaves() throws {
        let url = try tempFile("notes.md", "# Title\n")
        let doc = try TextFile(opening: url)
        #expect(doc.isMarkdown && !doc.isDirty && doc.title == "notes.md")
        doc.text += "more\n"
        #expect(doc.isDirty)
        try doc.save()
        #expect(!doc.isDirty)
        #expect(try String(contentsOf: url, encoding: .utf8) == "# Title\nmore\n")
    }

    @Test func refusesToOverwriteANewerVersionOnDisk() throws {
        let url = try tempFile("a.txt", "one")
        let doc = try TextFile(opening: url)
        Thread.sleep(forTimeInterval: 0.05)
        try Data("changed elsewhere".utf8).write(to: url)
        doc.text = "mine"
        #expect(throws: TextFileError.changedOnDisk) { try doc.save() }
        #expect(doc.changedOnDisk)
        #expect(try String(contentsOf: url, encoding: .utf8) == "changed elsewhere")
        try doc.save(overwrite: true)
        #expect(try String(contentsOf: url, encoding: .utf8) == "mine")
    }

    @Test func refusesBinaryAndHugeFiles() throws {
        let bin = try tempFile("b.bin", "")
        try Data([0x41, 0x00, 0x42]).write(to: bin)
        #expect(throws: TextFileError.notText("b.bin")) { try TextFile(opening: bin) }
        let big = try tempFile("big.txt", String(repeating: "x", count: TextFile.sizeLimit + 1))
        #expect(throws: TextFileError.self) { try TextFile(opening: big) }
        let latin = try tempFile("l.txt", "")
        try Data([0xE9, 0x41]).write(to: latin)   // invalid UTF-8
        #expect(throws: TextFileError.notText("l.txt")) { try TextFile(opening: latin) }
    }

    @Test func savingThroughASymlinkEditsTheTargetAndKeepsTheLink() throws {
        let target = try tempFile("AGENTS.md", "original\n")
        let link = target.deletingLastPathComponent().appendingPathComponent("CLAUDE.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let doc = try TextFile(opening: link)
        doc.text = "edited\n"
        try doc.save()
        #expect(try String(contentsOf: target, encoding: .utf8) == "edited\n")
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: link.path)) != nil)
        #expect(try String(contentsOf: link, encoding: .utf8) == "edited\n")
    }

    @Test func savingAHardLinkedFileKeepsBothNamesInSync() throws {
        let a = try tempFile("a.txt", "one\n")
        let b = a.deletingLastPathComponent().appendingPathComponent("b.txt")
        try FileManager.default.linkItem(at: a, to: b)
        let doc = try TextFile(opening: b)
        doc.text = "two\n"
        try doc.save()
        #expect(try String(contentsOf: a, encoding: .utf8) == "two\n")
        #expect(try String(contentsOf: b, encoding: .utf8) == "two\n")
    }

    @Test func aByteOrderMarkSurvivesARoundTrip() throws {
        let url = try tempFile("bom.txt", "")
        try Data([0xEF, 0xBB, 0xBF] + Array("hello\n".utf8)).write(to: url)
        let doc = try TextFile(opening: url)
        #expect(doc.text == "hello\n")
        doc.text = "hello world\n"
        try doc.save()
        #expect(try Data(contentsOf: url).starts(with: [0xEF, 0xBB, 0xBF]))
        #expect(try String(contentsOf: url, encoding: .utf8).contains("hello world"))
    }

    @Test func saveAsCreatesTheFileAndKeepsTheDocumentOpen() throws {
        let doc = TextFile(text: "draft")
        #expect(throws: TextFileError.noPath) { try doc.save() }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("helm-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try doc.saveAs(dir.appendingPathComponent("new.md"))
        #expect(doc.title == "new.md" && !doc.isDirty && doc.isMarkdown)
    }
}

@Suite("Store hardening") struct StoreHardeningTests {
    @Test func aSnapshotWithUnknownFieldsIsMalformedNotAnEmptyLiveSession() {
        let renamed = #"{"id":"x","result":{"type":"session_snapshot","snapshot":{"protocol":22,"pane_list":[],"status":"x"}}}"#
        let obj = (try? JSONSerialization.jsonObject(with: Data(renamed.utf8))) as? [String: Any]
        #expect(obj != nil && Snapshot(response: obj!) == nil)
        let empty = #"{"id":"x","result":{"type":"session_snapshot","snapshot":{"protocol":22,"version":"0.9.5","workspaces":[],"panes":[]}}}"#
        let e = (try? JSONSerialization.jsonObject(with: Data(empty.utf8))) as? [String: Any]
        let snap = e.flatMap { Snapshot(response: $0) }
        #expect(snap != nil && snap?.protocolVersion == 22 && snap?.herdrVersion == "0.9.5")
    }

    @Test func oneOutageCountsOnceAndNewPanesDoNotCountAtAll() throws {
        let dir = shortSocketDir()
        let (server, endpoint) = try makeServer(agents: 2, dir: dir)
        let store = HerdrStore(client: HerdrClient(endpoint: endpoint), queue: testQueue)
        store.backoffInitial = 0.1; store.backoffMax = 0.2; store.pingInterval = 5
        store.start()
        defer { store.stop() }
        #expect(waitUntil { store.link == .live })
        server.stop()
        #expect(waitUntil { if case .reconnecting = store.link { return true } else { return false } })
        Thread.sleep(forTimeInterval: 1.0)          // several failed retries inside one outage
        let (server2, _) = try makeServer(agents: 3, dir: dir)   // a different pane set on return
        defer { server2.stop() }
        #expect(waitUntil(8) { store.link == .live && store.snapshot.agents.count == 3 })
        #expect(store.reconnectCount == 1)
    }
}
