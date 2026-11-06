import Testing
import Foundation
import ConnCore

/// A sidebar click becomes keys typed into the embedded Herdr client: the key map read from the client's config, the plan
/// worked out from a snapshot, and the runner that types each stage and checks Herdr's focus pointer.
@Suite("Herdr client keys") struct HerdrClientKeymapTests {
    @Test func noConfigMeansHerdrsDefaultKeys() throws {
        let d = HerdrClientKeymap.defaults
        #expect(d.prefix == [0x02] && d.workspacePicker == Array("w".utf8) && d.nextTab == Array("n".utf8) && d.navigateDown == [0x1b, 0x5b, 0x42])
        #expect(try HerdrClientKeymap.parse(config: nil) == d)
        #expect(try HerdrClientKeymap.parse(config: "") == d)
        #expect(try HerdrClientKeymap.parse(config: "onboarding = false\n[ui]\nsidebar_width = 30\n") == d)
    }

    @Test func theConfigsOwnPrefixAndKeysAreUsed() throws {
        let m = try HerdrClientKeymap.parse(config: """
        [keys]
        prefix = "ctrl+a"        # not the default
        workspace_picker = "prefix+g"
        next_tab = "prefix+shift+n"
        navigate_workspace_down = "j"
        """)
        #expect(m.prefix == [0x01] && m.workspacePicker == Array("g".utf8) && m.nextTab == Array("N".utf8) && m.navigateDown == Array("j".utf8))
    }

    @Test func aListOfBindingsUsesTheFirstPrefixFormItCanType() throws {
        let m = try HerdrClientKeymap.parse(config: "[keys]\nnext_tab = [\"ctrl+alt+]\", \"prefix+t\", \"prefix+n\"]\nworkspace_picker = [\n  \"prefix+w\",\n]\n")
        #expect(m.nextTab == Array("t".utf8) && m.workspacePicker == Array("w".utf8))
    }

    @Test func onlyTheKeysTableIsRead() throws {
        let m = try HerdrClientKeymap.parse(config: """
        [ui]
        prefix = "ctrl+x"
        next_tab = "prefix+q"
        [keys.indexed]
        tabs = "ctrl"
        [[keys.command]]
        key = "prefix+w"
        type = "popup"
        [keys]
        prefix = "f12"
        """)
        #expect(m.prefix == Array("\u{1b}[24~".utf8))
        #expect(m.nextTab == Array("n".utf8))
    }

    @Test func aBindingItCannotTypeIsReportedNotGuessed() {
        func failing(_ line: String) -> HerdrClientKeymap.Failure? {
            do { _ = try HerdrClientKeymap.parse(config: "[keys]\n" + line + "\n"); return nil } catch { return error as? HerdrClientKeymap.Failure }
        }
        #expect(failing("workspace_picker = \"ctrl+alt+w\"") == .unsupported(action: "workspace_picker", binding: "ctrl+alt+w"))
        #expect(failing("next_tab = \"cmd+n\"") == .unsupported(action: "next_tab", binding: "cmd+n"))
        #expect(failing("prefix = \"alt+x\"") == .unsupported(action: "prefix", binding: "alt+x"))
        #expect(failing("prefix = \"esc\"") == .unsupported(action: "prefix", binding: "esc"))
        #expect(failing("switch_tab = \"prefix+alt+1..9\"") == .unsupported(action: "switch_tab", binding: "prefix+alt+1..9"))
        #expect(failing("navigate_workspace_down = \"prefix+j\"") == .unsupported(action: "navigate_workspace_down", binding: "prefix+j"))
        #expect(failing("switch_tab = \"prefix+1..9\"") == nil)
    }

    @Test func theKeyMapIsReadFromTheFileTheClientRunsWith() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-keymap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("client.toml")
        try "[keys]\nprefix = \"ctrl+a\"\n".write(to: file, atomically: true, encoding: .utf8)
        #expect(try HerdrClientKeymap.load(configPath: file).prefix == [0x01])
        // A client that reads Herdr's own config: its path, else the default folder; no file there means the defaults.
        let own = dir.appendingPathComponent("own.toml")
        try "[keys]\nprefix = \"ctrl+t\"\n".write(to: own, atomically: true, encoding: .utf8)
        #expect(try HerdrClientKeymap.load(configPath: nil, home: dir.path, environment: ["HERDR_CONFIG_PATH": own.path]).prefix == [0x14])
        #expect(try HerdrClientKeymap.load(configPath: nil, home: dir.path, environment: [:]) == .defaults)
        #expect(try HerdrClientKeymap.load(configPath: dir.appendingPathComponent("missing.toml")) == .defaults)
    }
}

@Suite("Herdr client navigation plan") struct HerdrClientNavigationPlanTests {
    typealias Nav = HerdrClientNavigation
    let ctrlB: [UInt8] = [0x02]
    func b(_ s: String) -> [UInt8] { Array(s.utf8) }
    let down: [UInt8] = [0x1b, 0x5b, 0x42]

    /// `n` workspaces numbered 1...n with ids w1...w9, wA, wB... (Herdr's ids are hexadecimal), each with the given tab count.
    func snapshot(workspaces n: Int, tabs: [Int: Int] = [:]) -> Snapshot {
        var s = Snapshot()
        for i in 1...n {
            let id = "w" + String(i, radix: 16, uppercase: true)
            let count = tabs[i] ?? 1
            s.workspaces.append(Workspace(id: id, label: "WS\(i)", number: i, state: .idle, tabCount: count, paneCount: count))
            for t in 1...count {
                s.tabs.append(HerdrTab(id: "\(id):t" + String(t, radix: 16, uppercase: true), workspaceID: id, label: "\(t)", number: t, state: .idle, paneCount: 1))
            }
        }
        return s
    }

    func plan(_ target: Nav.Target, _ s: Snapshot, _ keys: HerdrClientKeymap = .defaults) throws -> [Nav.Stage] {
        try Nav.plan(to: target, in: s, keymap: keys)
    }

    @Test func workspacesOneToNineAreOneSequenceEach() throws {
        let s = snapshot(workspaces: 12)
        #expect(try plan(.workspace("w1"), s) == [Nav.Stage(chunks: [ctrlB + b("w1")], expect: .workspace("w1"))])
        #expect(try plan(.workspace("w5"), s) == [Nav.Stage(chunks: [ctrlB + b("w5")], expect: .workspace("w5"))])
        #expect(try plan(.workspace("w9"), s) == [Nav.Stage(chunks: [ctrlB + b("w9")], expect: .workspace("w9"))])
    }

    @Test func pastNineItGoesToNineThenDownInTheListAndTakesIt() throws {
        let s = snapshot(workspaces: 12)
        #expect(try plan(.workspace("wA"), s) == [Nav.Stage(chunks: [ctrlB + b("w9")], expect: .workspace("w9")),
                                                  Nav.Stage(chunks: [ctrlB + b("w"), down, [0x0d]], expect: .workspace("wA"))])
        #expect(try plan(.workspace("wC"), s)[1] == Nav.Stage(chunks: [ctrlB + b("w"), down + down + down, [0x0d]], expect: .workspace("wC")))
    }

    @Test func positionIsTheWorkspacesNumberNotItsPlaceInTheReply() throws {
        var s = snapshot(workspaces: 3)
        s.workspaces.reverse()
        #expect(try plan(.workspace("w1"), s)[0].chunks == [ctrlB + b("w1")])
        #expect(try plan(.workspace("w3"), s)[0].chunks == [ctrlB + b("w3")])
        // A closed workspace leaves a gap in the ids but not in the positions: the third workspace is key 3.
        var gap = snapshot(workspaces: 4)
        gap.workspaces.remove(at: 1)
        gap.workspaces = gap.workspaces.enumerated().map { var w = $0.element; w.number = $0.offset + 1; return w }
        #expect(try plan(.workspace("w4"), gap)[0].chunks == [ctrlB + b("w3")])
    }

    @Test func aTabMovesToItsWorkspaceThenToTheTab() throws {
        let s = snapshot(workspaces: 3, tabs: [2: 4])
        #expect(try plan(.tab("w2:t3"), s) == [Nav.Stage(chunks: [ctrlB + b("w2")], expect: .workspace("w2")),
                                              Nav.Stage(chunks: [ctrlB + b("3")], expect: .tab("w2:t3"))])
        // Tab 1 of another workspace still goes through that workspace.
        #expect(try plan(.tab("w3:t1"), s) == [Nav.Stage(chunks: [ctrlB + b("w3")], expect: .workspace("w3")),
                                              Nav.Stage(chunks: [ctrlB + b("1")], expect: .tab("w3:t1"))])
    }

    @Test func tabsPastNineGoToNineThenStepOn() throws {
        let s = snapshot(workspaces: 3, tabs: [3: 12])
        let stages = try plan(.tab("w3:tB"), s)           // the 11th tab of the 3rd workspace
        #expect(stages == [Nav.Stage(chunks: [ctrlB + b("w3")], expect: .workspace("w3")),
                           Nav.Stage(chunks: [ctrlB + b("9")], expect: .tab("w3:t9")),
                           Nav.Stage(chunks: [ctrlB + b("n"), ctrlB + b("n")], expect: .tab("w3:tB"))])
        #expect(try plan(.tab("w3:t9"), s).last == Nav.Stage(chunks: [ctrlB + b("9")], expect: .tab("w3:t9")))
        #expect(try plan(.tab("w3:tA"), s).last?.chunks == [ctrlB + b("n")])
    }

    @Test func aTabInAWorkspacePastNineUsesBothRoutes() throws {
        let s = snapshot(workspaces: 11, tabs: [11: 10])
        let stages = try plan(.tab("wB:tA"), s)
        #expect(stages.map(\.expect) == [.workspace("w9"), .workspace("wB"), .tab("wB:t9"), .tab("wB:tA")])
    }

    @Test func tabNumbersCountWithinTheirOwnWorkspaceOnly() throws {
        var s = snapshot(workspaces: 2, tabs: [1: 3, 2: 3])
        s.tabs.reverse()
        #expect(try plan(.tab("w2:t2"), s).last?.chunks == [ctrlB + b("2")])
    }

    @Test func theClientsOwnKeysAreUsed() throws {
        let keys = HerdrClientKeymap(prefix: [0x01], workspacePicker: b("g"), navigateDown: b("j"), nextTab: b("t"))
        let s = snapshot(workspaces: 10, tabs: [10: 10])
        #expect(try plan(.workspace("wA"), s, keys) == [Nav.Stage(chunks: [[0x01] + b("g9")], expect: .workspace("w9")),
                                                       Nav.Stage(chunks: [[0x01] + b("g"), b("j"), [0x0d]], expect: .workspace("wA"))])
        #expect(try plan(.tab("wA:tA"), s, keys).last?.chunks == [[0x01] + b("t")])
    }

    @Test func aTargetHerdrDoesNotListIsRefused() {
        let s = snapshot(workspaces: 2)
        #expect(throws: Nav.PlanFailure.unknownWorkspace("w7")) { try plan(.workspace("w7"), s) }
        #expect(throws: Nav.PlanFailure.unknownTab("w1:t9")) { try plan(.tab("w1:t9"), s) }
    }

    @Test func theSnapshotCarriesTheFocusPointer() throws {
        let line = #"{"id":"x","result":{"type":"session_snapshot","snapshot":{"panes":[],"focused_pane_id":"w3:p4","focused_tab_id":"w3:t4","focused_workspace_id":"w3"}}}"#
        let obj = try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        let s = try #require(Snapshot(response: obj))
        #expect(s.focusedWorkspaceID == "w3" && s.focusedTabID == "w3:t4")
    }
}

/// Stands in for the client's pty and for Herdr's focus pointer.
final class NavigationStub: @unchecked Sendable {
    private let lock = NSLock()
    private var _sent: [[UInt8]] = []
    private var _focus = HerdrClientNavigator.Focus(workspaceID: "w1", tabID: "w1:t1")
    /// Called after each chunk is typed; may move the pointer, as Herdr does when the keys work.
    var onSend: (@Sendable ([UInt8], NavigationStub) -> Void)?
    var sent: [[UInt8]] { lock.lock(); defer { lock.unlock() }; return _sent }
    var focus: HerdrClientNavigator.Focus { get { lock.lock(); defer { lock.unlock() }; return _focus } set { lock.lock(); _focus = newValue; lock.unlock() } }

    private func record(_ bytes: [UInt8]) { lock.lock(); _sent.append(bytes); lock.unlock() }

    func navigator() -> HerdrClientNavigator {
        let n = HerdrClientNavigator(send: { [self] bytes in
            record(bytes)
            onSend?(bytes, self)
        }, readFocus: { [self] in focus })
        n.confirmTimeout = 0.4; n.pollInterval = 0.01; n.chunkPause = 0.001
        return n
    }
}

@Suite("Herdr client navigation runner") struct HerdrClientNavigatorTests {
    typealias Nav = HerdrClientNavigation
    let stages = [Nav.Stage(chunks: [[0x02, 0x77, 0x39]], expect: .workspace("w9")),
                  Nav.Stage(chunks: [[0x02, 0x77], [0x1b, 0x5b, 0x42], [0x0d]], expect: .workspace("wA"))]

    @Test func everyStageIsTypedInOrderAndConfirmedBeforeTheNext() async {
        let stub = NavigationStub()
        stub.onSend = { bytes, s in
            if bytes == [0x02, 0x77, 0x39] { s.focus = .init(workspaceID: "w9", tabID: "w9:t1") }
            if bytes == [0x0d] { s.focus = .init(workspaceID: "wA", tabID: "wA:t1") }
        }
        let outcome = await stub.navigator().run(stages)
        #expect(outcome == .landed)
        #expect(stub.sent == [[0x02, 0x77, 0x39], [0x02, 0x77], [0x1b, 0x5b, 0x42], [0x0d]])
    }

    @Test func aStageHerdrDoesNotConfirmStopsTheRestAndSaysWhere() async {
        let stub = NavigationStub()      // the keys do nothing: the pointer never moves
        let outcome = await stub.navigator().run(stages)
        guard case .failed(let stage, let of, let reason) = outcome else { Issue.record("expected a failure, got \(outcome)"); return }
        #expect(stage == 1 && of == 2)
        #expect(reason.contains("w1") && reason.contains("w1:t1"))
        #expect(stub.sent == [[0x02, 0x77, 0x39]])       // the second stage was never typed
    }

    @Test func aFocusPointerThatCannotBeReadIsAFailureNotASuccess() async {
        let n = HerdrClientNavigator(send: { _ in }, readFocus: { nil })
        n.confirmTimeout = 0.1; n.pollInterval = 0.01; n.chunkPause = 0.001
        let outcome = await n.run(stages)
        #expect(outcome == .failed(stage: 1, of: 2, reason: "Herdr's position could not be read"))
    }

    @Test func aTabStageIsConfirmedByTheTabNotTheWorkspace() async {
        let stub = NavigationStub()
        stub.onSend = { bytes, s in if bytes == [0x02, 0x33] { s.focus = .init(workspaceID: "w1", tabID: "w1:t3") } }
        let outcome = await stub.navigator().run([Nav.Stage(chunks: [[0x02, 0x33]], expect: .tab("w1:t3"))])
        #expect(outcome == .landed)
        let wrong = NavigationStub()
        wrong.onSend = { bytes, s in s.focus = .init(workspaceID: "w1", tabID: "w1:t2") }
        let miss = await wrong.navigator().run([Nav.Stage(chunks: [[0x02, 0x33]], expect: .tab("w1:t3"))])
        #expect(miss != .landed)
    }

    @Test func aCancelledRunTypesNoFurtherStage() async {
        let stub = NavigationStub()      // the pointer never moves, so the first stage waits for its confirmation
        let navigator = stub.navigator()
        navigator.confirmTimeout = 5
        let task = Task { await navigator.run(stages) }
        while stub.sent.isEmpty { try? await Task.sleep(nanoseconds: 5_000_000) }
        task.cancel()
        let outcome = await task.value
        guard case .failed(let stage, _, let reason) = outcome else { Issue.record("expected a failure"); return }
        #expect(stage == 1 && reason == "cancelled")
        #expect(stub.sent == [[0x02, 0x77, 0x39]])
    }
}

@Suite("Herdr client sidebar follow") struct HerdrClientFocusFollowerTests {
    @Test func aNewClientAdoptsWhereHerdrIs() {
        var f = HerdrClientFocusFollower()
        let at = f.observe(workspace: "w3", tab: "w3:t2", adopt: true, settled: true, userActive: false)
        #expect(at?.workspace == "w3" && at?.tab == "w3:t2")
    }

    @Test func aChangeIsFollowedOnlyRightAfterThePersonUsedTheClient() {
        var f = HerdrClientFocusFollower()
        _ = f.observe(workspace: "w1", tab: "w1:t1", adopt: true, settled: true, userActive: false)
        // Another screen moved the pointer while the person was not typing here: left alone.
        #expect(f.observe(workspace: "w2", tab: "w2:t1", settled: true, userActive: false) == nil)
        // They type here later with the pointer unchanged: the old change from the other screen is not applied then.
        #expect(f.observe(workspace: "w2", tab: "w2:t1", settled: true, userActive: true) == nil)
        // A new change right after they typed here is theirs.
        let at = f.observe(workspace: "w2", tab: "w2:t4", settled: true, userActive: true)
        #expect(at?.workspace == "w2" && at?.tab == "w2:t4")
    }

    @Test func theSidebarsOwnSequenceIsNotTakenForTheClientsMoves() {
        var f = HerdrClientFocusFollower()
        _ = f.observe(workspace: "w1", tab: "w1:t1", adopt: true, settled: true, userActive: false)
        // While a sidebar click is moving the pointer through w9 on the way to wA, the person's earlier typing counts for nothing.
        #expect(f.observe(workspace: "w9", tab: "w9:t1", settled: false, userActive: true) == nil)
        #expect(f.observe(workspace: "wA", tab: "wA:t1", settled: false, userActive: true) == nil)
        #expect(f.observe(workspace: "wA", tab: "wA:t1", settled: true, userActive: true) == nil)
    }

    @Test func noPositionAndNoChangeAreNothingToFollow() {
        var f = HerdrClientFocusFollower()
        #expect(f.observe(workspace: nil, tab: "w1:t1", settled: true, userActive: true) == nil)
        _ = f.observe(workspace: "w1", tab: "w1:t1", adopt: true, settled: true, userActive: true)
        #expect(f.observe(workspace: "w1", tab: "w1:t1", settled: true, userActive: true) == nil)
        f.reset()
        #expect(f.observe(workspace: "w1", tab: "w1:t1", settled: true, userActive: true) != nil)
    }
}
