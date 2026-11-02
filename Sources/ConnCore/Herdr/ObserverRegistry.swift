// Receipts for the observer children this app starts, so a crash cannot leave them behind and two running instances
// cannot reap each other's.
//
// `herdr terminal session observe` on an idle pane writes nothing, so it never learns that its parent is gone (no EPIPE).
// If Conn is killed or crashes, such a child lives on. Every child gets its own receipt, `observers/<pid>.json`:
//
//     { pid, startedAtMicros, ownerPid, ownerStartedAtMicros }
//
// (pid and start time together identify a process; a pid alone can be reused). A launching instance reaps a child only
// when ALL of these hold: the owner named in the receipt is gone (no process with that pid and start time), the child is
// still the same process, it has been re-parented to launchd (ppid 1), and its command line is still the one this app
// builds. It ends the child with SIGTERM, waits about a second, then SIGKILL, and deletes only the receipts it handled.
// A child of a running instance is never touched, and no file is rewritten as a whole, so instances cannot lose each
// other's records. Nothing else is ever signalled.
import Foundation
import Darwin

/// A process identity: its pid and the time it started.
public struct ProcessStamp: Codable, Equatable, Sendable {
    public var pid: Int32
    public var startedAtMicros: Int64
    public init(pid: Int32, startedAtMicros: Int64) { self.pid = pid; self.startedAtMicros = startedAtMicros }

    public static let current: ProcessStamp = {
        let c = ProcessProbe.current
        return ProcessStamp(pid: c.pid, startedAtMicros: c.startedAtMicros)
    }()

    public var isAlive: Bool { ProcessProbe.isAlive(pid, startedAtMicros: startedAtMicros) }
}

public struct ObserverReceipt: Codable, Equatable, Sendable {
    public var pid: Int32
    public var startedAtMicros: Int64
    public var ownerPid: Int32
    public var ownerStartedAtMicros: Int64
}

/// What a reap did, so callers and tests can tell the cases apart.
public struct ReapReport: Equatable, Sendable {
    /// Orphans that ended after SIGTERM.
    public var terminated: [Int32] = []
    /// Orphans that ignored SIGTERM for the whole grace period and needed SIGKILL.
    public var killed: [Int32] = []
    /// Receipts whose owner is a running instance: left alone.
    public var keptForLiveOwner = 0
    /// Receipts of a child with a dead owner that still has a parent (not provably an orphan): left alone.
    public var keptNotOrphan = 0
    /// Receipts dropped without signalling anything: the child is gone, its pid was reused, or it is not our command line.
    public var discarded = 0
    public var reaped: [Int32] { terminated + killed }
    public init() {}
}

public struct ObserverRegistry: Sendable {
    public let directory: URL
    public let owner: ProcessStamp
    /// The single-file list an earlier version kept (`observers.json`); read once, by the old rule, when it exists.
    public let legacyFile: URL?

    public init(directory: URL, owner: ProcessStamp = .current, legacyFile: URL? = nil) {
        self.directory = directory
        self.owner = owner
        self.legacyFile = legacyFile
    }

    /// The registry of this app instance. `CONN_STATE_DIR` moves it (tests, the kill checks).
    public static var shared: ObserverRegistry {
        let base: URL
        if let d = ProcessInfo.processInfo.environment["CONN_STATE_DIR"], !d.isEmpty { base = URL(fileURLWithPath: d, isDirectory: true) }
        else { base = ConnMigration.stateDirectory() }
        return ObserverRegistry(directory: base.appendingPathComponent("observers", isDirectory: true), legacyFile: base.appendingPathComponent("observers.json"))
    }

    // MARK: receipts

    private func url(for pid: Int32) -> URL { directory.appendingPathComponent("\(pid).json") }

    /// Remember a child this instance just started. A child that has already exited needs no receipt.
    public func record(_ pid: Int32) {
        guard let info = ProcessProbe.info(pid), !info.isZombie else { return }
        let r = ObserverReceipt(pid: pid, startedAtMicros: info.startedAtMicros, ownerPid: owner.pid, ownerStartedAtMicros: owner.startedAtMicros)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(r) { try? d.write(to: url(for: pid), options: .atomic) }
    }

    /// The child ended or was stopped by this instance: drop its receipt (never another instance's).
    public func forget(_ pid: Int32) {
        let u = url(for: pid)
        if let r = read(u), r.ownerPid != owner.pid || r.ownerStartedAtMicros != owner.startedAtMicros { return }
        try? FileManager.default.removeItem(at: u)
    }

    /// Every readable receipt in the directory.
    public func receipts() -> [ObserverReceipt] { receiptFiles().compactMap { read($0) } }

    private func receiptFiles() -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.range(of: "^[0-9]+\\.json$", options: .regularExpression) != nil }.sorted().map { directory.appendingPathComponent($0) }
    }

    private func read(_ u: URL) -> ObserverReceipt? {
        guard let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(ObserverReceipt.self, from: d)
    }

    private func drop(_ u: URL) { try? FileManager.default.removeItem(at: u) }

    // MARK: reaping

    /// True if `command` is an observer command line as ObserveProcessSource builds it.
    static func looksLikeOurObserver(_ command: String) -> Bool {
        command.contains(" --session ") && command.contains(" terminal session observe ") && command.contains(" --cols ") && command.contains(" --rows ")
    }

    private static func commandLine(_ pid: Int32) -> String? { ProcessProbe.arguments(pid).map { " " + $0.joined(separator: " ") } }

    /// Ends the orphans of dead instances (see the file header for the exact conditions). `grace` is how long a child gets
    /// to exit after SIGTERM before SIGKILL; children are given the time together, not one after another.
    @discardableResult
    public func reapOrphans(grace: TimeInterval = 1.0) -> ReapReport {
        var report = ReapReport()
        var pending: [(pid: Int32, startedAt: Int64, receipt: URL?)] = []

        for u in receiptFiles() {
            guard let r = read(u) else { drop(u); report.discarded += 1; continue }
            if ProcessProbe.isAlive(r.ownerPid, startedAtMicros: r.ownerStartedAtMicros) { report.keptForLiveOwner += 1; continue }
            guard let info = ProcessProbe.info(r.pid), !info.isZombie, info.startedAtMicros == r.startedAtMicros,
                  let command = Self.commandLine(r.pid), Self.looksLikeOurObserver(command) else {
                drop(u); report.discarded += 1; continue        // gone, pid reused, or not our command line: nothing to signal
            }
            guard info.ppid == 1 else { report.keptNotOrphan += 1; continue }
            if kill(r.pid, SIGTERM) == 0 { pending.append((r.pid, r.startedAtMicros, u)) } else { drop(u); report.discarded += 1 }
        }

        // An earlier version's list: the old rule (ours by command line, orphaned by ppid 1); entries that are not
        // provably orphans stay on the list.
        if let legacy = legacyFile, let d = try? Data(contentsOf: legacy), let list = try? JSONSerialization.jsonObject(with: d) as? [Int] {
            var keep: [Int] = []
            for p in list {
                let pid = Int32(truncatingIfNeeded: p)
                guard let info = ProcessProbe.info(pid), !info.isZombie, let command = Self.commandLine(pid), Self.looksLikeOurObserver(command) else { continue }
                if info.ppid == 1 { if kill(pid, SIGTERM) == 0 { pending.append((pid, info.startedAtMicros, nil)) } } else { keep.append(p) }
            }
            if let out = try? JSONSerialization.data(withJSONObject: keep) { try? out.write(to: legacy, options: .atomic) }
        }

        guard !pending.isEmpty else { return report }
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline, pending.contains(where: { ProcessProbe.isAlive($0.pid, startedAtMicros: $0.startedAt) }) { Thread.sleep(forTimeInterval: 0.025) }
        var stubborn: [(pid: Int32, startedAt: Int64)] = []
        for p in pending {
            if ProcessProbe.isAlive(p.pid, startedAtMicros: p.startedAt) {
                if kill(p.pid, SIGKILL) == 0 { report.killed.append(p.pid); stubborn.append((p.pid, p.startedAt)) }
            } else {
                report.terminated.append(p.pid)
            }
            if let u = p.receipt { drop(u) }
        }
        // SIGKILL cannot be ignored, but the exit still takes a moment: do not report before it has happened.
        let killDeadline = Date().addingTimeInterval(0.5)
        while Date() < killDeadline, stubborn.contains(where: { ProcessProbe.isAlive($0.pid, startedAtMicros: $0.startedAt) }) { Thread.sleep(forTimeInterval: 0.01) }
        return report
    }
}
