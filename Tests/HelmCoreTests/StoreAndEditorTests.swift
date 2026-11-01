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

    @Test func saveAsCreatesTheFileAndKeepsTheDocumentOpen() throws {
        let doc = TextFile(text: "draft")
        #expect(throws: TextFileError.noPath) { try doc.save() }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("helm-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try doc.saveAs(dir.appendingPathComponent("new.md"))
        #expect(doc.title == "new.md" && !doc.isDirty && doc.isMarkdown)
    }
}
