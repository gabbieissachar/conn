// What lets the agent bridge answer without sleeping on a timer (S2): a wake for a thread when the Campus event stream says something happened to it, and a watch on the
// session registry's inbox folder. Both only make the bridge quicker: the timers they replace stay as the fallback (a stream that is down, a folder that cannot be watched, an
// event that never came), so a missed wake costs seconds, never an answer.
import Foundation

/// A wake per thread. `awaitRun` notes the thread's count before it reads the status and waits on that count afterwards, so an event that arrives while the status is being read
/// is never missed: the wait returns at once.
@MainActor
public final class BridgeWake {
    private struct Waiter { var continuation: CheckedContinuation<Void, Never>; var timer: Task<Void, Never>? }
    private var counts: [String: Int] = [:]
    private var waiters: [String: [UUID: Waiter]] = [:]
    private var lastWake: [String: Date] = [:]
    private let now: () -> Date

    public init(now: @escaping () -> Date = Date.init) { self.now = now }

    /// The frames that can change what a request waits for: a run starting or ending, a question, a permission request, a step ending (a permission request that raises no
    /// frame of its own shows up in the status after the step before it). Text, reasoning and tool-progress frames come by the hundred and change nothing the bridge reads.
    public static func wakes(on type: String) -> Bool {
        if type.hasSuffix(".delta") || type == "session.tool.progress" { return false }
        if type.hasPrefix("form.") || type.hasPrefix("permission") { return true }
        switch type {
        case "session.idle", "session.execution.started", "session.execution.ended", "session.execution.finished", "session.step.ended",
             "session.interrupted", "session.execution.interrupted", "session.aborted", "session.error", "session.deleted":
            return true
        default: return false
        }
    }

    /// The frames after which the status is read again a moment later if it still says what it said: the end of a run, a question, a permission request. (A step ending wakes the
    /// request once; it does not start a run of quick reads, which a long run would turn into polling faster than the timer it replaces.)
    public static func settles(on type: String) -> Bool {
        type.hasPrefix("form.") || type.hasPrefix("permission") || ["session.idle", "session.execution.ended", "session.execution.finished", "session.interrupted", "session.execution.interrupted", "session.aborted", "session.error"].contains(type)
    }

    public func count(of id: String) -> Int { counts[id] ?? 0 }

    /// Something happened to this thread: whoever waits on it goes and reads.
    public func signal(_ id: String, settle: Bool = true) {
        counts[id, default: 0] += 1
        if settle { lastWake[id] = now() }
        resumeAll(id)
    }

    /// Wake everyone (the switch went off: a waiting request must notice at once).
    public func signalAll() {
        for id in Array(waiters.keys) { counts[id, default: 0] += 1; resumeAll(id) }
    }

    /// Whether an event that ends or interrupts a run came for the thread within the last `seconds`.
    public func recent(_ id: String, within seconds: TimeInterval) -> Bool {
        lastWake[id].map { now().timeIntervalSince($0) < seconds } ?? false
    }

    /// Wait until the thread is signalled after `since`, or `timeout` seconds pass. Returns true when it was woken by an event, false when the time ran out.
    @discardableResult
    public func wait(for id: String, since: Int, timeout: TimeInterval) async -> Bool {
        if count(of: id) != since { return true }
        let token = UUID()
        let nanos = UInt64(max(0.01, timeout) * 1_000_000_000)
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: nanos)
                guard !Task.isCancelled else { return }
                self?.resume(id, token)
            }
            waiters[id, default: [:]][token] = Waiter(continuation: cont, timer: timer)
        }
        return count(of: id) != since
    }

    private func resume(_ id: String, _ token: UUID) {
        guard let w = waiters[id]?.removeValue(forKey: token) else { return }
        if waiters[id]?.isEmpty == true { waiters[id] = nil }
        w.timer?.cancel()
        w.continuation.resume()
    }

    private func resumeAll(_ id: String) {
        let tokens = waiters[id].map { Array($0.keys) } ?? []
        for token in tokens { resume(id, token) }
    }
}

/// A watch on one folder: `onChange` runs (on a queue of its own; the caller hops to the main actor) when an entry is added, renamed or removed in it. A write to a file already there raises nothing, which is
/// why the bridge's records are staged and renamed into the inbox (`fm-ask` does that) and why a record that looks half-written is read again a moment later.
public final class BridgeFolderWatch: @unchecked Sendable {
    private var source: DispatchSourceFileSystemObject?
    private let lock = NSLock()
    private var lost = false

    /// nil when the folder cannot be opened for watching.
    public init?(directory: URL, onChange: @escaping @Sendable () -> Void) {
        let fd = open(directory.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .delete, .rename, .revoke], queue: DispatchQueue(label: "conn.bridge.inbox-watch"))
        src.setEventHandler { [weak self] in
            if let self = self, let src = self.source, src.data.contains(.delete) || src.data.contains(.rename) || src.data.contains(.revoke) { self.markLost() }
            onChange()
        }
        src.setCancelHandler { close(fd) }
        source = src
        src.resume()
    }

    private func markLost() { lock.lock(); lost = true; lock.unlock() }

    /// The folder was removed or moved under the watch: it watches nothing now and must be made again.
    public var isLost: Bool { lock.lock(); defer { lock.unlock() }; return lost }

    public func stop() { source?.cancel(); source = nil }
    deinit { source?.cancel() }
}
