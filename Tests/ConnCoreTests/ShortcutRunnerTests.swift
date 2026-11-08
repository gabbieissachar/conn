// The shortcut runner: it starts only the stub script these tests write (never the real /usr/bin/shortcuts), runs only the two fixed names, and always comes back.
import Testing
import Foundation
import ConnCore

private func scratchDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("conn-shortcut-test-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

/// A stand-in `shortcuts`: `body` is the shell code for it, `$LOG` is a file it may append to.
private func stub(_ body: String) -> (url: URL, log: URL) {
    let dir = scratchDir()
    let log = dir.appendingPathComponent("calls.log")
    let script = dir.appendingPathComponent("shortcuts")
    try? "#!/bin/sh\nLOG=\"\(log.path)\"\n\(body)\n".write(to: script, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return (script, log)
}

private func lines(_ url: URL) -> [String] { ((try? String(contentsOf: url, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init) }

@Suite("Shortcut runner") struct ShortcutRunnerTests {
    @Test func onAndOffRunExactlyTheTwoFixedNames() {
        let s = stub(#"echo "$@" >> "$LOG"; exit 0"#)
        let r = ShortcutRunner(executable: s.url)
        #expect(r.setBlocking(on: true) == .done && r.setBlocking(on: false) == .done)
        #expect(lines(s.log) == ["run Conn Focus On", "run Conn Focus Off"])
        #expect(FocusShortcut.allCases.map(\.rawValue) == ["Conn Focus On", "Conn Focus Off"])
    }

    @Test func theAsyncCallRunsTheSameThing() async {
        let s = stub(#"echo "$@" >> "$LOG"; exit 0"#)
        let r = ShortcutRunner(executable: s.url)
        #expect(await r.set(on: true) == .done)
        #expect(lines(s.log) == ["run Conn Focus On"])
    }

    @Test func aFailureReportsTheFirstLineItSaid() {
        let s = stub(#"echo "Error: Couldn't find shortcut 'Conn Focus On'" >&2; echo "second line"; exit 1"#)
        let r = ShortcutRunner(executable: s.url).setBlocking(on: true)
        #expect(r == .failed("Error: Couldn't find shortcut 'Conn Focus On'"))
        #expect(r.problem == "the shortcut said: Error: Couldn't find shortcut 'Conn Focus On'" && !r.isDone)
    }

    @Test func aShortcutThatNeverFinishesIsEndedAtTheTimeOut() throws {
        let s = stub(#"echo $$ >> "$LOG"; sleep 30"#)
        let start = Date()
        var runner = ShortcutRunner(executable: s.url)
        runner.runTimeout = 2; runner.quitTimeout = 2
        #expect(runner.setBlocking(on: true) == .timedOut)
        #expect(Date().timeIntervalSince(start) < 8)
        // the child was ended, not left running
        let pid = try #require(lines(s.log).first.flatMap { Int32($0) })
        #expect(kill(pid, 0) != 0)
        #expect(ShortcutRunner(executable: s.url).execute(["x"], timeout: 0.3).timedOut)
    }

    @Test func aMissingProgramIsReportedNotThrown() {
        let r = ShortcutRunner(executable: URL(fileURLWithPath: "/nonexistent/conn-test/shortcuts"))
        if case .unavailable = r.setBlocking(on: true) {} else { Issue.record("expected .unavailable") }
        if case .unavailable = r.checkSetupBlocking() {} else { Issue.record("expected .unavailable") }
    }

    @Test func checkSetupListsAndRunsNothing() {
        let s = stub(#"echo "$@" >> "$LOG"; if [ "$1" = list ]; then printf 'Morning\nConn Focus On\nConn Focus Off\n'; fi"#)
        #expect(ShortcutRunner(executable: s.url).checkSetupBlocking() == .ready)
        #expect(lines(s.log) == ["list"])          // only a listing: no `run`
    }

    @Test func checkSetupNamesWhatIsMissing() {
        let one = stub(#"printf 'Conn Focus On\nOther\n'"#)
        #expect(ShortcutRunner(executable: one.url).checkSetupBlocking() == .missing([.off]))
        let none = stub(#"printf 'Other\n'"#)
        #expect(ShortcutRunner(executable: none.url).checkSetupBlocking() == .missing([.on, .off]))
        // a near name is not the name
        #expect(ShortcutRunner.setupStatus(listing: "Conn Focus On (old)\nConn Focus Off \n") == .missing([.on]))
        #expect(ShortcutRunner.setupStatus(listing: "  Conn Focus On\r\nConn Focus Off\n") == .ready)
    }

    @Test func aListingThatFailsIsUnavailableNotMissing() {
        let s = stub("exit 3")
        if case .unavailable(let why) = ShortcutRunner(executable: s.url).checkSetupBlocking() { #expect(why.contains("3")) } else { Issue.record("expected .unavailable") }
    }

    @Test func aHugeOutputDoesNotHangTheCall() {
        let s = stub(#"i=0; while [ $i -lt 4000 ]; do echo "line number $i with some padding to make it long enough to fill a pipe buffer quickly"; i=$((i+1)); done"#)
        let r = ShortcutRunner(executable: s.url).execute(["list"], timeout: 8)
        #expect(!r.timedOut && r.status == 0 && r.output.count <= 64 * 1024 + 8192)
    }

    @Test func aGrandchildHoldingThePipeDoesNotHoldTheCallUp() {
        let s = stub("sleep 20 &\nexit 0")
        let start = Date()
        #expect(ShortcutRunner(executable: s.url).execute(["run", "Conn Focus On"], timeout: 5).status == 0)
        #expect(Date().timeIntervalSince(start) < 4)
    }
}
