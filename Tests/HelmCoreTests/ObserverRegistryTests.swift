import Testing
import Foundation
import Darwin
@testable import HelmCore

/// Real processes, no mocks: an orphaned observer is a child whose command line is an observer's and whose parent is
/// gone (adopted by launchd, ppid 1), which is what `kill -9` of the app leaves behind. Every test names its own receipt
/// directory, so nothing here reads or writes the real one or a shared environment variable.
private enum Procs {
    static func scratchDirectory() -> URL {
        let u = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("helm-registry-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    /// An observer-looking process with no parent. The outer shell starts the inner one in the background, prints its pid
    /// and exits; launchd adopts the inner one. `sleep 30; true` keeps the shell itself running (a lone `sh -c 'sleep 30'`
    /// would exec `sleep` and lose the observer words from its command line).
    static func orphanObserver(ignoringSigterm: Bool = false) throws -> Int32 {
        // The shell touches a marker once it is running its body, so a test never signals it while it is still starting up
        // (before `trap` has run, SIGTERM would still kill it).
        let marker = NSTemporaryDirectory() + "helm-orphan-ready-\(UUID().uuidString.prefix(8))"
        let body = (ignoringSigterm ? "trap '' TERM; " : "") + ": > \(marker); sleep 30; true"
        let script = "/bin/sh -c \"\(body)\" sh --session esim terminal session observe w1:p1 --cols 66 --rows 59 >/dev/null 2>&1 </dev/null & echo $!"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard let pid = Int32(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) else { throw CocoaError(.fileReadCorruptFile) }
        guard waitUntil(3, { ProcessProbe.info(pid)?.ppid == 1 && FileManager.default.fileExists(atPath: marker) }) else { throw CocoaError(.fileReadUnknown) }
        return pid
    }

    /// An observer-looking child that still has its parent (this process).
    static func childObserver() throws -> Process {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 30; true", "sh", "--session", "esim", "terminal", "session", "observe", "w1:p1", "--cols", "66", "--rows", "59"]
        try p.run()
        return p
    }

    /// A running process standing for another app instance, with its identity.
    static func runningInstance() throws -> (Process, ProcessStamp) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sleep")
        p.arguments = ["30"]
        try p.run()
        guard let i = ProcessProbe.info(p.processIdentifier) else { throw CocoaError(.fileReadUnknown) }
        return (p, ProcessStamp(pid: p.processIdentifier, startedAtMicros: i.startedAtMicros))
    }

    /// The identity of an instance that no longer exists.
    static func deadInstance() throws -> ProcessStamp {
        let (p, stamp) = try runningInstance()
        p.terminate()
        p.waitUntilExit()
        return stamp
    }

    static func receipt(for pid: Int32, owner: ProcessStamp, startedAt: Int64? = nil) throws -> ObserverReceipt {
        guard let i = ProcessProbe.info(pid) else { throw CocoaError(.fileReadUnknown) }
        return ObserverReceipt(pid: pid, startedAtMicros: startedAt ?? i.startedAtMicros, ownerPid: owner.pid, ownerStartedAtMicros: owner.startedAtMicros)
    }

    static func write(_ r: ObserverReceipt, in dir: URL) throws {
        try JSONEncoder().encode(r).write(to: dir.appendingPathComponent("\(r.pid).json"))
    }

    static func exists(_ pid: Int32, in dir: URL) -> Bool { FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(pid).json").path) }
}

@Suite("Observer registry") struct ObserverRegistryTests {
    @Test func recognisesOnlyItsOwnCommandLine() {
        #expect(ObserverRegistry.looksLikeOurObserver(" /Users/x/.local/bin/herdr --session esim terminal session observe w1:p3 --cols 66 --rows 59"))
        #expect(!ObserverRegistry.looksLikeOurObserver(" /bin/sleep 30"))
        #expect(!ObserverRegistry.looksLikeOurObserver(" herdr session attach esim"))
    }

    @Test func aReceiptNamesTheChildAndItsOwnerAndOnlyTheOwnerForgetsIt() throws {
        let dir = Procs.scratchDirectory()
        let (child, _) = try Procs.runningInstance()
        defer { child.terminate() }
        let a = ObserverRegistry(directory: dir, owner: .current)
        let other = try Procs.runningInstance()
        defer { other.0.terminate() }
        let b = ObserverRegistry(directory: dir, owner: other.1)
        a.record(child.processIdentifier)
        let r = try #require(a.receipts().first)
        #expect(a.receipts().count == 1)
        #expect(r.pid == child.processIdentifier)
        #expect(r.startedAtMicros == ProcessProbe.info(child.processIdentifier)?.startedAtMicros)
        #expect(r.ownerPid == getpid() && r.ownerStartedAtMicros == ProcessStamp.current.startedAtMicros)
        b.forget(child.processIdentifier)                 // another instance cannot drop it
        #expect(Procs.exists(child.processIdentifier, in: dir))
        a.forget(child.processIdentifier)
        #expect(!Procs.exists(child.processIdentifier, in: dir))
    }

    @Test func twoInstancesRecordingAtOnceLoseNothing() throws {
        // The single shared file of the first version was read, changed and rewritten whole, so one instance's launch could
        // erase a child the other had just recorded. One file per child cannot.
        let dir = Procs.scratchDirectory()
        let (otherProcess, otherStamp) = try Procs.runningInstance()
        defer { otherProcess.terminate() }
        let mine = ObserverRegistry(directory: dir, owner: .current), theirs = ObserverRegistry(directory: dir, owner: otherStamp)
        var children: [Process] = []
        for _ in 0..<16 { let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sleep"); p.arguments = ["30"]; try p.run(); children.append(p) }
        defer { children.forEach { $0.terminate() } }
        let pids = children.map(\.processIdentifier)
        DispatchQueue.concurrentPerform(iterations: pids.count) { i in (i % 2 == 0 ? mine : theirs).record(pids[i]) }
        let all = mine.receipts()
        #expect(all.count == 16)
        #expect(all.filter { $0.ownerPid == getpid() }.count == 8)
        #expect(all.filter { $0.ownerPid == otherStamp.pid }.count == 8)
    }

    @Test func aRunningInstancesOrphanLookingChildIsNeverReaped() throws {
        let dir = Procs.scratchDirectory()
        let orphan = try Procs.orphanObserver()
        defer { kill(orphan, SIGKILL) }
        let (other, otherStamp) = try Procs.runningInstance()
        defer { other.terminate() }
        try Procs.write(Procs.receipt(for: orphan, owner: otherStamp), in: dir)
        // This registry plays the instance that just launched; the receipt belongs to another instance that is still running.
        let report = ObserverRegistry(directory: dir, owner: .current).reapOrphans(grace: 0.3)
        #expect(report.reaped.isEmpty && report.keptForLiveOwner == 1)
        #expect(ProcessProbe.isAlive(orphan))
        #expect(Procs.exists(orphan, in: dir))
    }

    @Test func onlyTheDeadInstancesOrphanIsEndedAndOnlyItsReceiptGoes() throws {
        let dir = Procs.scratchDirectory()
        let dead = try Procs.deadInstance()
        let (live, liveStamp) = try Procs.runningInstance()
        defer { live.terminate() }
        let deadOwnersChild = try Procs.orphanObserver(), liveOwnersChild = try Procs.orphanObserver()
        defer { kill(deadOwnersChild, SIGKILL); kill(liveOwnersChild, SIGKILL) }
        try Procs.write(Procs.receipt(for: deadOwnersChild, owner: dead), in: dir)
        try Procs.write(Procs.receipt(for: liveOwnersChild, owner: liveStamp), in: dir)
        let report = ObserverRegistry(directory: dir, owner: .current).reapOrphans()
        #expect(report.reaped == [deadOwnersChild])
        #expect(report.killed.isEmpty)                    // an ordinary child ends on SIGTERM
        #expect(waitUntil(2) { !ProcessProbe.isAlive(deadOwnersChild) })
        #expect(!Procs.exists(deadOwnersChild, in: dir))
        #expect(ProcessProbe.isAlive(liveOwnersChild))
        #expect(Procs.exists(liveOwnersChild, in: dir))
    }

    @Test func aChildThatIgnoresSigtermIsKilledAfterTheGracePeriod() throws {
        let dir = Procs.scratchDirectory()
        let orphan = try Procs.orphanObserver(ignoringSigterm: true)
        defer { kill(orphan, SIGKILL) }
        try Procs.write(Procs.receipt(for: orphan, owner: Procs.deadInstance()), in: dir)
        let t0 = Date()
        let report = ObserverRegistry(directory: dir, owner: .current).reapOrphans(grace: 0.4)
        #expect(report.terminated.isEmpty && report.killed == [orphan])
        #expect(Date().timeIntervalSince(t0) >= 0.4)      // it was given the whole grace period first
        #expect(!ProcessProbe.isAlive(orphan))
        #expect(!Procs.exists(orphan, in: dir))
    }

    @Test func aReusedPidIsNeverSignalled() throws {
        let dir = Procs.scratchDirectory()
        let dead = try Procs.deadInstance()
        // (a) The pid is alive and looks like an observer, but it started at another time than the receipt says: a
        // different process that inherited the number.
        let lookalike = try Procs.orphanObserver()
        defer { kill(lookalike, SIGKILL) }
        try Procs.write(Procs.receipt(for: lookalike, owner: dead, startedAt: 1), in: dir)
        // (b) Same start time but not our command line (a stale receipt for some other program).
        let (stranger, _) = try Procs.runningInstance()
        defer { stranger.terminate() }
        try Procs.write(Procs.receipt(for: stranger.processIdentifier, owner: dead), in: dir)
        let report = ObserverRegistry(directory: dir, owner: .current).reapOrphans(grace: 0.3)
        #expect(report.reaped.isEmpty && report.discarded == 2)
        #expect(ProcessProbe.isAlive(lookalike))
        #expect(ProcessProbe.isAlive(stranger.processIdentifier))
        #expect(!Procs.exists(lookalike, in: dir) && !Procs.exists(stranger.processIdentifier, in: dir))
    }

    @Test func aChildOfADeadOwnerThatStillHasAParentIsLeftAlone() throws {
        let dir = Procs.scratchDirectory()
        let child = try Procs.childObserver()
        defer { child.terminate() }
        try Procs.write(Procs.receipt(for: child.processIdentifier, owner: Procs.deadInstance()), in: dir)
        let report = ObserverRegistry(directory: dir, owner: .current).reapOrphans(grace: 0.3)
        #expect(report.reaped.isEmpty && report.keptNotOrphan == 1)
        #expect(child.isRunning)
        #expect(Procs.exists(child.processIdentifier, in: dir))
    }

    @Test func anOwnerWhosePidWasReusedCountsAsGone() throws {
        let dir = Procs.scratchDirectory()
        let orphan = try Procs.orphanObserver()
        defer { kill(orphan, SIGKILL) }
        let (live, liveStamp) = try Procs.runningInstance()
        defer { live.terminate() }
        // The receipt names the pid of a process that is running, but it started at another time: not the owner.
        try Procs.write(Procs.receipt(for: orphan, owner: ProcessStamp(pid: liveStamp.pid, startedAtMicros: liveStamp.startedAtMicros - 5_000_000)), in: dir)
        let report = ObserverRegistry(directory: dir, owner: .current).reapOrphans()
        #expect(report.reaped == [orphan])
        #expect(waitUntil(2) { !ProcessProbe.isAlive(orphan) })
    }

    @Test func theFirstVersionsSingleFileListIsReapedByItsOldRule() throws {
        let dir = Procs.scratchDirectory()
        let legacy = dir.appendingPathComponent("observers.json")
        let orphan = try Procs.orphanObserver()
        defer { kill(orphan, SIGKILL) }
        let child = try Procs.childObserver()
        defer { child.terminate() }
        try JSONSerialization.data(withJSONObject: [Int(orphan), Int(child.processIdentifier)]).write(to: legacy)
        let report = ObserverRegistry(directory: dir.appendingPathComponent("observers"), owner: .current, legacyFile: legacy).reapOrphans()
        #expect(report.reaped == [orphan])
        #expect(child.isRunning)                          // still has its parent: not an orphan
        let left = try JSONSerialization.jsonObject(with: Data(contentsOf: legacy)) as? [Int]
        #expect(left == [Int(child.processIdentifier)])
    }
}

@Suite("Process probe") struct ProcessProbeTests {
    @Test func readsParentStartTimeAndArguments() throws {
        let me = try #require(ProcessProbe.info(getpid()))
        #expect(me.ppid == getppid() && !me.isZombie && me.startedAtMicros > 0)
        let p = try Procs.childObserver()
        defer { p.terminate() }
        let args = try #require(ProcessProbe.arguments(p.processIdentifier))
        #expect(args.starts(with: ["/bin/sh", "-c", "sleep 30; true", "sh", "--session", "esim"]))
        #expect(args.last == "59")
        #expect(ProcessProbe.info(p.processIdentifier)?.ppid == getpid())
        #expect(ProcessProbe.info(0) == nil && ProcessProbe.arguments(-1) == nil)
    }
}
